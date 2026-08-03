/**
 * scripts/capture-demo.mjs — regenerate the dashboard screenshots in demo/.
 *
 * Starts the receiver server on a fresh database, seeds it with realistic demo
 * telemetry (sessions, events, attention timeline, heatmap clicks, screenshots,
 * heuristic + agent insights), then drives headless Chrome through every
 * dashboard tab and captures demo/dash-<tab>.png.
 *
 * Requires: npm install (puppeteer-core) and a system Chrome.
 * Run:      npm run demo:capture
 */
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import puppeteer from 'puppeteer-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEMO = join(ROOT, 'demo');
const DATA = join(ROOT, 'data');
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const PORT = Number(process.env.PORT || 8792);
const BASE = `http://127.0.0.1:${PORT}`;
const now = Date.now();
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const at = (hAgo, m = 0) => now - Math.round(hAgo * HOUR) - m * MIN;

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} -> ${res.status}`);
  return res.json();
}

async function startServer() {
  rmSync(join(DATA, 'telemetry.db'), { force: true });
  rmSync(join(DATA, 'telemetry.db-wal'), { force: true });
  rmSync(join(DATA, 'telemetry.db-shm'), { force: true });
  rmSync(join(DATA, 'screenshots'), { recursive: true, force: true });
  const server = spawn(process.execPath, [join(ROOT, 'server', 'server.mjs')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(d));
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return { server };
    } catch {}
    await sleep(200);
  }
  server.kill('SIGKILL');
  throw new Error('server did not boot');
}

/* --------------------------------- seeding ------------------------------- */

const TITLES = {
  'github.com': 'GitHub — Build software better, together',
  'stackoverflow.com': 'Stack Overflow — Where developers learn',
  'docs.google.com': 'Google Docs — work notes',
  'notion.so': 'Notion — workspace',
  'slack.com': 'Slack — team chat',
  'youtube.com': 'YouTube — watch later queue',
  'reddit.com': 'Reddit — r/programming',
  'google.com': 'Google Search — visual ai agent',
  'developer.mozilla.org': 'MDN — Web docs',
};

const SESSIONS = ['demo-a1b2', 'demo-c3d4', 'demo-e5f6', 'demo-g7h8'];
const titles = (url) => {
  try {
    const h = new URL(url).hostname.replace(/^www\./, '');
    return TITLES[h] || `Page on ${h}`;
  } catch {
    return 'Page';
  }
};

function seedSessions() {
  const sessions = [
    { id: 'demo-a1b2', startedAt: at(9.2), endedAt: at(0.6), durationMs: 8.6 * HOUR, events: 214, pageCount: 26, errors: 3, rageClicks: 12, deviceId: 'd1', userId: 'u1', focus: { score: 0.68 } },
    { id: 'demo-c3d4', startedAt: at(26), endedAt: at(23), durationMs: 3 * HOUR, events: 97, pageCount: 14, errors: 1, rageClicks: 4, deviceId: 'd1', userId: 'u1', focus: { score: 0.71 } },
    { id: 'demo-e5f6', startedAt: at(50), endedAt: at(47), durationMs: 3.2 * HOUR, events: 88, pageCount: 11, errors: 0, rageClicks: 2, deviceId: 'd2', userId: 'u1', focus: { score: 0.55 } },
    { id: 'demo-g7h8', startedAt: at(74), endedAt: at(70), durationMs: 4 * HOUR, events: 121, pageCount: 18, errors: 2, rageClicks: 6, deviceId: 'd2', userId: 'u2', focus: { score: 0.62 } },
  ];
  return post('/api/sessions', {
    sessions: sessions.map((s) => ({ ...s, payload: { kind: 'session', focus: { score: s.focus } } })),
  });
}

function seedTodayActivity() {
  // page_view segments over the day drive the attention bars + distraction budget
  const timeline = [
    [9.5, 'https://github.com/vaia'],
    [8.75, 'https://github.com/vaia/pulls'],
    [8.0, 'https://stackoverflow.com/questions/…'],
    [7.25, 'https://docs.google.com/document/d/vaia'],
    [6.5, 'https://www.youtube.com/watch?v=…'],
    [6.0, 'https://www.reddit.com/r/programming/…'],
    [5.33, 'https://www.google.com/search?q=visual+ai+agent'],
    [4.58, 'https://github.com/vaia/issues'],
    [3.83, 'https://www.notion.so/vaia-workspace'],
    [3.08, 'https://slack.com/team/vaia'],
    [2.33, 'https://www.youtube.com/watch?v=…'],
    [1.83, 'https://github.com/vaia/releases'],
    [1.17, 'https://developer.mozilla.org/en-US/docs/Web'],
    [0.58, 'https://github.com/vaia'],
  ];
  const events = [];
  let idx = 0;
  for (const [hAgo, url] of timeline) {
    events.push({
      id: randomUUID(),
      ts: at(hAgo),
      type: 'page_view',
      sessionId: 'demo-a1b2',
      url,
      title: titles(url),
      data: { url, cat: 'nav' },
    });
    if (++idx % 2 === 0) {
      events.push({
        id: randomUUID(),
        ts: at(hAgo) + 3 * MIN,
        type: idx % 4 === 0 ? 'click' : 'mouse_down',
        sessionId: 'demo-a1b2',
        url,
        title: titles(url),
        data: { x: 60 + (idx * 37) % 700, y: 60 + (idx * 53) % 500, button: 0 },
      });
    }
  }
  // errors + form submits + keys for the events log and stats
  events.push(
    { id: randomUUID(), ts: at(2.0), type: 'error', sessionId: 'demo-a1b2', url: 'https://github.com/vaia', title: titles('https://github.com/vaia'), data: { message: 'Uncaught TypeError: Cannot read properties of undefined' } },
    { id: randomUUID(), ts: at(1.5), type: 'form_submit', sessionId: 'demo-a1b2', url: 'https://github.com/vaia', title: titles('https://github.com/vaia'), data: { action: '/submit' } },
    { id: randomUUID(), ts: at(1.2), type: 'key_down', sessionId: 'demo-a1b2', url: 'https://github.com/vaia', title: titles('https://github.com/vaia'), data: { key: '[REDACTED]' } },
    { id: randomUUID(), ts: at(0.9), type: 'visibility', sessionId: 'demo-a1b2', url: 'https://github.com/vaia', title: titles('https://github.com/vaia'), data: { state: 'visible' } }
  );
  return post('/api/events', { events });
}

function seedFocusTrend() {
  const events = [];
  const daily = [
    ['https://github.com/vaia', 'https://www.notion.so/vaia', 'https://www.youtube.com/watch?v=…', 'https://www.google.com/search?q=ext'],
    ['https://stackoverflow.com/questions/…', 'https://www.reddit.com/r/programming/…', 'https://github.com/vaia', 'https://developer.mozilla.org/en-US/docs'],
    ['https://docs.google.com/document/d/vaia', 'https://www.youtube.com/watch?v=…', 'https://github.com/vaia', 'https://slack.com/team/vaia'],
    ['https://github.com/vaia', 'https://www.notion.so/vaia', 'https://www.reddit.com/r/webdev/…', 'https://www.google.com/search?q=opcode'],
    ['https://slack.com/team/vaia', 'https://www.youtube.com/watch?v=…', 'https://github.com/vaia', 'https://developer.mozilla.org/en-US/docs'],
    ['https://github.com/vaia', 'https://www.google.com/search?q=cors', 'https://www.youtube.com/watch?v=…', 'https://stackoverflow.com/questions/…'],
    ['https://www.notion.so/vaia', 'https://github.com/vaia', 'https://www.youtube.com/watch?v=…', 'https://slack.com/team/vaia'],
  ];
  for (let d = 1; d <= 7; d++) {
    const urls = daily[d - 1];
    for (let k = 0; k < urls.length; k++) {
      const ts = now - d * DAY + (10 + k * 3) * HOUR;
      if (ts > now) continue;
      events.push({ id: randomUUID(), ts, type: 'page_view', sessionId: 'demo-c3d4', url: urls[k], title: titles(urls[k]), data: { url: urls[k], cat: 'nav' } });
    }
  }
  return post('/api/events', { events });
}

function seedHeatmap() {
  const clusters = [
    { pts: [[90, 50, 6], [86, 54, 3], [94, 47, 2]] }, // logo / top nav
    { pts: [[560, 110, 5], [554, 106, 2], [566, 114, 2]] }, // search box
    { pts: [[640, 420, 8], [636, 416, 3], [644, 424, 2]] }, // primary button
    { pts: [[150, 300, 4], [146, 296, 2], [154, 304, 2]] }, // sidebar links
    { pts: [[500, 560, 4], [496, 556, 2], [504, 564, 2]] }, // form fields
    { pts: [[300, 760, 3], [296, 756, 2], [304, 764, 1]] }, // footer
  ];
  const events = [];
  for (const c of clusters) {
    for (const [x, y, n] of c.pts) {
      for (let i = 0; i < n; i++) {
        events.push({
          id: randomUUID(),
          ts: at(2 + Math.random() * 6),
          type: i % 3 === 0 ? 'mouse_down' : 'click',
          sessionId: 'demo-a1b2',
          url: 'https://github.com/vaia',
          title: 'GitHub — Build software better, together',
          data: { x, y, button: 0 },
        });
      }
    }
  }
  for (let i = 0; i < 6; i++) {
    events.push({
      id: randomUUID(),
      ts: at(4 + Math.random() * 5),
      type: 'click',
      sessionId: 'demo-c3d4',
      url: 'https://www.google.com/search?q=demo',
      title: 'Google Search — demo',
      data: { x: 100 + Math.round(Math.random() * 1000), y: 100 + Math.round(Math.random() * 600), button: 0 },
    });
  }
  return post('/api/events', { events });
}

function seedScreenshots() {
  const files = readdirSync(DEMO).filter((f) => f.endsWith('.jpg')).sort();
  if (!files.length) return Promise.resolve();
  const shots = files.slice(0, 40).map((f, i) => {
    const id = f.replace(/\.jpg$/, '');
    const b64 = readFileSync(join(DEMO, f)).toString('base64');
    const reasons = ['scheduled', 'significant', 'rage_click', 'scheduled', 'manual'];
    return {
      id,
      ts: at(0.5 + i * 0.45),
      sessionId: 'demo-a1b2',
      url: 'http://127.0.0.1:8792/demo',
      reason: reasons[i % reasons.length],
      width: 1280,
      height: 800,
      mime: 'image/jpeg',
      dataUrl: `data:image/jpeg;base64,${b64}`,
    };
  });
  return post('/api/screenshots', { screenshots: shots });
}

function seedInsights() {
  const heuristic = [
    { kind: 'heuristic', type: 'rage_clicks', title: 'Rage click spike', body: '9 rapid clicks on the #submit button in 11s — the button likely does nothing visible.', signal: 'negative', confidence: 0.92 },
    { kind: 'heuristic', type: 'error_spike', title: 'Error spike detected', body: '4 console errors within 90s around the payments flow (TypeError in checkout.js).', signal: 'negative', confidence: 0.87 },
    { kind: 'heuristic', type: 'form_abandonment', title: 'Form abandonment', body: 'User left the signup form after filling 3 of 6 fields and never returned.', signal: 'hesitation', confidence: 0.78 },
    { kind: 'heuristic', type: 'dead_click', title: 'Dead click on sidebar', body: '"Learn more" links in the sidebar never navigated across 3 visits.', signal: 'hesitation', confidence: 0.71 },
    { kind: 'heuristic', type: 'scroll_spike', title: 'Scroll spike on docs page', body: 'Rapid 3x page-height scroll right after load — typical of scanning.', signal: 'hesitation', confidence: 0.6 },
    { kind: 'heuristic', type: 'session_digest', title: 'Session digest — focus 68%', body: '2h 12m on work sites, 42m neutral, 26m distraction. Most productive between 10:00 and 13:00.', signal: 'positive', confidence: 0.9 },
    { kind: 'heuristic', type: 'weekly_digest', title: 'Weekly digest — 14h 6m attention', body: '7 sessions · 92 pages · focus held at 63% this week. Top work site: github.com.', signal: 'positive', confidence: 0.95 },
  ];
  const agent = [
    {
      kind: 'agent', type: 'chat_turn', title: 'Chat', body: 'What is this page about?',
      message: 'What is this page about?',
      reply: 'This is the VAIA activity demo page — a small playground that exercises the Visual AI Agent extension with buttons, a form, and a link. It is served by the bundled receiver so the agent can run against it.',
      provider: 'mock', model: 'mock-chat',
    },
    {
      kind: 'agent', type: 'agent_ability', title: 'page_forms', body: 'form inspection on the demo page',
      ok: true, ability: 'page_forms', category: 'read',
      result: { text: '1 form found (action=/submit) with fields: q (search), email (email), password (sensitive). Fields are correctly marked as sensitive and masked.' },
    },
    {
      kind: 'agent', type: 'agent_ability', title: 'fill_form', body: 'auto-filled the demo form',
      ok: true, ability: 'fill_form', category: 'write', filledCount: 2, generated: true,
      result: { filledCount: 2, filled: [{ ref: 'f1', key: 'q', value: 'visual ai agent' }, { ref: 'f2', key: 'email', value: 'test@example.com' }] },
    },
    {
      kind: 'agent', type: 'research_report', title: 'deep_research — "visual ai agents"', body: 'cited offline report (2 sources)',
      ok: true, ability: 'deep_research', category: 'agent', reportChars: 812,
      result: {
        report: 'Visual AI agents combine a vision model with computer-use tools to act inside a browser or desktop. Operators (OpenAI, Anthropic) run look-decide-act loops against screenshots; browser extensions like VAIA translate the same loop to the DOM, staying local-first.',
        sources: [
          { title: 'Anthropic — computer use tool', url: 'https://docs.anthropic.com/computer-use', synthetic: true },
          { title: 'Browser-use — AI browser automation', url: 'https://github.com/browser-use/browser-use', synthetic: true },
        ],
      },
    },
    {
      kind: 'agent', type: 'agent_ability', title: 'run_js', body: 'evaluated a snippet in the page',
      ok: true, ability: 'run_js', category: 'write',
      result: { type: 'number', result: '42' },
    },
    {
      kind: 'agent', type: 'page_report', title: 'Page report — demo page', body: 'deep page understanding',
      ok: true,
      data: {
        stats: { interactive: 9, buttons: 3, inputs: 4, links: 2, tables: 0 },
        actions: [{ label: 'Go button', ref: 'el3' }, { label: 'Reload me link', ref: 'el6' }],
        forms: [{ purpose: 'demo form', fields: 'q, email, password', risk: 'sensitive' }],
        issues: [{ severity: 'medium', title: 'Password field present', detail: 'sensitive field must be masked (it is)' }],
        recommendations: ['Add aria-labels to icon-only buttons'],
      },
    },
    {
      kind: 'agent', type: 'task_run', title: 'Task — "click the first button"', body: 'computer-use loop finished',
      ok: true,
      data: {
        steps: [
          { step: 1, action: { type: 'digest' }, reasoning: 'snapshot the visible page', executed: { ok: true } },
          { step: 2, action: { type: 'click', ref: 'el1' }, reasoning: 'button #b1 is the first button', executed: { ok: true } },
          { step: 3, action: { type: 'done' }, reasoning: 'task complete', executed: { ok: true } },
        ],
      },
    },
  ];
  const insights = [
    ...heuristic.map((i, n) => ({ id: randomUUID(), ts: at(1 + n * 0.5), ...i })),
    ...agent.map((i, n) => ({ id: randomUUID(), ts: at(0.4 + n * 0.3), ...i })),
  ];
  return post('/api/insights', { insights });
}

/* ------------------------------ capture ----------------------------------- */

async function capture() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1280,900', '--no-first-run'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle0', timeout: 30000 });
    await sleep(900); // first render pass

    const tabs = ['today', 'events', 'insights', 'agent', 'sessions', 'screenshots', 'heatmap'];
    for (const tab of tabs) {
      await page.click(`button[data-tab="${tab}"]`).catch(async () => {
        await page.evaluate((t) => {
          const b = document.querySelector(`button[data-tab="${t}"]`);
          if (b) b.click();
        }, tab);
      });
      if (tab === 'heatmap') {
        // the heatmap canvas is only sized while its tab is visible, so re-render
        await page.evaluate(() => refresh());
      }
      await sleep(tab === 'heatmap' ? 700 : 550);
      await page.screenshot({ path: join(DEMO, `dash-${tab}.png`) });
      console.log(`  saved demo/dash-${tab}.png`);
    }
  } finally {
    await browser.close();
  }
}

async function main() {
  if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME} — set CHROME env var`);
  console.log('[demo] starting server on :' + PORT + ' …');
  const { server } = await startServer();
  try {
    console.log('[demo] seeding sessions …');
    await seedSessions();
    console.log('[demo] seeding today activity + focus trend …');
    await seedTodayActivity();
    await seedFocusTrend();
    console.log('[demo] seeding heatmap clicks …');
    await seedHeatmap();
    console.log('[demo] seeding screenshots …');
    await seedScreenshots();
    console.log('[demo] seeding insights …');
    await seedInsights();
    await sleep(300);
    console.log('[demo] capturing dashboard tabs …');
    await capture();
  } finally {
    server.kill('SIGKILL');
  }
  console.log('[demo] done.');
}

main().catch((e) => {
  console.error('[demo] FAILED:', e.message);
  process.exit(1);
});
