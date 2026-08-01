/**
 * service-worker.js — the extension's MV3 service worker. Owns configuration,
 * the session lifecycle, content-script ingestion, capture scheduling, vision
 * analysis, insight generation and database sync. Kept alive by port traffic
 * from content scripts plus periodic alarms.
 */
import { DEFAULTS, normalizeConfig, deepMerge, defaultModels } from '../shared/config.js';
import { MSG, ET, MODES } from '../shared/protocol.js';
import { uuid, now, sanitizeUrl, LRUSet } from '../shared/utils.js';
import * as storage from './storage.js';
import * as idb from './idb.js';
import { Session } from './session.js';
import { InsightsEngine } from './insights.js';
import * as capture from './capture.js';
import * as db from './db.js';
import { captureLog, inc, counter, snapshot as logSnapshot } from './telemetry.js';

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------
let config = normalizeConfig(null);
let session = null;
let mode = MODES.MONITOR;
let deviceId = '';
let userId = '';
let started = now();
const ports = new Map(); // tabId -> chrome.runtime.Port
const seenIds = new LRUSet(2000);
const insights = new InsightsEngine({
  configRef: getConfig,
  onInsight: (rec) => emitInsight(rec),
});
let state = {};
let badgeTimer = null;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
function getConfig() {
  config._deviceId = deviceId;
  config._userId = userId || '';
  return config;
}

async function loadConfig() {
  const res = await storage.storageGet([storage.K.CONFIG, storage.K.DEVICE_ID, storage.K.MODE]);
  config = normalizeConfig(res[storage.K.CONFIG]);
  deviceId = res[storage.K.DEVICE_ID] || (await storage.getDeviceId());
  userId = config.identity?.userId || '';
  mode = res[storage.K.MODE] || MODES.MONITOR;
  if (config.enabled === false) mode = MODES.PAUSED;
  refreshState();
  return config;
}

async function saveConfig(partial) {
  config = normalizeConfig(deepMerge(config, partial));
  if (config.identity && config.identity.userId !== userId) userId = config.identity.userId || '';
  await storage.storageSet({ [storage.K.CONFIG]: config });
  await broadcastConfig();
  applyConfigEffects();
  refreshState();
  return config;
}

async function broadcastConfig() {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    try {
      await chrome.tabs.sendMessage(t.id, { type: MSG.CONFIG_UPDATED, config });
    } catch {}
  }
}

function applyConfigEffects() {
  if (config.enabled && mode === MODES.PAUSED) {
    // keep paused state explicit
  }
  if (config.enabled && session) {
    capture.startCaptureLoop(session, getConfig(), onAnalyzeScreenshot);
  } else {
    capture.stopCaptureLoop();
  }
  db.scheduleNext(500);
  updateBadge();
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------
async function startSession() {
  const prev = await storage.storageGet(storage.K.SESSION);
  const prevRec = prev[storage.K.SESSION];
  const nowTs = now();
  if (prevRec && !prevRec.endedAt && nowTs - (prevRec.lastActivityAt || prevRec.startedAt) > 5 * 60 * 1000) {
    await finalizeSession(new Session({ id: prevRec.id, userId, device: config.identity?.device }));
  } else if (prevRec && !prevRec.endedAt && prevRec.id) {
    // resume the persisted session
    session = new Session({ id: prevRec.id, userId, device: config.identity?.device, startedAt: prevRec.startedAt });
    Object.assign(session, prevRec, { id: prevRec.id, userId, startedAt: prevRec.startedAt });
  }
  if (!session) {
    session = new Session({ userId, device: config.identity?.device });
  }
  session.userId = userId;
  const active = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active[0]) session.tabId = active[0].id;
  await storage.persistSession(session);
  captureLog('info', `session ${session.id} (resume=${!!prevRec})`);
  refreshState();
}

async function finalizeSession(s) {
  if (!s) return;
  const rec = s.end();
  await storage.persistSession(s);
  try {
    const summary = await insights.endOfSessionSummary(s);
    if (summary) rec.summaryId = summary.id;
  } catch (e) {
    captureLog('warn', 'end-of-session summary failed: ' + e.message);
  }
  await idb.put('sessions', rec);
  await emitEvent({ id: uuid(), ts: now(), type: ET.SESSION_END, url: '', title: '', data: { sessionId: s.id, durationMs: rec.durationMs, ...rec.eventTypes } }, { skipSession: true });
  captureLog('info', `session ended: ${s.id} (${rec.durationMs}ms)`);
}

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------
async function ingestEvents(batch) {
  if (!batch || !batch.length) return;
  let significant = null;
  for (const ev of batch) {
    if (!ev || !ev.type) continue;
    if (seenIds.has(ev.id)) continue;
    seenIds.add(ev.id);
    if (!config.enabled && ev.type !== ET.PAGE_VIEW) continue;
    await emitEvent(ev);
    if (isSignificant(ev.type)) significant = ev;
  }
  if (significant) {
    capture.captureOnSignificant(session.tabId, session, getConfig(), onAnalyzeScreenshot);
  }
}

function isSignificant(type) {
  return [ET.CLICK, ET.NAVIGATION, ET.ERROR, ET.UNHANDLED_REJECTION, ET.CONSOLE_ERROR, ET.RAGE_CLICK, ET.DEAD_CLICK, ET.FORM_SUBMIT, ET.PAGE_LEAVE].includes(type);
}

async function emitEvent(raw, opts = {}) {
  const ev = {
    id: raw.id || uuid(),
    ts: raw.ts || now(),
    type: raw.type,
    url: raw.url ? sanitizeUrl(raw.url) : '',
    title: raw.title || '',
    data: raw.data || {},
    sessionId: session ? session.id : '',
    userId: userId || '',
    deviceId: deviceId || '',
    tabId: session ? session.tabId : undefined,
  };
  if (raw.type === ET.PAGE_VIEW || raw.type === ET.NAVIGATION) {
    session.tabId = session.tabId || raw.tabId;
  }
  if (!opts.skipSession) {
    session.recordEvent(ev);
    session.touch(ev.ts);
    insights.ingest(ev);
  }
  inc(`ev_${ev.type}`);
  await db.enqueue('events', ev);
  return ev;
}

function emitInsight(rec) {
  const ev = {
    id: uuid(),
    ts: now(),
    type: ET.INSIGHT,
    url: '',
    title: rec.title,
    data: { kind: rec.kind, type: rec.type, body: rec.body, signal: rec.signal, confidence: rec.confidence, sessionId: rec.sessionId },
    sessionId: session ? session.id : '',
    userId: userId || '',
    deviceId: deviceId || '',
  };
  db.enqueue('events', ev);
  if (config.ui && config.ui.notifyOnInsight) {
    chrome.notifications.create('vaia-insight', {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: 'Visual AI Agent insight',
      message: String(rec.title || 'New insight'),
      priority: 1,
    });
  }
}

// ---------------------------------------------------------------------------
// Screenshot analysis
// ---------------------------------------------------------------------------
async function onAnalyzeScreenshot(record, reason) {
  const { analyze } = await import('./vision.js');
  const recentEvents = recentSummary(session, 12);
  const result = await analyze({
    config,
    context: {
      url: record.url,
      title: record.title || '',
      dataUrl: record.dataUrl,
      recentEvents,
    },
  });
  const insightRec = {
    id: uuid(),
    ts: now(),
    kind: 'vision',
    type: 'screen_analysis',
    title: `Screen analysis (${record.reason})`,
    body: result.summary || '',
    signal: (result.raw && result.raw.signals && result.raw.signals.frustration > 0.6) ? 'negative' : 'neutral',
    confidence: result.confidence ?? 0.5,
    sessionId: session ? session.id : '',
    data: { provider: result.provider, model: result.model, raw: result.raw, url: record.url, screenshotId: record.id },
  };
  await idb.put('insights', insightRec);
  emitInsight(insightRec);
  session.insights++;
  return result;
}

function recentSummary(s, n = 12) {
  const out = [];
  for (const ev of s.pages) {
    out.push({ tsRel: '', type: 'page_view', summary: ev.title || ev.url });
  }
  if (!out.length) out.push({ type: 'page_view', summary: 'no page yet' });
  return out.slice(-n);
}

// ---------------------------------------------------------------------------
// Tab / navigation / download events (background-side)
// ---------------------------------------------------------------------------
function setupTabListeners() {
  chrome.tabs.onActivated.addListener((info) => {
    if (session) {
      session.tabId = info.tabId;
      session.touch();
    }
    emitEvent({ id: uuid(), ts: now(), type: ET.TAB_ACTIVATED, url: '', title: '', data: { tabId: info.tabId } });
    // capture quickly so the screenshot matches the active tab
    if (config.capture && config.capture.enabled) {
      capture.captureNow({ tabId: info.tabId, reason: 'tab_activated', session, config: getConfig(), onAnalyze: onAnalyzeScreenshot });
    }
  });
  chrome.tabs.onCreated.addListener((t) => emitEvent({ id: uuid(), ts: now(), type: ET.TAB_CREATED, url: t.url || '', title: t.title || '', data: { tabId: t.id, windowId: t.windowId } }));
  chrome.tabs.onRemoved.addListener((tabId) => emitEvent({ id: uuid(), ts: now(), type: ET.TAB_CLOSED, url: '', title: '', data: { tabId } }));
  chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (!info) return;
    if (info.status === 'complete') {
      session.tabId = tabId;
      emitEvent({ id: uuid(), ts: now(), type: ET.TAB_UPDATED, url: tab.url || '', title: tab.title || '', data: { tabId, loaded: true } });
    }
  });
  chrome.webNavigation.onCommitted.addListener((d) => {
    if (d.frameId !== 0) return;
    if (!/^https?:/.test(d.url)) return;
    emitEvent({
      id: uuid(),
      ts: now(),
      type: ET.NAVIGATION,
      url: d.url,
      title: '',
      data: { from: '', to: d.url, kind: 'hard', transition: d.transitionType, tabId: d.tabId },
    });
    if (config.capture && config.capture.enabled && config.capture.onSignificantEvent) {
      capture.captureOnSignificant(d.tabId, session, getConfig(), onAnalyzeScreenshot);
    }
  });
  if (chrome.downloads) {
    chrome.downloads.onChanged.addListener((delta) => {
      if (delta && delta.state && delta.state.current === 'complete') {
        chrome.downloads.search({ id: delta.id }, (items) => {
          const it = items && items[0];
          emitEvent({
            id: uuid(),
            ts: now(),
            type: ET.FILE_DOWNLOAD,
            url: '',
            title: '',
            data: { filename: it && it.filename ? it.filename.split('/').pop() : '', mime: it && it.mime, size: it && it.fileSize, tabId: it && it.tabUrl },
          });
        });
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------
function updateBadge() {
  if (config.ui && config.ui.showBadge === false) {
    chrome.action.setBadgeText({ text: '' });
    return;
  }
  if (!config.enabled || mode === MODES.PAUSED) {
    chrome.action.setBadgeText({ text: '⏸' });
    chrome.action.setBadgeBackgroundColor({ color: '#888' });
    return;
  }
  const n = session ? session.events : 0;
  const text = n > 999 ? '9+' : String(n);
  chrome.action.setBadgeText({ text });
  const color = session && session.errors > 0 ? '#d33' : '#3a6ea5';
  chrome.action.setBadgeBackgroundColor({ color });
}

function startBadgeTimer() {
  if (badgeTimer) clearInterval(badgeTimer);
  badgeTimer = setInterval(updateBadge, 4000);
}

// ---------------------------------------------------------------------------
// Alarms
// ---------------------------------------------------------------------------
async function setupAlarms() {
  try {
    await chrome.alarms.create('vaia:flush', { periodInMinutes: 1 });
    await chrome.alarms.create('vaia:cleanup', { periodInMinutes: 60 * 24 });
    await chrome.alarms.create('vaia:heartbeat', { periodInMinutes: 1 });
  } catch (e) {
    captureLog('warn', 'alarms setup: ' + e.message);
  }
}

chrome.alarms.onAlarm.addListener(async (a) => {
  if (!a) return;
  if (a.name === 'vaia:flush') {
    db.flushNow();
    updateBadge();
  } else if (a.name === 'vaia:cleanup') {
    await retentionCleanup();
  } else if (a.name === 'vaia:heartbeat') {
    // finalize a stale session
    if (session && config.enabled && now() - session.lastActivityAt > 10 * 60 * 1000) {
      const ended = session;
      session = null;
      await finalizeSession(ended);
      await startSession();
    }
    updateBadge();
  }
});

async function retentionCleanup() {
  const days = config.privacy && config.privacy.dataRetentionDays ? config.privacy.dataRetentionDays : 30;
  const cutoff = now() - days * 24 * 60 * 60 * 1000;
  const del = { events: 0, screenshots: 0, insights: 0, sessions: 0 };
  for (const store of ['events', 'screenshots', 'insights', 'sessions']) {
    try {
      del[store] = await idb.deleteOlderThan(store, cutoff);
    } catch (e) {
      captureLog('warn', `cleanup ${store}: ${e.message}`);
    }
  }
  captureLog('info', `retention cleanup removed ${JSON.stringify(del)}`);
}

// ---------------------------------------------------------------------------
// Ports (content scripts)
// ---------------------------------------------------------------------------
function onConnect(port) {
  if (port.name !== 'vaia-port') return;
  const tabId = port.sender && port.sender.tab && port.sender.tab.id;
  ports.set(tabId, port);
  port.onMessage.addListener(async (msg) => {
    if (!msg) return;
    if (msg.type === MSG.HELLO) {
      port.postMessage({ type: 'vaia:config', config });
    } else if (msg.type === MSG.EVENT_BATCH) {
      await ingestEvents(msg.batch);
      refreshState();
    } else if (msg.type === MSG.PING) {
      port.postMessage({ type: MSG.PONG, ts: now() });
    }
  });
  port.onDisconnect.addListener(() => {
    ports.delete(tabId);
  });
}

// ---------------------------------------------------------------------------
// Runtime messages (UI pages)
// ---------------------------------------------------------------------------
async function handleMessage(msg, sender, sendResponse) {
  switch (msg.type) {
    case MSG.GET_STATE: {
      sendResponse(getStatePayload());
      return;
    }
    case MSG.SET_MODE: {
      mode = msg.mode === MODES.PAUSED ? MODES.PAUSED : MODES.MONITOR;
      await storage.setMode(mode);
      config.enabled = mode !== MODES.PAUSED;
      await storage.storageSet({ [storage.K.CONFIG]: config });
      applyConfigEffects();
      sendResponse({ ok: true, mode });
      return;
    }
    case MSG.GET_CONFIG: {
      sendResponse({ config });
      return;
    }
    case MSG.SAVE_CONFIG: {
      await saveConfig(msg.config || {});
      sendResponse({ ok: true, config });
      return;
    }
    case MSG.RESET_CONFIG: {
      config = normalizeConfig({});
      config.identity = { userId: '', device: config.identity?.device || '' };
      await storage.storageSet({ [storage.K.CONFIG]: config });
      await broadcastConfig();
      applyConfigEffects();
      refreshState();
      sendResponse({ ok: true, config });
      return;
    }
    case MSG.CAPTURE_NOW: {
      const rec = await capture.captureNow({ tabId: msg.tabId || session?.tabId, reason: 'manual', session, config: getConfig(), onAnalyze: onAnalyzeScreenshot });
      sendResponse({ ok: !!rec, id: rec && rec.id });
      return;
    }
    case MSG.SCAN_PAGE: {
      try {
        const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        const t = tabs[0];
        if (!t) return sendResponse({ error: 'no active tab' });
        const res = await chrome.tabs.sendMessage(t.id, { type: MSG.SCAN_PAGE, maxElements: msg.maxElements });
        sendResponse({ url: t.url, summary: res && res.summary });
      } catch (e) {
        sendResponse({ error: e.message });
      }
      return;
    }
    case MSG.HEATMAP: {
      try {
        const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        const t = tabs[0];
        if (!t) return sendResponse({ error: 'no active tab' });
        const res = await chrome.tabs.sendMessage(t.id, { type: MSG.HEATMAP, ...msg });
        sendResponse(res);
      } catch (e) {
        sendResponse({ error: e.message });
      }
      return;
    }
    case MSG.FLUSH_NOW: {
      const sent = await db.flushNow();
      sendResponse({ ok: true, sent });
      return;
    }
    case MSG.TEST_CONNECTION: {
      const test = await testConnection(msg);
      sendResponse(test);
      return;
    }
    case MSG.EXPORT: {
      const result = await exportAll();
      sendResponse(result);
      return;
    }
    case MSG.CLEAR_DATA: {
      await idb.clearStore('events');
      await idb.clearStore('screenshots');
      await idb.clearStore('insights');
      await idb.clearStore('sessions');
      sendResponse({ ok: true });
      return;
    }
    case MSG.OPEN_DASHBOARD: {
      const url = chrome.runtime.getURL('ui/dashboard/dashboard.html');
      await chrome.tabs.create({ url });
      sendResponse({ ok: true });
      return;
    }
    case MSG.GET_EVENTS: {
      sendResponse({ events: await queryEvents(msg) });
      return;
    }
    case MSG.GET_SESSIONS: {
      const out = [];
      await idb.each('sessions', { index: 'ts', direction: 'prev', limit: msg.limit || 50, onEach: (r) => out.push(r) });
      sendResponse({ sessions: out });
      return;
    }
    case MSG.GET_INSIGHTS: {
      const out = [];
      await idb.each('insights', { index: 'ts', direction: 'prev', limit: msg.limit || 100, onEach: (r) => out.push(r) });
      sendResponse({ insights: out });
      return;
    }
    case MSG.GET_SCREENSHOTS: {
      const out = [];
      await idb.each('screenshots', {
        index: msg.sessionId ? 'sessionId' : 'ts',
        direction: 'next',
        limit: msg.limit || 500,
        onEach: (r) => {
          if (msg.sessionId && r.sessionId !== msg.sessionId) return;
          out.push({ id: r.id, ts: r.ts, url: r.url, reason: r.reason, width: r.width, height: r.height, analyzed: r.analyzed });
        },
      });
      sendResponse({ screenshots: out });
      return;
    }
    case MSG.GET_SCREENSHOT: {
      const rec = await idb.get('screenshots', msg.id);
      sendResponse({ screenshot: rec });
      return;
    }
    case MSG.GET_STATS: {
      sendResponse({ ...(await queryStats()), db: db.getStatus(), queue: await db.getQueueStats() });
      return;
    }
    default:
      return false;
  }
}

async function testConnection(msg) {
  const endpoint = (msg && msg.endpoint) || config.db.endpoint;
  if (!endpoint) return { ok: false, error: 'No database endpoint configured.' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(msg && msg.apiKey ? { 'x-api-key': msg.apiKey } : {}),
      },
      body: JSON.stringify({ kind: 'ping', ts: now(), deviceId, message: 'vaia connection test' }),
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, body: text.slice(0, 200) };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

async function exportAll() {
  const events = [];
  await idb.each('events', { index: 'ts', onEach: (r) => events.push(r) });
  const screenshots = [];
  await idb.each('screenshots', { index: 'ts', onEach: (r) => screenshots.push({ id: r.id, ts: r.ts, url: r.url, width: r.width, height: r.height, dataUrl: r.dataUrl, reason: r.reason }) });
  const insights = [];
  await idb.each('insights', { index: 'ts', onEach: (r) => insights.push(r) });
  const sessions = [];
  await idb.each('sessions', { index: 'ts', onEach: (r) => sessions.push(r) });
  const blob = new Blob([JSON.stringify({ exportedAt: now(), deviceId, sessions, events, insights, screenshots })], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  try {
    const id = await chrome.downloads.download({ url, filename: `vaia-export-${Date.now()}.json`, saveAs: true });
    return { ok: true, downloadId: id, counts: { events: events.length, screenshots: screenshots.length, insights: insights.length, sessions: sessions.length } };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
}

// ---------------------------------------------------------------------------
// Data queries for the dashboard
// ---------------------------------------------------------------------------
async function queryEvents(msg) {
  const limit = msg.limit || 100;
  const out = [];
  let scanned = 0;
  await idb.each('events', {
    index: 'ts',
    direction: 'prev',
    limit: Math.max(limit, limit * 10),
    onEach: (r) => {
      scanned++;
      if (out.length >= limit) return false;
      if (msg.sessionId && r.sessionId !== msg.sessionId) return;
      if (msg.afterTs && r.ts < msg.afterTs) return;
      if (msg.beforeTs && r.ts > msg.beforeTs) return;
      if (msg.types && !msg.types.includes(r.type)) return;
      out.push(r);
    },
  });
  return out;
}

async function queryStats() {
  const byType = {};
  const byHour = {};
  let total = 0;
  let scanned = 0;
  await idb.each('events', {
    index: 'ts',
    onEach: (r) => {
      if (++scanned > 500000) return false;
      byType[r.type] = (byType[r.type] || 0) + 1;
      const hour = Math.floor(r.ts / 3600000) * 3600000;
      byHour[hour] = (byHour[hour] || 0) + 1;
      total++;
    },
  });
  const sessions = await idb.count('sessions');
  const screenshots = await idb.count('screenshots');
  const insights = await idb.count('insights');
  return { byType, byHour, total, sessions, screenshots, insights, scanned };
}

// ---------------------------------------------------------------------------
// State for UI
// ---------------------------------------------------------------------------
function refreshState() {
  state = getStatePayload();
}

function getStatePayload() {
  return {
    mode,
    enabled: config.enabled,
    sessionId: session ? session.id : null,
    startedAt: session ? session.startedAt : null,
    lastActivityAt: session ? session.lastActivityAt : null,
    events: session ? session.events : 0,
    eventTypes: session ? session.eventTypes : {},
    errors: session ? session.errors : 0,
    rageClicks: session ? session.rageClicks : 0,
    deadClicks: session ? session.deadClicks : 0,
    screenshots: session ? session.screenshots : 0,
    insights: session ? session.insights : 0,
    pages: session ? session.pages.slice(-8) : [],
    deviceId,
    userId,
    config: {
      enabled: config.enabled,
      capture: config.capture,
      db: { ...config.db, apiKey: config.db.apiKey ? '•••' : '' },
      vision: { ...config.vision, apiKey: config.vision.apiKey ? '•••' : '' },
      privacy: config.privacy,
      identity: { ...config.identity },
    },
    counters: { ...counterAll() },
    log: logSnapshot(),
    db: db.getStatus(),
    queue: null,
    timestamp: now(),
  };
}

function counterAll() {
  const out = {};
  for (const k of ['ev_click', 'ev_navigation', 'ev_error', 'queued_events', 'sent_events', 'sent_screenshots', 'sent_insights', 'flush_count']) {
    out[k] = counter(k);
  }
  return out;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender, sendResponse).catch((e) => {
    captureLog('error', 'handleMessage failed: ' + ((e && e.stack) || e));
    try {
      sendResponse({ error: (e && e.message) || String(e) });
    } catch {}
  });
  return true; // async
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
chrome.runtime.onInstalled.addListener(async () => {
  await loadConfig();
  await setupAlarms();
  await startSession();
  applyConfigEffects();
});

chrome.runtime.onStartup.addListener(async () => {
  await loadConfig();
  await startSession();
  applyConfigEffects();
});

(async function init() {
  await loadConfig();
  await ensureIcons();
  await setupAlarms();
  db.initDb({ getConfig });
  chrome.runtime.onConnect.addListener(onConnect);
  setupTabListeners();
  startBadgeTimer();
  await startSession();
  applyConfigEffects();
  await capture.ensureOffscreen();
  capture.setConfigRef(getConfig);
  db.flushNow();
  captureLog('info', 'service worker initialized');
})();

chrome.runtime.onSuspend?.addListener(() => {
  capture.stopCaptureLoop();
  if (badgeTimer) clearInterval(badgeTimer);
});

// Icons may not exist on a fresh checkout — generate them lazily is not possible
// from the SW, so only log if missing; tools/gen-icons.mjs handles creation.
async function ensureIcons() {
  try {
    const res = await fetch(chrome.runtime.getURL('icons/icon128.png'));
    if (!res.ok) {
      captureLog('warn', 'icons missing — run `npm run icons` (tools/gen-icons.mjs)');
    }
  } catch {
    captureLog('warn', 'icons missing — run `npm run icons` (tools/gen-icons.mjs)');
  }
}

export { getConfig, getStatePayload };
