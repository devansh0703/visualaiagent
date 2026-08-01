/**
 * dashboard.js — live telemetry feed, session list, frame replay, insights,
 * heatmap controls and aggregate statistics.
 */
import { send, getState, el, fmtTime, fmtDateTime, fmtDuration, fmtNum, toast } from '../ui.js';
import { MSG } from '../../shared/protocol.js';

const $ = (id) => document.getElementById(id);

// ---- tabs ------------------------------------------------------------------
document.querySelectorAll('.tabs button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('panel-' + btn.dataset.tab).classList.add('active');
    onTab(btn.dataset.tab);
  });
});

function onTab(name) {
  if (name === 'live') refreshLive();
  else if (name === 'sessions') loadSessions();
  else if (name === 'replay') loadReplaySessionList();
  else if (name === 'insights') loadInsights();
  else if (name === 'stats') loadStats();
  else if (name === 'heatmaps') refreshHeatmapStatus();
}

// ---- live ------------------------------------------------------------------
let liveTimer = null;
let liveEvents = new Map();

async function refreshLive() {
  const s = await getState();
  if (s.error) return;
  $('statusLine').textContent = `Session ${(s.sessionId || '').slice(0, 8)} · ${s.events} events · ${s.screenshots} shots · ${s.insights} insights`;
  const stats = [
    ['events', 'Events'], ['errors', 'Errors', s.errors > 0 ? 'bad' : ''], ['rageClicks', 'Rage clicks', s.rageClicks > 0 ? 'bad' : ''],
    ['deadClicks', 'Dead clicks'], ['screenshots', 'Screenshots'], ['insights', 'Insights'],
    ['pageCount', 'Pages'], ['durationMs', 'Duration'],
  ];
  const values = {
    events: s.events, errors: s.errors, rageClicks: s.rageClicks, deadClicks: s.deadClicks,
    screenshots: s.screenshots, insights: s.insights, pageCount: s.pages?.length || 0,
    durationMs: s.startedAt ? fmtDuration(Date.now() - s.startedAt) : '—',
  };
  const grid = $('liveStats');
  grid.innerHTML = '';
  for (const [k, label, tone] of stats) {
    const div = el('div', { class: 'stat' + (tone ? ' ' + tone : '') });
    div.appendChild(el('div', { class: 'v', text: String(values[k]) }));
    div.appendChild(el('div', { class: 'l', text: label }));
    grid.appendChild(div);
  }
}

async function refreshFeed() {
  const res = await send({ type: MSG.GET_EVENTS, limit: 80 });
  const filter = ($('liveFilter').value || '').toLowerCase();
  for (const ev of res.events || []) liveEvents.set(ev.id, ev);
  if (liveEvents.size > 300) {
    const keys = [...liveEvents.keys()];
    for (const k of keys.slice(0, keys.length - 300)) liveEvents.delete(k);
  }
  const feed = $('liveFeed');
  feed.innerHTML = '';
  const list = [...liveEvents.values()].sort((a, b) => b.ts - a.ts).slice(0, 80);
  for (const ev of list) {
    if (filter && !ev.type.includes(filter) && !(ev.data && JSON.stringify(ev.data).toLowerCase().includes(filter))) continue;
    const target = ev.data && ev.data.target;
    const summary =
      target?.text || target?.ariaLabel || target?.tag || (ev.type === 'navigation' ? (ev.data.to || '') : '') ||
      (ev.type === 'error' ? ev.data.message : '') || (ev.type === 'page_view' ? ev.title : '');
    const item = el('div', { class: 'feed-item' }, [
      el('span', { class: 't', text: fmtTime(ev.ts) }),
      el('span', { class: 'ty', text: ev.type, title: ev.type }),
      el('span', { class: 'd', text: String(summary).slice(0, 140) }),
    ]);
    feed.appendChild(item);
  }
}

function startLive() {
  if (liveTimer) return;
  refreshLive();
  refreshFeed();
  liveTimer = setInterval(() => {
    refreshLive();
    refreshFeed();
  }, 1500);
}

$('liveFilter').addEventListener('input', () => refreshFeed());

// ---- sessions ---------------------------------------------------------------
async function loadSessions() {
  const res = await send({ type: MSG.GET_SESSIONS, limit: 50 });
  const tbody = document.querySelector('#sessionsTable tbody');
  tbody.innerHTML = '';
  for (const s of res.sessions || []) {
    const row = el('tr');
    row.appendChild(el('td', { text: fmtDateTime(s.startedAt) }));
    row.appendChild(el('td', { text: fmtDuration(s.durationMs) }));
    row.appendChild(el('td', { text: fmtNum(s.events) }));
    row.appendChild(el('td', { text: s.pageCount }));
    row.appendChild(el('td', { class: s.errors > 0 ? 'bad' : '', text: fmtNum(s.errors) }));
    row.appendChild(el('td', { text: fmtNum(s.rageClicks) }));
    const replayBtn = el('button', { class: 'ghost pill-btn', text: 'Replay', onclick: () => openReplay(s.id) });
    const td = el('td');
    td.appendChild(replayBtn);
    row.appendChild(td);
    tbody.appendChild(row);
  }
}

function openReplay(sessionId) {
  populateReplaySelect(sessionId).then(() => {
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === 'replay'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === 'panel-replay'));
    loadReplaySessionList(sessionId);
  });
}

// ---- replay ----------------------------------------------------------------
const replay = { frames: [], cache: new Map(), idx: 0, timer: null, playing: false, events: [] };

async function loadReplaySessionList(selectId) {
  const res = await send({ type: MSG.GET_SESSIONS, limit: 30 });
  const select = $('replaySession');
  select.innerHTML = '';
  for (const s of res.sessions || []) {
    const opt = el('option', { value: s.id, text: `${fmtDateTime(s.startedAt)} · ${fmtNum(s.events)} events · ${s.pageCount} pages` });
    select.appendChild(opt);
  }
  if (selectId && [...select.options].some((o) => o.value === selectId)) select.value = selectId;
  if (select.options.length) {
    select.value = selectId || select.options[0].value;
    loadReplayFrames(select.value);
  } else {
    $('replayEmpty').textContent = 'No sessions recorded yet.';
    $('replayEmpty').style.display = 'flex';
  }
}

function populateReplaySelect(sessionId) {
  return new Promise((resolve) => {
    loadReplaySessionList(sessionId);
    setTimeout(resolve, 50);
  });
}

async function loadReplayFrames(sessionId) {
  stopReplay();
  replay.frames = [];
  replay.cache = new Map();
  replay.idx = 0;
  replay.events = [];
  const [shotsRes, evRes] = await Promise.all([
    send({ type: MSG.GET_SCREENSHOTS, sessionId, limit: 600 }),
    send({ type: MSG.GET_EVENTS, sessionId, limit: 300 }),
  ]);
  replay.frames = shotsRes.screenshots || [];
  replay.events = evRes.events || [];
  $('replayEmpty').style.display = replay.frames.length ? 'none' : 'flex';
  const scrub = $('replayScrub');
  scrub.max = Math.max(0, replay.frames.length - 1);
  scrub.value = 0;
  if (replay.frames.length) {
    await showFrame(0);
  } else {
    $('replayImg').src = '';
  }
  renderReplayEvents();
}

async function showFrame(i) {
  if (!replay.frames.length) return;
  i = Math.max(0, Math.min(replay.frames.length - 1, i));
  replay.idx = i;
  const f = replay.frames[i];
  $('replayScrub').value = i;
  $('replayPos').textContent = `${i + 1} / ${replay.frames.length}`;
  let rec = replay.cache.get(f.id);
  if (!rec) {
    const res = await send({ type: MSG.GET_SCREENSHOT, id: f.id });
    rec = res.screenshot || {};
    replay.cache.set(f.id, rec);
  }
  if (rec.dataUrl) $('replayImg').src = rec.dataUrl;
  $('replayMeta').textContent = `${fmtTime(f.ts)} · ${f.reason} · ${rec.url || f.url || ''}`;
  lightReplayEvents(f.ts);
}

function renderReplayEvents() {
  const box = $('replayEvents');
  box.innerHTML = '';
  for (const ev of replay.events) {
    const target = ev.data?.target;
    const label = `${ev.type}${target?.text ? ' · ' + String(target.text).slice(0, 30) : ''}`;
    const chip = el('span', { class: 'chip', text: label, title: ev.type });
    chip.dataset.ts = String(ev.ts);
    chip.dataset.id = ev.id;
    box.appendChild(chip);
  }
}

function lightReplayEvents(ts) {
  document.querySelectorAll('#replayEvents .chip').forEach((c) => {
    c.classList.toggle('lit', Number(c.dataset.ts) <= ts);
  });
}

function stopReplay() {
  if (replay.timer) {
    clearInterval(replay.timer);
    replay.timer = null;
  }
  replay.playing = false;
  $('replayToggle').textContent = '▶ Play';
}

function togglePlay() {
  if (!replay.frames.length) return;
  if (replay.playing) {
    stopReplay();
    return;
  }
  replay.playing = true;
  $('replayToggle').textContent = '⏸ Pause';
  replay.timer = setInterval(() => {
    if (replay.idx >= replay.frames.length - 1) {
      stopReplay();
      return;
    }
    showFrame(replay.idx + 1);
  }, Number($('replaySpeed').value));
}

$('replaySession').addEventListener('change', (e) => loadReplayFrames(e.target.value));
$('replayToggle').addEventListener('click', togglePlay);
$('replayPrev').addEventListener('click', () => showFrame(replay.idx - 1));
$('replayNext').addEventListener('click', () => showFrame(replay.idx + 1));
$('replayScrub').addEventListener('input', (e) => showFrame(Number(e.target.value)));
$('replaySpeed').addEventListener('change', () => { if (replay.playing) { stopReplay(); togglePlay(); } });

// ---- insights ----------------------------------------------------------------
async function loadInsights() {
  const res = await send({ type: MSG.GET_INSIGHTS, limit: 100 });
  const box = $('insightsList');
  box.innerHTML = '';
  for (const ins of res.insights || []) {
    const tone = ins.signal === 'negative' ? 'negative' : ins.signal === 'warn' ? 'warn' : '';
    const card = el('div', { class: 'card insight ' + tone });
    const head = el('div', { class: 'head' }, [
      el('span', { class: 'tag ' + (ins.kind === 'llm' ? 'good' : ins.kind === 'vision' ? '' : 'warn'), text: ins.kind || 'rule' }),
      el('span', { style: 'font-weight:600', text: ins.title }),
      el('span', { class: 'grow' }),
      el('span', { class: 'mono muted', text: fmtTime(ins.ts) }),
      el('span', { class: 'muted', text: `conf ${Math.round((ins.confidence || 0) * 100)}%` }),
    ]);
    const body = el('div', { class: 'body', text: renderInsightBody(ins) });
    head.addEventListener('click', () => card.classList.toggle('open'));
    card.appendChild(head);
    card.appendChild(body);
    box.appendChild(card);
  }
  if (!res.insights?.length) box.appendChild(el('div', { class: 'muted', text: 'No insights generated yet.' }));
}

function renderInsightBody(ins) {
  const parts = [ins.body || ''];
  if (ins.data?.recommendations?.length) parts.push('\nRecommendations:\n' + ins.data.recommendations.map((r) => ' • ' + r).join('\n'));
  if (ins.data?.highlights?.length) parts.push('\nHighlights:\n' + ins.data.highlights.map((r) => ' • ' + r).join('\n'));
  if (ins.data?.lowlights?.length) parts.push('\nLowlights:\n' + ins.data.lowlights.map((r) => ' • ' + r).join('\n'));
  if (ins.data?.raw && ins.kind === 'vision') parts.push('\nVision JSON:\n' + JSON.stringify(ins.data.raw, null, 1).slice(0, 1200));
  return parts.join('\n');
}

// ---- heatmaps ----------------------------------------------------------------
async function refreshHeatmapStatus() {
  const s = await getState();
  $('heatmapStatus').textContent = 'Overlay is shown on the page you were viewing when toggling.';
}

async function heatAction(action, mode) {
  const res = await send({ type: MSG.HEATMAP, action, mode });
  if (res.error) toast('Heatmap: ' + res.error);
  else toast(res.mode ? `${res.mode} overlay on` : 'Overlay off');
}

$('btnHeatClicks').addEventListener('click', () => heatAction('toggle', 'clicks'));
$('btnHeatScroll').addEventListener('click', () => heatAction('toggle', 'scroll'));
$('btnHeatClear').addEventListener('click', () => heatAction('clear'));
$('btnHeatData').addEventListener('click', async () => {
  const res = await send({ type: MSG.HEATMAP, action: 'data' });
  const box = $('heatmapData');
  if (res.error) {
    box.textContent = res.error;
    return;
  }
  const clicks = res.clicks || [];
  const scroll = res.scroll || [];
  box.innerHTML = '';
  box.appendChild(el('div', { text: `clicks: ${clicks.length}, scroll samples: ${scroll.length}` }));
  const byCell = {};
  for (const c of clicks.slice(-1000)) {
    const k = `${Math.round(c.x / 50)},${Math.round(c.y / 50)}`;
    byCell[k] = (byCell[k] || 0) + 1;
  }
  for (const [k, n] of Object.entries(byCell).sort((a, b) => b[1] - a[1]).slice(0, 30)) {
    box.appendChild(el('div', { text: `cell ${k} → ${n} clicks` }));
  }
});

// ---- stats -------------------------------------------------------------------
async function loadStats() {
  const res = await send({ type: MSG.GET_STATS });
  const totals = $('statTotals');
  totals.innerHTML = '';
  for (const [k, label] of [['total', 'Events'], ['sessions', 'Sessions'], ['screenshots', 'Screenshots'], ['insights', 'Insights']]) {
    const d = el('div', { class: 'stat' });
    d.appendChild(el('div', { class: 'v', text: fmtNum(res[k] || 0) }));
    d.appendChild(el('div', { class: 'l', text: label }));
    totals.appendChild(d);
  }
  const bars = $('statBars');
  bars.innerHTML = '';
  const sorted = Object.entries(res.byType || {}).sort((a, b) => b[1] - a[1]).slice(0, 20);
  const max = sorted.length ? sorted[0][1] : 1;
  for (const [type, n] of sorted) {
    const row = el('div', { class: 'bar-row' }, [
      el('span', { class: 'bar-label', text: type }),
      el('div', { class: 'bar-track' }, [el('div', { class: 'bar-fill', style: `width:${(n / max) * 100}%` })]),
      el('span', { class: 'bar-num', text: fmtNum(n) }),
    ]);
    bars.appendChild(row);
  }
  const q = res.queue || {};
  $('statSync').textContent = [
    `last flush: ${res.db?.lastFlushStatus || 'idle'} (${fmtTime(res.db?.lastFlushAt)})`,
    res.db?.lastFlushError ? ` · last error: ${res.db.lastFlushError}` : '',
    ` · queued events: ${fmtNum(q.unsent)} · failed: ${fmtNum(q.failed)}`,
    ` · screenshots: ${fmtNum(q.screenshots)} · insights: ${fmtNum(q.insights)}`,
    ` · sent: ${fmtNum(res.db?.sentEvents || 0)} ev / ${fmtNum(res.db?.sentScreenshots || 0)} shots / ${fmtNum(res.db?.sentInsights || 0)} ins`,
  ].join('');
}

$('btnOpenOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());

// ---- boot ---------------------------------------------------------------------
startLive();
