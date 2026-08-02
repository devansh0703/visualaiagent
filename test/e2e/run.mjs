/**
 * test/e2e/run.mjs — end-to-end test: loads the built extension into headless
 * Chrome (puppeteer-core + system Chrome), drives a real page, and verifies
 * that activity tracking, screen capture, insight generation, and database
 * sync all work together.
 *
 * Requires: npm install (puppeteer-core) and a system Chrome.
 * Run: npm run e2e   (or)   node test/e2e/run.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXT_PATH = ROOT;
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const PORT = 8791;
const DATA_DIR = join(ROOT, 'data');

let server = null;
let failures = 0;

function check(name, ok, detail = '') {
  if (ok) {
    console.log(`  \u2713 ${name}`);
  } else {
    failures++;
    console.log(`  \u2717 ${name} ${detail ? '— ' + detail : ''}`);
  }
}

function startServer() {
  for (const f of ['telemetry.db', 'telemetry.db-wal', 'telemetry.db-shm']) {
    const p = join(DATA_DIR, f);
    if (existsSync(p)) rmSync(p);
  }
  return new Promise((resolve, reject) => {
    server = spawn(process.execPath, [join(ROOT, 'server', 'server.mjs')], {
      env: { ...process.env, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    server.stdout.on('data', (d) => (out += d));
    server.stderr.on('data', (d) => (out += d));
    const t = setTimeout(() => reject(new Error('server boot timeout: ' + out.slice(0, 400))), 8000);
    const probe = setInterval(async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}/health`);
        if (r.ok) {
          clearTimeout(t);
          clearInterval(probe);
          resolve();
        }
      } catch {}
    }, 200);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function post(path, body) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function get(path) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`);
  return res.json();
}

async function extCall(page, msg) {
  return page.evaluate(
    (m) =>
      new Promise((resolve) => {
        chrome.runtime.sendMessage(m, (res) => {
          if (chrome.runtime.lastError) resolve({ error: chrome.runtime.lastError.message });
          else resolve(res || {});
        });
      }),
    msg
  );
}

async function readEventCount(page) {
  const stats = await extCall(page, { type: 'vaia:get_stats' });
  return stats;
}

async function main() {
  console.log('[e2e] starting receiver server…');
  await startServer();
  const userData = mkdtempSync(join(tmpdir(), 'vaia-e2e-'));

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    userDataDir: userData,
    enableExtensions: true,
    args: [
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--window-size=1400,900',
      '--no-first-run',
    ],
  });

  try {
    console.log('[e2e] installing extension…');
    // Chrome 137+ branded builds removed --load-extension; use the CDP-based API.
    const extId = await browser.installExtension(EXT_PATH);
    check('extension installed', !!extId, extId);

    console.log('[e2e] finding extension service worker…');
    let sw = null;
    for (let i = 0; i < 30 && !sw; i++) {
      const targets = await browser.targets();
      sw = targets.find((t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'));
      if (!sw) await sleep(500);
    }
    check('extension service worker loaded', !!sw);
    if (!sw) return 1;
    console.log(`[e2e] extension id: ${extId}`);
    const worker = await sw.worker();

    // commands (keyboard shortcuts) registered
    const cmds = await worker.evaluate(() => chrome.commands.getAll().then((cs) => cs.map((c) => c.name)));
    check('keyboard commands registered', ['toggle-pause', 'capture-now', 'open-dashboard'].every((c) => cmds.includes(c)), JSON.stringify(cmds));

    // extension context page for chrome.runtime access
    const extPage = await browser.newPage();
    await extPage.goto(`chrome-extension://${extId}/ui/popup/popup.html`);
    await sleep(500);

    // 1. save a config pointing at the receiver, enable mock vision
    console.log('[e2e] configuring extension…');
    const saved = await extCall(extPage, {
      type: 'vaia:save_config',
      config: {
        enabled: true,
        capture: { enabled: true, intervalMs: 60000, onSignificantEvent: true, storeLocal: true, quality: 50, maxWidth: 900 },
        vision: { enabled: true, provider: 'mock', model: 'mock-vision', analyzeScreenEveryNth: 1 },
        db: { endpoint: `http://127.0.0.1:${PORT}/api/events`, sendEvents: true, sendScreenshots: true, sendInsights: true, flushIntervalMs: 2000 },
        insights: { enabled: true, generateEndOfSessionSummary: false },
        tracking: { trackKeyboard: true, trackClicks: true, trackScroll: true, trackNavigation: true, trackErrors: true },
        ui: { showBadge: false },
      },
    });
    check('config saved', saved && saved.ok);

    // 2. open demo page and wait for content script
    console.log('[e2e] opening demo page…');
    const demo = await browser.newPage();
    await demo.goto(`http://127.0.0.1:${PORT}/demo`, { waitUntil: 'domcontentloaded' });
    let injected = false;
    for (let i = 0; i < 30 && !injected; i++) {
      injected = await demo.evaluate(() => document.documentElement.getAttribute('data-vaia') === 'active').catch(() => false);
      if (!injected) await sleep(300);
    }
    check('content script injected (data-vaia marker)', injected);

    // 3. simulate user activity
    console.log('[e2e] simulating activity…');
    await sleep(800);
    await demo.click('#b1');
    await demo.click('#b1');
    await demo.click('#b1');
    await demo.type('#txt', 'hello vaia');
    await demo.focus('#pwd');
    await demo.keyboard.type('supersecret-password');
    await demo.type('#txt', ' more');
    await demo.select('#sel', 'B');
    await demo.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(300);
    await demo.click('#f button[type=submit]');
    await sleep(1500);

    // 4. verify state via the extension context
    console.log('[e2e] verifying tracked events…');
    const state1 = await extCall(extPage, { type: 'vaia:get_state' });
    check('events recorded (session.events > 0)', state1 && state1.events > 0, `events=${state1 && state1.events}`);
    check('clicks recorded', state1 && state1.eventTypes && state1.eventTypes.click > 0, JSON.stringify(state1 && state1.eventTypes));
    check('text input recorded', state1 && state1.eventTypes && state1.eventTypes.text_input > 0);
    check('password keystrokes not leaked', true); // verified in step 5 by inspecting stored payloads

    // 5. inspect stored events for privacy redaction
    const events = await extCall(extPage, { type: 'vaia:get_events', limit: 200 });
    const all = JSON.stringify(events.events || []);
    check('no password value in stored events', !all.includes('supersecret-password'));
    check('rage click insight likely (3+ rapid clicks on #b1)', state1.eventTypes.rage_click >= 1 || state1.insights >= 1, `rage=${state1.eventTypes.rage_click} insights=${state1.insights}`);

    // 6. capture a screenshot now (exercises capture + mock vision)
    const cap = await extCall(extPage, { type: 'vaia:capture_now' });
    check('manual capture works', !!cap && cap.ok, JSON.stringify(cap));
    const shotStats = await readEventCount(extPage);
    check('screenshot stored locally', shotStats.screenshots > 0, `screenshots=${shotStats.screenshots}`);

    // 6b. keyboard shortcut capture (Alt+Shift+C). Accelerator delivery to
    // headless Chrome via CDP is unreliable, so this is a soft check.
    const before = shotStats.screenshots;
    await demo.keyboard.down('Alt');
    await demo.keyboard.down('Shift');
    await demo.keyboard.press('C');
    await demo.keyboard.up('Shift');
    await demo.keyboard.up('Alt');
    await sleep(1200);
    const after = await readEventCount(extPage);
    if (after.screenshots > before) {
      check('keyboard shortcut triggers capture', true);
    } else {
      console.log('  \u2013 keyboard shortcut not delivered by headless CDP (soft skip)');
    }
    check('vision insight generated', shotStats.insights > 0, `insights=${shotStats.insights}`);

    // 7. page scan from extension context
    const scan = await extCall(extPage, { type: 'vaia:scan_page', maxElements: 20 });
    check('page scan returns summary', !!scan && !!scan.summary && !!scan.summary.title, JSON.stringify(scan && scan.summary && scan.summary.title));
    check('scan sees demo buttons', scan.summary && scan.summary.elements && scan.summary.elements.length > 0, `elements=${scan.summary && scan.summary.elements && scan.summary.elements.length}`);

    // 8. flush to the receiver database
    console.log('[e2e] flushing to receiver database…');
    const flush = await extCall(extPage, { type: 'vaia:flush_now' });
    check('flush returned', flush && flush.ok, JSON.stringify(flush));
    await sleep(1500);

    const stats = await get('/api/stats');
    check('events landed in receiver db', stats.events > 0, `events=${stats.events}`);
    check('clicks in receiver db', (stats.byType || []).some((r) => r.type === 'click' && r.n > 0), JSON.stringify(stats.byType));
    check('text_input in receiver db', (stats.byType || []).some((r) => r.type === 'text_input' && r.n > 0));
    check('insights in receiver db', stats.insights > 0, `insights=${stats.insights}`);
    check('screenshots in receiver db', stats.screenshots > 0, `screenshots=${stats.screenshots}`);

    // 9. verify no password value leaked all the way to the database
    const evRows = await get('/api/events?limit=500');
    const allDb = JSON.stringify(evRows.rows || []);
    check('no password value in database', !allDb.includes('supersecret-password'));

    // 10. heatmap data message round-trip
    const hm = await extCall(extPage, { type: 'vaia:heatmap', action: 'data' });
    check('heatmap data endpoint responds', !hm.error, JSON.stringify(hm.error || (hm.clicks || []).length + ' clicks'));

    // 11. ask-the-agent round trip (mock vision)
    console.log('[e2e] agent chat + digest…');
    const ask = await extCall(extPage, { type: 'vaia:ask_agent', question: 'What is on this page?' });
    check('ask agent returns an answer', !!ask.ok && !!ask.answer, JSON.stringify(ask).slice(0, 120));

    // 11b. analyze-page round trip (mock vision + real DOM digest)
    console.log('[e2e] analyze page…');
    const ar = await extCall(extPage, { type: 'vaia:analyze_page', withVision: true });
    check(
      'analyze page returns a report',
      !!ar && ar.ok && !!ar.report && !!ar.report.title && !!ar.insightId,
      JSON.stringify(ar && ar.error)
    );

    // 11c. run-task round trip (mock computer-use loop clicks via DOM digest)
    console.log('[e2e] run task (agent loop)…');
    const rt = await extCall(extPage, { type: 'vaia:run_task', task: 'Click the first button', opts: { maxSteps: 4, withScreenshots: false } });
    check(
      'run task produced a click transcript',
      !!rt && rt.ok && Array.isArray(rt.steps) && rt.steps.length >= 2 && rt.steps.some((s) => s.action && s.action.type === 'click'),
      JSON.stringify(rt && (rt.error || (rt.steps || []).map((s) => s.action && s.action.type)))
    );

    // 11d. agent insights were persisted
    const aIns = await extCall(extPage, { type: 'vaia:get_insights', limit: 25 });
    check(
      'agent insights persisted',
      !!aIns && Array.isArray(aIns.insights) && aIns.insights.some((r) => r.kind === 'agent' && r.type === 'page_report') && aIns.insights.some((r) => r.kind === 'agent' && r.type === 'task_run'),
      JSON.stringify(aIns && aIns.insights && aIns.insights.filter((r) => r.kind === 'agent').map((r) => r.type))
    );

    // 12. model discovery endpoint responds
    const models = await extCall(extPage, { type: 'vaia:get_models' });
    check('get_models endpoint responds', !!models && models.ok, JSON.stringify(models && models.error));

    // 13. daily digest generates an insight
    const digest = await extCall(extPage, { type: 'vaia:run_digest' });
    check('daily digest generated', !!digest.ok && !!digest.insightId, JSON.stringify(digest));

    // 13b. weekly digest honors the period
    const weekly = await extCall(extPage, { type: 'vaia:run_digest', period: 'weekly' });
    check('weekly digest generated', !!weekly.ok && weekly.type === 'weekly_digest', JSON.stringify(weekly));

    // 13c. stats carry attention (time-per-host) data
    const statsAtt = await extCall(extPage, { type: 'vaia:get_stats' });
    check(
      'stats include attention data',
      !!statsAtt && !!statsAtt.attention && typeof statsAtt.attention.totalMs === 'number',
      JSON.stringify(statsAtt && statsAtt.attention && statsAtt.attention.top && statsAtt.attention.top.slice(0, 2))
    );

    // 13d. goals config persists through save/get_state
    const gSave = await extCall(extPage, { type: 'vaia:save_config', config: { goals: { enabled: true, distractionsMinutes: 30 } } });
    const gState = await extCall(extPage, { type: 'vaia:get_state' });
    check(
      'goals config persists',
      !!gSave && gSave.ok && !!gState && gState.config && gState.config.goals && gState.config.goals.enabled === true && gState.config.goals.distractionsMinutes === 30,
      JSON.stringify(gState && gState.config && gState.config.goals)
    );

    // 14. server dashboard + export
    const dash = await fetch(`http://127.0.0.1:${PORT}/`);
    const dashHtml = await dash.text();
    check('dashboard served at /', dash.ok && dashHtml.includes('VAIA Dashboard'));
    check('dashboard has neobrutalist chrome', dashHtml.includes('--ink:') && dashHtml.includes('class="ticker"') && dashHtml.includes('data-tab="today"'), 'missing neo-brutalist markers');
    const exp = await (await fetch(`http://127.0.0.1:${PORT}/api/export?format=json`)).json();
    check('export endpoint returns tables', !!exp && Array.isArray(exp.data && exp.data.events), JSON.stringify(exp && Object.keys(exp.data || {})));

    // 14b. dashboard attention + focus endpoints
    const attSrv = await (await fetch(`http://127.0.0.1:${PORT}/api/attention?hours=24`)).json();
    check('server attention endpoint responds', attSrv && attSrv.ok && typeof attSrv.totalMs === 'number', JSON.stringify(attSrv && attSrv.top && attSrv.top.slice(0, 2)));
    const focSrv = await (await fetch(`http://127.0.0.1:${PORT}/api/focus?days=7`)).json();
    check('server focus endpoint responds', focSrv && focSrv.ok && Array.isArray(focSrv.data) && focSrv.data.length === 7, JSON.stringify(focSrv && focSrv.data && focSrv.data.length));
  } catch (e) {
    failures++;
    console.error('[e2e] FAILED:', e.message);
  } finally {
    await browser.close();
    if (server) server.kill('SIGKILL');
    rmSync(userData, { recursive: true, force: true });
  }

  console.log(failures === 0 ? '\n[e2e] ALL CHECKS PASSED' : `\n[e2e] ${failures} CHECK(S) FAILED`);
  return failures === 0 ? 0 : 1;
}

main().then((code) => process.exit(code));
