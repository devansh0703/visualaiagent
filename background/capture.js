/**
 * capture.js — screen capture pipeline. Uses chrome.tabs.captureVisibleTab,
 * downsizes through the offscreen document, stores frames locally (for replay)
 * and hands them to the vision analyzer.
 */
import { now, uuid } from '../shared/utils.js';
import * as idb from './idb.js';
import { captureLog } from './telemetry.js';

let offscreenReady = false;
let lastSignificantCapture = 0;
let captureLoopTimer = null;
let captureCounter = 0;

export async function ensureOffscreen() {
  if (offscreenReady) return true;
  try {
    if (!chrome.offscreen) return false;
    const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (!existing.length) {
      await chrome.offscreen.createDocument({
        url: chrome.runtime.getURL('offscreen/index.html'),
        reasons: ['BLOBS'],
        justification: 'Resize and re-encode captured screenshots for storage and vision analysis.',
      });
    }
    offscreenReady = true;
    return true;
  } catch (e) {
    offscreenReady = false;
    return false;
  }
}

async function processImage(dataUrl, maxWidth, quality) {
  const ok = await ensureOffscreen();
  if (!ok) return { dataUrl, width: 0, height: 0, mime: 'image/jpeg' };
  const id = uuid();
  try {
    const res = await chrome.runtime.sendMessage({ type: 'vaia:process_image', id, dataUrl, maxWidth, quality });
    if (res && res.dataUrl) return res;
  } catch (e) {
    /* fall through to raw */
  }
  return { dataUrl, width: 0, height: 0, mime: 'image/jpeg' };
}

function isCapturableUrl(url) {
  return !!url && /^https?:/i.test(url);
}

/** Capture the visible tab and store/analyze it. */
export async function captureNow({ tabId, reason = 'scheduled', session, config, onAnalyze }) {
  if (!config.capture || config.capture.enabled === false) return null;
  let tab = null;
  if (tabId) {
    try {
      tab = await chrome.tabs.get(tabId);
      if (tab && !isCapturableUrl(tab.url)) tab = null;
    } catch {
      tab = null;
    }
  }
  if (!tab) {
    // Fall back to the currently visible tab so manual captures always work
    // even when the session has no capturable pinned tabId yet.
    const active = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = active && active[0];
  }
  if (!tab || !isCapturableUrl(tab.url)) return null;
  tabId = tab.id;
  let raw;
  try {
    raw = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: Math.min(100, Math.max(10, config.capture.quality)) });
  } catch (e) {
    captureLog('error', 'captureVisibleTab failed: ' + e.message);
    return null;
  }
  if (!raw) return null;

  const processed = await processImage(raw, config.capture.maxWidth || 1280, config.capture.quality || 60);

  const record = {
    id: uuid(),
    ts: now(),
    sessionId: session.id,
    tabId,
    url: tab.url,
    reason,
    mime: processed.mime || 'image/jpeg',
    dataUrl: processed.dataUrl,
    width: processed.width,
    height: processed.height,
    analyzed: false,
    analysis: null,
  };
  session.screenshots++;
  session.touch();

  if (config.capture.storeLocal) {
    await idb.put('screenshots', record);
    // trim per-session frames
    await trimFrames(session.id, config.capture.storeLocalMaxFrames || 600);
  }

  captureCounter++;
  let analyzed = null;
  if (onAnalyze && config.vision && config.vision.enabled) {
    if (captureCounter % Math.max(1, config.vision.analyzeScreenEveryNth || 5) === 0 || reason === 'session_end') {
      try {
        analyzed = await onAnalyze(record, reason);
        if (analyzed) {
          record.analyzed = true;
          record.analysis = analyzed.summary || null;
          if (config.capture.storeLocal) await idb.put('screenshots', record);
        }
      } catch (e) {
        captureLog('error', 'vision analyze failed: ' + e.message);
      }
    }
  }
  return record;
}

/** Fire a screenshot immediately on significant activity (click, nav, error…). */
export function captureOnSignificant(tabId, session, config, onAnalyze) {
  const t = now();
  if (t - lastSignificantCapture < 800) return; // throttle burst
  lastSignificantCapture = t;
  captureNow({ tabId, reason: 'significant', session, config, onAnalyze });
}

/** Periodic capture loop using chained timers (kept alive by traffic + alarms). */
export function startCaptureLoop(session, config, onAnalyze) {
  stopCaptureLoop();
  const tick = async () => {
    const cfg = await loadConfigRef();
    if (!cfg.enabled) return;
    await captureNow({ reason: 'scheduled', session, config: cfg, onAnalyze });
    captureLoopTimer = setTimeout(tick, cfg.capture.intervalMs || 5000);
  };
  tick();
}

let configRef = null;
export function setConfigRef(fn) {
  configRef = fn;
}
async function loadConfigRef() {
  if (configRef) return configRef();
  return { enabled: true, capture: {} };
}

export function stopCaptureLoop() {
  if (captureLoopTimer) {
    clearTimeout(captureLoopTimer);
    captureLoopTimer = null;
  }
}

async function trimFrames(sessionId, max) {
  const list = await idb.getByIndex('screenshots', 'sessionId', sessionId, max + 500);
  if (list.length <= max) return;
  const overflow = list.sort((a, b) => a.ts - b.ts).slice(0, list.length - max);
  await idb.deleteMany('screenshots', overflow.map((r) => r.id));
}
