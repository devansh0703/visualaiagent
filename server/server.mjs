/**
 * server.mjs — telemetry receiver database for the Visual AI Agent extension.
 *
 * Endpoints:
 *   POST /api/events        batch of telemetry events
 *   POST /api/screenshots   captured frames (base64) -> data/screenshots/*.jpg
 *   POST /api/insights      AI/heuristic insights
 *   POST /api/sessions      session records
 *   GET  /api/events|screenshots|insights|sessions|stats|heatmap
 *   GET  /demo              a small page for exercising the extension
 *   GET  /health
 *
 * Storage: SQLite (node:sqlite, built into Node >= 22.5) + filesystem for images.
 * Run:  node server/server.mjs   (PORT env var to change port, default 8787)
 */
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const SHOTS = join(DATA, 'screenshots');
mkdirSync(SHOTS, { recursive: true });

const db = new DatabaseSync(join(DATA, 'telemetry.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    ts INTEGER NOT NULL,
    type TEXT NOT NULL,
    session_id TEXT,
    user_id TEXT,
    device_id TEXT,
    url TEXT,
    title TEXT,
    payload TEXT NOT NULL,
    received_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
  CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
  CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
  CREATE TABLE IF NOT EXISTS screenshots (
    id TEXT PRIMARY KEY,
    ts INTEGER NOT NULL,
    session_id TEXT,
    url TEXT,
    reason TEXT,
    width INTEGER,
    height INTEGER,
    mime TEXT,
    path TEXT NOT NULL,
    received_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_shots_ts ON screenshots(ts);
  CREATE INDEX IF NOT EXISTS idx_shots_session ON screenshots(session_id);
  CREATE TABLE IF NOT EXISTS insights (
    id TEXT PRIMARY KEY,
    ts INTEGER NOT NULL,
    session_id TEXT,
    kind TEXT,
    type TEXT,
    title TEXT,
    body TEXT,
    signal TEXT,
    confidence REAL,
    payload TEXT,
    received_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_insights_ts ON insights(ts);
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    started_at INTEGER,
    ended_at INTEGER,
    duration_ms INTEGER,
    events INTEGER,
    page_count INTEGER,
    errors INTEGER,
    rage_clicks INTEGER,
    device_id TEXT,
    user_id TEXT,
    payload TEXT,
    received_at INTEGER NOT NULL
  );
`);

const insertEvent = db.prepare(`INSERT OR IGNORE INTO events (id, ts, type, session_id, user_id, device_id, url, title, payload, received_at) VALUES (?,?,?,?,?,?,?,?,?,?)`);
const insertShot = db.prepare(`INSERT OR IGNORE INTO screenshots (id, ts, session_id, url, reason, width, height, mime, path, received_at) VALUES (?,?,?,?,?,?,?,?,?,?)`);
const insertInsight = db.prepare(`INSERT OR IGNORE INTO insights (id, ts, session_id, kind, type, title, body, signal, confidence, payload, received_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
const insertSession = db.prepare(`INSERT OR IGNORE INTO sessions (id, started_at, ended_at, duration_ms, events, page_count, errors, rage_clicks, device_id, user_id, payload, received_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-api-key',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 200 * 1024 * 1024) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleEvents(req, res) {
  const raw = await readBody(req);
  const body = JSON.parse(raw || '{}');
  const list = Array.isArray(body) ? body : body.events || [];
  if (body.kind === 'ping') return json(res, 200, { ok: true, message: 'pong' });
  let inserted = 0;
  for (const ev of list) {
    if (!ev || !ev.id) continue;
    const payload = JSON.stringify(ev);
    const r = insertEvent.run(ev.id, ev.ts || Date.now(), String(ev.type || 'unknown').slice(0, 80), ev.sessionId || null, ev.userId || null, ev.deviceId || null, ev.url || null, ev.title || null, payload, Date.now());
    if (r.changes) inserted++;
  }
  json(res, 200, { ok: true, inserted, total: list.length });
}

async function handleScreenshots(req, res) {
  const raw = await readBody(req);
  const body = JSON.parse(raw || '{}');
  const list = body.screenshots || [];
  let saved = 0;
  for (const shot of list) {
    if (!shot || !shot.id) continue;
    let dataUrl = shot.dataUrl || '';
    let mime = shot.mime || 'image/jpeg';
    let ext = 'jpg';
    const m = /^data:([^;]+);base64,/.exec(dataUrl);
    if (m) {
      mime = m[1];
      if (mime.includes('png')) ext = 'png';
      dataUrl = dataUrl.slice(m[0].length);
    }
    const path = join(SHOTS, `${shot.id}.${ext}`);
    try {
      writeFileSync(path, Buffer.from(dataUrl, 'base64'));
    } catch (e) {
      json(res, 400, { ok: false, error: 'bad image data: ' + e.message });
      return;
    }
    const r = insertShot.run(shot.id, shot.ts || Date.now(), shot.sessionId || null, shot.url || null, shot.reason || null, shot.width || null, shot.height || null, mime, path, Date.now());
    if (r.changes) saved++;
  }
  json(res, 200, { ok: true, saved, total: list.length });
}

async function handleInsights(req, res) {
  const raw = await readBody(req);
  const body = JSON.parse(raw || '{}');
  const list = body.insights || [];
  let inserted = 0;
  for (const ins of list) {
    if (!ins || !ins.id) continue;
    const r = insertInsight.run(ins.id, ins.ts || Date.now(), ins.sessionId || null, ins.kind || null, ins.type || null, ins.title || null, ins.body || null, ins.signal || null, ins.confidence ?? null, JSON.stringify(ins), Date.now());
    if (r.changes) inserted++;
  }
  json(res, 200, { ok: true, inserted, total: list.length });
}

async function handleSessions(req, res) {
  const raw = await readBody(req);
  const body = JSON.parse(raw || '{}');
  const list = body.sessions || [];
  let inserted = 0;
  for (const s of list) {
    if (!s || !s.id) continue;
    const r = insertSession.run(s.id, s.startedAt || null, s.endedAt || null, s.durationMs || null, s.events || 0, s.pageCount || 0, s.errors || 0, s.rageClicks || 0, s.deviceId || null, s.userId || null, JSON.stringify(s), Date.now());
    if (r.changes) inserted++;
  }
  json(res, 200, { ok: true, inserted, total: list.length });
}

function qparams(url) {
  const out = {};
  try {
    for (const [k, v] of new URL(url, 'http://x').searchParams) out[k] = v;
  } catch {}
  return out;
}

function serveGet(res, table, opts) {
  const q = opts;
  const limit = Math.min(5000, parseInt(q.limit || '200', 10));
  const where = [];
  const params = [];
  if (q.session) { where.push('session_id = ?'); params.push(q.session); }
  if (q.type) { where.push('type = ?'); params.push(q.type); }
  if (q.after) { where.push('ts >= ?'); params.push(parseInt(q.after, 10)); }
  const sql = `SELECT * FROM ${table} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ts DESC LIMIT ?`;
  const rows = db.prepare(sql).all(...params, limit);
  const strip = (r) => {
    const out = { ...r };
    if (out.payload) { try { out.data = JSON.parse(out.payload); } catch {} }
    delete out.payload;
    return out;
  };
  json(res, 200, { ok: true, table, rows: rows.map(strip) });
}

function serveStats(res) {
  const one = (sql) => db.prepare(sql).get().count;
  const byType = db.prepare('SELECT type, COUNT(*) as n FROM events GROUP BY type ORDER BY n DESC LIMIT 50').all();
  const byDay = db.prepare('SELECT strftime(\'%Y-%m-%d\', ts/1000, \'unixepoch\') as day, COUNT(*) as n FROM events GROUP BY day ORDER BY day DESC LIMIT 30').all();
  json(res, 200, {
    ok: true,
    events: one('SELECT COUNT(*) as count FROM events'),
    screenshots: one('SELECT COUNT(*) as count FROM screenshots'),
    insights: one('SELECT COUNT(*) as count FROM insights'),
    sessions: one('SELECT COUNT(*) as count FROM sessions'),
    byType,
    byDay,
    recentScreenshot: db.prepare('SELECT id, ts, url, width, height, path FROM screenshots ORDER BY ts DESC LIMIT 1').get(),
  });
}

const DEMO_PAGE = `<!DOCTYPE html><html><head><title>VAIA Demo Page</title>
<style>body{font-family:sans-serif;max-width:640px;margin:40px auto;line-height:1.5}button{margin:4px}input{padding:6px;margin:4px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:6px}</style>
</head><body>
<h1>VAIA Activity Demo</h1><p>Use this page to exercise the Visual AI Agent extension.</p>
<button id="b1">Button one</button><button id="b2">Button two</button>
<input type="text" id="txt" placeholder="type something" />
<input type="password" id="pwd" placeholder="password field (should be masked)" />
<select id="sel"><option>A</option><option>B</option></select>
<form id="f"><input type="text" name="q" placeholder="search" /><button type="submit">Submit form</button></form>
<a href="/demo" id="link">Reload me</a>
<table id="t"><tr><th>Item</th><th>Price</th></tr><tr><td>Widget</td><td>$9</td></tr></table>
<script>
document.getElementById('b1').onclick = () => { document.getElementById('txt').value += 'X'; };
window.onerror = (m) => console.error('demo error', m);
setTimeout(() => { throw new Error('demo-unhandled'); }, 0);
</script></body></html>`;

const server = createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  if (req.method === 'OPTIONS') return json(res, 204, {});
  if (req.method === 'GET' && url === '/health') return json(res, 200, { ok: true });
  if (req.method === 'GET' && url === '/') return json(res, 200, { name: 'vaia-receiver', endpoints: ['/api/events', '/api/screenshots', '/api/insights', '/api/sessions', '/api/stats', '/demo'] });
  if (req.method === 'GET' && url === '/demo') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(DEMO_PAGE);
  }
  if (req.method === 'GET' && url === '/api/stats') return serveStats(res);
  if (req.method === 'GET' && url === '/api/events') return serveGet(res, 'events', qparams(req.url));
  if (req.method === 'GET' && url === '/api/screenshots') return serveGet(res, 'screenshots', qparams(req.url));
  if (req.method === 'GET' && url === '/api/insights') return serveGet(res, 'insights', qparams(req.url));
  if (req.method === 'GET' && url === '/api/sessions') return serveGet(res, 'sessions', qparams(req.url));
  if (req.method === 'GET' && url === '/api/heatmap') {
    let rows;
    try {
      rows = db
        .prepare(
          `SELECT CAST(json_extract(payload, '$.data.x') AS INTEGER) AS x,
                  CAST(json_extract(payload, '$.data.y') AS INTEGER) AS y,
                  COUNT(*) AS n
           FROM events
           WHERE type IN (?, ?) AND json_extract(payload, '$.data.x') IS NOT NULL
           GROUP BY x, y ORDER BY n DESC LIMIT 500`
        )
        .all('click', 'mouse_down');
    } catch {
      rows = [];
    }
    return json(res, 200, { ok: true, rows });
  }
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' });
  try {
    if (url === '/api/events') return await handleEvents(req, res);
    if (url === '/api/screenshots') return await handleScreenshots(req, res);
    if (url === '/api/insights') return await handleInsights(req, res);
    if (url === '/api/sessions') return await handleSessions(req, res);
    if (url === '/api/ping' || url === '/api/events' || url === '/api') {
      const raw = await readBody(req);
      const body = JSON.parse(raw || '{}');
      return json(res, 200, { ok: true, echo: body.kind === 'ping' ? 'pong' : 'received' });
    }
    return json(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    return json(res, 500, { ok: false, error: e.message });
  }
});

const PORT = process.env.PORT || 8787;
server.listen(PORT, () => {
  console.log(`[vaia-receiver] listening on http://localhost:${PORT}`);
  console.log(`  demo page:   http://localhost:${PORT}/demo`);
  console.log(`  stats:       http://localhost:${PORT}/api/stats`);
});
