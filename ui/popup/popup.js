/**
 * popup.js — live status, agent chat and quick controls for the extension.
 */
import { send, getState, el, fmtTime, fmtDuration, fmtNum, toast } from '../ui.js';
import { MSG, MODES } from '../../shared/protocol.js';
import { categoryOf } from '../../shared/categories.js';

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

  const focus = s.focus;
  $('focusTag').textContent = focus ? `focus ${Math.round(focus.score * 100)}%` : 'focus —';
  $('focusTag').className = 'tag ' + (focus && focus.score >= 0.6 ? 'good' : focus && focus.score <= 0.35 ? 'warn' : '');

  const vc = s.config?.vision || {};
  $('modelTag').textContent = vc.model ? `${vc.provider || ''}:${vc.model}` : (vc.provider || 'no vision');
  $('modelTag').title = 'vision provider and model';
}

async function renderInsights(s) {
  const res = await send({ type: MSG.GET_INSIGHTS, limit: 6 });
  const box = $('insightsFeed');
  box.innerHTML = '';
  const list = (res.insights || []).slice(0, 6);
  if (!list.length) {
    box.appendChild(el('div', { class: 'muted', text: 'No insights yet — ask the agent or wait for analysis.' }));
    return;
  }
  for (const ins of list) {
    const tone = ins.signal === 'negative' ? 'bad' : ins.signal === 'hesitation' ? 'warn' : 'good';
    const row = el('div', { class: 'row', style: 'align-items:flex-start;gap:6px' });
    row.appendChild(el('span', { class: 'dot ' + tone, style: 'margin-top:4px' }));
    const col = el('div', { class: 'col', style: 'gap:1px;flex:1' });
    col.appendChild(el('div', { style: 'font-weight:600;color:#fff', text: ins.title || 'insight' }));
    if (ins.body) col.appendChild(el('div', { class: 'muted', style: 'overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical', text: ins.body }));
    row.appendChild(col);
    box.appendChild(row);
  }
}

async function renderSites() {
  const stats = await send({ type: MSG.GET_STATS });
  const box = $('sitesList');
  box.innerHTML = '';
  const att = stats.attention || {};
  const top = (att.top || []).slice(0, 6);
  const total = att.totalMs ? Math.round(att.totalMs / 60000) : 0;
  if (!top.length) {
    box.appendChild(el('div', { class: 'muted', text: 'No activity tracked yet this hour.' }));
    return;
  }
  box.appendChild(el('div', { class: 'muted', style: 'font-size:11px', text: `~${total} min active attention` }));
  const max = Math.max(1, ...top.map((s) => s.ms));
  for (const s of top) {
    const cat = categoryOf('https://' + s.host);
    const tone = cat.score === 0 ? 'bad' : cat.score >= 1 ? 'good' : 'warn';
    const row = el('div', { class: 'row', style: 'gap:6px' });
    row.appendChild(el('span', { class: 'tag ' + tone, text: s.minutes + 'm' }));
    const track = el('div', { class: 'track', style: 'flex:1;height:6px;background:#24303c;border-radius:3px;overflow:hidden' });
    const fill = el('div', { style: 'height:100%;background:' + (cat.score === 0 ? 'var(--bad,#e0556b)' : 'var(--good,#43d17c)') + ';width:' + ((s.ms / max) * 100).toFixed(0) + '%' });
    track.appendChild(fill);
    row.appendChild(track);
    row.appendChild(el('span', { class: 'mono muted', style: 'max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', text: s.host }));
    box.appendChild(row);
  }
}

function renderControls(s) {
  const box = $('controls');
  box.innerHTML = '';
  const cfg = s.config || {};
  const defs = [
    ['capture', 'capture', 'Screen capture', !!cfg.capture?.enabled],
    ['vision', 'vision', 'Vision analysis', !!cfg.vision?.enabled],
    ['notify', 'ui', 'Insight notifications', !!cfg.ui?.notifyOnInsight],
    ['goals', 'goals', 'Distraction goal', !!cfg.goals?.enabled],
  ];
  for (const [id, section, label, checked] of defs) {
    const cb = el('input', { type: 'checkbox', id: 'tg_' + id });
    cb.checked = !!checked;
    cb.addEventListener('change', async () => {
      await send({ type: MSG.SAVE_CONFIG, config: buildTogglePatch(id, cb.checked) });
      toast(label + (cb.checked ? ' on' : ' off'));
      refresh();
    });
    const row = el('label', { class: 'row', style: 'gap:8px;cursor:pointer' }, [cb, el('span', { text: label })]);
    box.appendChild(row);
  }
}

function buildTogglePatch(id, value) {
  switch (id) {
    case 'capture':
      return { capture: { enabled: value } };
    case 'vision':
      return { vision: { enabled: value } };
    case 'notify':
      return { ui: { notifyOnInsight: value } };
    case 'goals':
      return { goals: { enabled: value } };
    default:
      return {};
  }
}

const PRESETS = {
  Preset1: 'Summarize this page in 3 bullet points. What is it about and what is the main action a user should take?',
  Preset2: 'Looking at this page, what could be improved? List concrete usability issues and what the developer should fix.',
  Preset3: 'Is this page likely to distract me? Based on what is on screen, rate how engaging or distracting it is and suggest whether I should close it.',
};

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
  renderControls(s);
  await renderInsights(s);
  await renderSites();
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

async function askAgent() {
  const input = $('askInput');
  const question = input.value.trim();
  if (!question) return;
  const btn = $('btnAsk');
  btn.disabled = true;
  btn.textContent = 'Thinking…';
  const ans = $('askAnswer');
  ans.style.display = 'block';
  ans.textContent = 'Capturing the visible tab and asking the vision model…';
  try {
    const res = await send({ type: MSG.ASK_AGENT, question });
    if (res.error) {
      ans.textContent = 'Error: ' + res.error;
    } else {
      renderRichAnswer(ans, question, res);
      input.value = '';
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Ask';
    refresh();
  }
}

function renderRichAnswer(ans, question, res) {
  const d = res.details || {};
  const parts = [];
  parts.push(res.answer || 'No answer.');
  if (d.screen && d.screen.type) parts.push('\n[page] ' + (d.screen.type || '') + (d.screen.keyElements?.length ? ` · ${d.screen.keyElements.length} key element(s)` : ''));
  if (d.user && d.user.activity) parts.push('[activity] ' + d.user.activity + (d.user.intent ? ' — ' + d.user.intent : ''));
  if (d.signals && typeof d.signals.frustration === 'number') {
    parts.push(`[signals] frustration ${Math.round(d.signals.frustration * 100)}% · confusion ${Math.round(d.signals.confusion * 100)}% · engagement ${Math.round(d.signals.engagement * 100)}%`);
  }
  if (Array.isArray(d.keyElements) && d.keyElements.length) {
    parts.push('[elements] ' + d.keyElements.map((k) => `${k.element} "${k.label || '?'}"`).slice(0, 8).join(' · '));
  }
  if (Array.isArray(d.recommendations) && d.recommendations.length) {
    parts.push('\n[recommendations]');
    for (const r of d.recommendations.slice(0, 5)) parts.push('  - ' + r);
  }
  if (d.promptInjection && d.promptInjection.detected) parts.push('[!] potential prompt injection detected on page');
  if (d.privacy && d.privacy.sensitiveVisible) parts.push('[!] sensitive content visible in screenshot');
  if (Array.isArray(d.anomalies) && d.anomalies.length) parts.push('[anomalies] ' + d.anomalies.join(', '));
  if (res.model) parts.push('\n(' + res.provider + ' · ' + res.model + ')');
  ans.textContent = parts.join('\n');
}

async function runTask(task) {
  if (!task || !task.trim()) return;
  const btn = $('btnTask');
  btn.disabled = true;
  btn.textContent = 'Running…';
  const out = $('taskResult');
  out.style.display = 'block';
  out.textContent = 'Looking at the page…';
  try {
    const res = await send({ type: MSG.RUN_TASK, task, opts: { maxSteps: 6 } });
    if (res.error) {
      out.textContent = 'Error: ' + res.error;
      return;
    }
    const lines = [];
    for (const s of res.steps || []) {
      const a = s.action || {};
      lines.push(`step ${s.step}: ${a.type || '?'}${a.ref ? ' → ' + a.ref : ''}${a.value != null ? ' value="' + (a.value.length > 24 ? a.value.slice(0, 24) + '…' : a.value) + '"' : ''}  ${s.reasoning || ''}`);
    }
    if (res.done) {
      lines.push('\n✓ Task complete: ' + (res.result || ''));
    } else if (res.error) {
      lines.push('\n✗ Task failed: ' + res.error);
    } else {
      lines.push('\n✗ No progress: ' + (res.result || ''));
    }
    out.textContent = lines.join('\n');
    $('taskInput').value = '';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Run';
    refresh();
  }
}

async function analyzePage() {
  const btn = $('btnReport');
  btn.disabled = true;
  const out = $('taskResult');
  out.style.display = 'block';
  out.textContent = 'Building page report…';
  try {
    const res = await send({ type: MSG.ANALYZE_PAGE, withVision: false });
    if (res.error) {
      out.textContent = 'Error: ' + res.error;
      return;
    }
    const r = res.report || {};
    const d = r.data || {};
    const lines = [r.body || '', ''];
    if (Array.isArray(d.actions) && d.actions.length) {
      lines.push('[actions]');
      for (const a of d.actions.slice(0, 10)) lines.push(`  - ${a.label}${a.description ? ' (' + a.description + ')' : ''}`);
    }
    if (Array.isArray(d.forms) && d.forms.length) {
      lines.push('[forms]');
      for (const f of d.forms.slice(0, 6)) lines.push(`  - ${f.purpose || 'form'}: ${f.fields || ''}${f.risk === 'sensitive' ? ' [sensitive]' : ''}`);
    }
    if (Array.isArray(d.issues) && d.issues.length) {
      lines.push('[issues]');
      for (const i of d.issues.slice(0, 6)) lines.push(`  - [${i.severity}] ${i.title}: ${i.detail || ''}`);
    }
    if (Array.isArray(d.recommendations) && d.recommendations.length) {
      lines.push('[recommendations]');
      for (const rc of d.recommendations.slice(0, 6)) lines.push('  - ' + rc);
    }
    if (d.stats) {
      lines.push(`[stats] ${d.stats.interactive} interactive · ${d.stats.buttons} buttons · ${d.stats.inputs} inputs · ${d.stats.links} links · ${d.stats.tables} tables`);
    }
    out.textContent = lines.join('\n');
  } finally {
    btn.disabled = false;
    refresh();
  }
}

async function runDigest(period) {
  const res = await send({ type: MSG.RUN_DIGEST, period });
  toast(res.ok ? (period === 'weekly' ? 'Weekly digest generated' : 'Daily digest generated') : 'Digest failed: ' + (res.error || ''));
  refresh();
}

// ---- chatbot ---------------------------------------------------------------
function addChatBubble(role, text, meta) {
  const log = $('chatLog');
  const b = el('div', { class: 'chat-bubble ' + (role === 'user' ? 'user' : 'bot'), text });
  if (meta) b.appendChild(el('div', { class: 'chat-meta', text: meta }));
  log.appendChild(b);
  log.scrollTop = log.scrollHeight;
  return b;
}

async function sendChat(message) {
  const text = String(message || '').trim();
  if (!text) return;
  addChatBubble('user', text);
  $('chatInput').value = '';
  const btn = $('btnChat');
  btn.disabled = true;
  const bubble = addChatBubble('bot', '…');
  try {
    const res = await send({ type: MSG.CHAT, message: text });
    bubble.textContent = res.reply || res.error || 'no response';
    if (res.model) bubble.appendChild(el('div', { class: 'chat-meta', text: `${res.provider || ''} · ${res.model || ''}` }));
  } catch (e) {
    bubble.textContent = 'Error: ' + e.message;
  } finally {
    btn.disabled = false;
    refresh();
  }
}

// ---- abilities browser -------------------------------------------------------
async function loadAbilities() {
  const res = await send({ type: MSG.LIST_ABILITIES });
  const list = res.abilities || [];
  $('abilCount').textContent = list.length ? `${list.length} skills` : '…';
  const body = $('abilitiesBody');
  body.innerHTML = '';
  for (const cat of ['read', 'write', 'agent', 'meta']) {
    const items = list.filter((a) => a.category === cat);
    if (!items.length) continue;
    body.appendChild(el('div', { class: 'abil-cat', text: `${cat} — ${items.length}` }));
    for (const a of items) body.appendChild(abilityCard(a));
  }
}

function abilityCard(a) {
  const card = el('div', { class: 'abil-card' });
  const head = el('div', { class: 'row' });
  head.appendChild(el('h4', { text: a.name }));
  const runBtn = el('button', { class: 'primary pill-btn', style: 'margin-left:auto;font-size:10px;padding:2px 8px', text: 'Run' });
  head.appendChild(runBtn);
  card.appendChild(head);
  card.appendChild(el('p', { text: a.description }));
  const argsBox = el('div', { class: 'abil-args' });
  const inputs = [];
  for (const arg of a.args || []) {
    if (arg.type === 'object') continue;
    const inp = el('input', { class: 'grow mono', type: 'text', placeholder: (arg.required ? '*' : '') + (arg.name || '') + ' — ' + (arg.desc || '') });
    inputs.push({ inp, arg });
    const row = el('label', { class: 'row', style: 'gap:6px;font-size:11px;align-items:center' }, [
      el('span', { style: 'min-width:64px', text: arg.name }),
      inp,
    ]);
    argsBox.appendChild(row);
  }
  card.appendChild(argsBox);
  const out = el('div', { class: 'muted', style: 'font-size:11px;white-space:pre-wrap;display:none' });
  card.appendChild(out);
  runBtn.addEventListener('click', () => runAbilityAction(a, inputs, out, runBtn));
  return card;
}

async function runAbilityAction(a, inputs, out, btn) {
  const args = {};
  for (const { inp, arg } of inputs) {
    const v = inp.value.trim();
    if (v === '') continue;
    if (arg.type === 'number') args[arg.name] = Number(v);
    else if (arg.type === 'boolean') args[arg.name] = v === 'true' || v === '1' || v === 'yes';
    else args[arg.name] = v;
  }
  const missing = (a.args || []).filter((ar) => ar.required && (args[ar.name] == null || args[ar.name] === ''));
  out.style.display = 'block';
  if (missing.length) {
    out.textContent = 'Missing required argument(s): ' + missing.map((m) => m.name).join(', ');
    return;
  }
  btn.disabled = true;
  out.textContent = 'Running…';
  try {
    const res = await send({ type: MSG.RUN_ABILITY, ability: a.id, args });
    out.textContent = formatAbilityResult(res);
    toast(`ability "${a.id}" ${res.ok ? 'ok' : 'failed'}`);
  } catch (e) {
    out.textContent = 'Error: ' + e.message;
  } finally {
    btn.disabled = false;
    refresh();
  }
}

function formatAbilityResult(res) {
  if (!res.ok) return '✗ ' + (res.error || 'failed');
  const lines = [];
  if (res.summary) lines.push(res.summary);
  if (res.description) lines.push(res.description);
  if (Array.isArray(res.filled) && res.filled.length) {
    lines.push(`Filled ${res.filledCount} field(s)` + (res.generated ? ' (auto-generated test data)' : ''));
    for (const f of res.filled) lines.push(`  ${f.ref} ${f.key} = ${f.value}`);
    if (res.unmatched && res.unmatched.length) lines.push('unmatched: ' + res.unmatched.join(', '));
  }
  if (Array.isArray(res.plan) && res.plan.length) lines.push(res.plan.join('\n'));
  if (Array.isArray(res.issues) && res.issues.length) lines.push(res.issues.slice(0, 8).map((i) => `[${i.severity}] ${i.title}`).join('\n'));
  if (Array.isArray(res.steps) && res.steps.length) {
    lines.push(res.steps.map((s) => `step ${s.step}: ${(s.action && s.action.type) || '?'} ${(s.action && s.action.ref) || ''} ${s.ok === false ? '✗ ' + (s.error || '') : s.ok ? '✓' : ''}`.trim()).join('\n') + (res.result ? '\n→ ' + res.result : ''));
  }
  if (res.passed != null) lines.push(`\npassed ${res.passed} · failed ${res.failed}`);
  if (res.report) lines.push('\n' + String(res.report).slice(0, 1600));
  if (res.sources && res.sources.length) lines.push(`\n${res.sources.length} sources${res.live ? ' (live search)' : ' (offline)'}`);
  if (res.tools && res.tools.length) lines.push('tools: ' + res.tools.join(', '));
  if (res.tabs && res.tabs.length) lines.push(res.tabs.slice(0, 10).map((t) => `  [${t.index}]${t.active ? '▶' : ' '} ${t.title || t.url}`).join('\n'));
  if (res.events && res.events.length) lines.push(res.events.slice(0, 10).map((e) => `  ${e.type} ${e.url}`).join('\n'));
  if (res.diffScore != null) lines.push(`diff ${Math.round(res.diffScore * 100)}%`);
  if (res.reply) lines.push(res.reply);
  if (res.abilities) lines.push(`${res.count} abilities available`);
  if (res.count != null && !res.abilities && !lines.length) lines.push(`${res.count} result(s)`);
  if (res.model) lines.push('\n(' + (res.provider || '') + ' · ' + res.model + ')');
  return lines.join('\n') || 'done';
}

function askPreset(key) {
  const prompt = PRESETS[key];
  if (!prompt) return;
  $('askInput').value = prompt;
  askAgent();
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
  $('btnAsk').addEventListener('click', askAgent);
  $('askInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') askAgent();
  });
  $('btnDigest').addEventListener('click', () => runDigest('daily'));
  $('btnDigestWeekly').addEventListener('click', () => runDigest('weekly'));
  $('btnPreset1').addEventListener('click', () => askPreset('Preset1'));
  $('btnPreset2').addEventListener('click', () => askPreset('Preset2'));
  $('btnPreset3').addEventListener('click', () => askPreset('Preset3'));
  $('btnScan').addEventListener('click', scanPage);
  $('btnTask').addEventListener('click', () => runTask($('taskInput').value));
  $('taskInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runTask($('taskInput').value);
  });
  $('btnChat').addEventListener('click', () => sendChat($('chatInput').value));
  $('chatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChat($('chatInput').value);
  });
  document.querySelectorAll('.chip[data-chip]').forEach((c) =>
    c.addEventListener('click', () => sendChat(c.getAttribute('data-chip')))
  );
  $('btnToggleAbilities').addEventListener('click', () => {
    const body = $('abilitiesBody');
    const show = body.classList.toggle('hidden');
    $('btnToggleAbilities').textContent = show ? 'Show' : 'Hide';
    if (!show && !body.childElementCount) loadAbilities();
  });
  $('btnTaskPreset1').addEventListener('click', () => runTask('click the first button'));
  $('btnTaskPreset2').addEventListener('click', () => runTask('type "hello" into the first input field'));
  $('btnTaskPreset3').addEventListener('click', () => runTask('scroll down'));
  $('btnReport').addEventListener('click', analyzePage);
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
