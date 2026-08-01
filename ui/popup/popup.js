/**
 * popup.js — live status + quick controls for the extension.
 */
import { send, getState, el, fmtTime, fmtDuration, fmtNum, toast } from '../ui.js';
import { MSG, MODES } from '../../shared/protocol.js';

const $ = (id) => document.getElementById(id);

const STAT_DEFS = [
  ['events', 'Events'],
  ['pageCount', 'Pages'],
  ['errors', 'Errors', 'bad'],
  ['rageClicks', 'Rage'],
  ['deadClicks', 'Dead clk'],
  ['screenshots', 'Shots'],
  ['insights', 'Insights'],
  ['durationMs', 'Duration'],
];

function renderStats(s) {
  const grid = $('stats');
  grid.innerHTML = '';
  const values = {
    events: s.events,
    pageCount: s.pages?.length || 0,
    errors: s.errors,
    rageClicks: s.rageClicks,
    deadClicks: s.deadClicks,
    screenshots: s.screenshots,
    insights: s.insights,
    durationMs: s.startedAt ? fmtDuration(Date.now() - s.startedAt) : '—',
  };
  for (const [key, label, tone] of STAT_DEFS) {
    const div = el('div', { class: 'stat' + (tone && values[key] > 0 ? ' ' + tone : '') });
    div.appendChild(el('div', { class: 'v', text: String(values[key]) }));
    div.appendChild(el('div', { class: 'l', text: label }));
    grid.appendChild(div);
  }
}

function renderPages(s) {
  const box = $('pages');
  box.innerHTML = '';
  const pages = s.pages || [];
  if (!pages.length) {
    box.appendChild(el('div', { class: 'muted', text: 'No pages visited yet this session.' }));
    return;
  }
  for (const p of pages.slice(-6).reverse()) {
    box.appendChild(
      el('div', { class: 'row', style: 'align-items:flex-start;gap:6px' }, [
        el('span', { class: 'mono muted', text: fmtTime(p.ts) }),
        el('span', { style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap', text: p.title || p.url }),
      ])
    );
  }
}

function renderDb(s) {
  const db = s.db || {};
  const cfg = s.config?.db || {};
  $('dbEndpoint').textContent = cfg.endpoint || 'no endpoint';
  $('dbEndpoint').className = 'tag mono ' + (cfg.endpoint ? 'good' : '');
  $('dbFlush').textContent = db.lastFlushStatus || 'idle';
  $('dbFlush').className = 'tag ' + (db.lastFlushStatus === 'ok' ? 'good' : db.lastFlushStatus === 'flushing' ? 'warn' : '');
  $('dbFlush').title = db.lastFlushError || '';
  $('dbQueue').textContent = `q:${fmtNum(db.queue || 0)} sent:${fmtNum(db.sentEvents || 0)}`;
}

function renderStatus(s) {
  const dot = $('statusDot');
  const text = $('statusText');
  if (s.mode === MODES.PAUSED || !s.enabled) {
    dot.className = 'dot warn';
    text.textContent = 'Paused';
    $('btnPause').textContent = 'Resume monitoring';
  } else {
    dot.className = 'dot good pulse';
    text.textContent = 'Monitoring — ' + (s.pages?.length || 0) + ' page(s)';
    $('btnPause').textContent = 'Pause monitoring';
  }
  $('sessionId').textContent = (s.sessionId || '—').slice(0, 8);
  $('sessionStart').textContent = 'started ' + fmtTime(s.startedAt);
  $('sessionDuration').textContent = fmtDuration(Date.now() - (s.startedAt || Date.now()));
}

async function refresh() {
  const s = await getState();
  if (s && s.error) {
    $('statusText').textContent = s.error;
    return;
  }
  renderStatus(s);
  renderStats(s);
  renderPages(s);
  renderDb(s);
}

// ---- actions ---------------------------------------------------------------
async function togglePause() {
  const s = await getState();
  const next = s.mode === MODES.PAUSED ? MODES.MONITOR : MODES.PAUSED;
  await send({ type: MSG.SET_MODE, mode: next });
  toast(next === MODES.PAUSED ? 'Monitoring paused' : 'Monitoring resumed');
  refresh();
}

async function captureNow() {
  const res = await send({ type: MSG.CAPTURE_NOW });
  toast(res.ok ? 'Screenshot captured' : 'Capture failed');
  refresh();
}

async function scanPage() {
  const modal = $('scanModal');
  modal.classList.remove('hidden');
  $('scanBody').textContent = 'Scanning current page…';
  const res = await send({ type: MSG.SCAN_PAGE, maxElements: 40 });
  const body = $('scanBody');
  if (res.error) {
    body.textContent = 'Error: ' + res.error;
    return;
  }
  const s = res.summary || {};
  body.innerHTML = '';
  const title = el('div', { style: 'font-weight:600;margin-bottom:4px', text: s.title || res.url });
  const text = el('div', { style: 'white-space:pre-wrap;max-height:160px;overflow:auto;font-size:12px', text: (s.text || 'No readable text.') });
  const elems = el('div', { class: 'muted', style: 'font-size:11px;margin-top:6px', text: `${(s.elements || []).length} interactive elements, viewport ${s.viewport?.w}x${s.viewport?.h}` });
  body.appendChild(title);
  body.appendChild(text);
  body.appendChild(elems);
}

function wire() {
  $('btnPause').addEventListener('click', togglePause);
  $('btnCapture').addEventListener('click', captureNow);
  $('btnScan').addEventListener('click', scanPage);
  $('scanClose').addEventListener('click', () => $('scanModal').classList.add('hidden'));
  $('btnDashboard').addEventListener('click', async () => {
    await send({ type: MSG.OPEN_DASHBOARD });
    window.close();
  });
  $('btnOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('btnFlush').addEventListener('click', async () => {
    const res = await send({ type: MSG.FLUSH_NOW });
    toast(res.ok ? `Flushed ${res.sent} record(s)` : 'Flush failed');
    refresh();
  });
  $('btnExport').addEventListener('click', async () => {
    const res = await send({ type: MSG.EXPORT });
    toast(res.ok ? `Exporting… ${JSON.stringify(res.counts)}` : 'Export failed: ' + (res.error || ''));
  });
}

wire();
refresh();
setInterval(refresh, 2000);
