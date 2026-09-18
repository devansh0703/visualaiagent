/**
 * test/unit/receiver-auth.test.mjs — shared-token auth for the receiver.
 *
 * Imports server.mjs with VAIA_TOKEN set (module-scope read), then exercises
 * the single auth choke-point: /api/* and /shots/* require the token via
 * x-api-key, `Authorization: Bearer`, or `?token=`; /health, / and /demo stay
 * open. The no-token mode is covered by the E2E suite (which runs the server
 * without VAIA_TOKEN and expects everything reachable).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PORT = '0';
process.env.VAIA_TOKEN = 'test-token-123';
process.env.VAIA_DATA_DIR = mkdtempSync(join(tmpdir(), 'vaia-auth-test-'));

const { server } = await import('../../server/server.mjs');
if (!server.listening) await once(server, 'listening');
const PORT = server.address().port;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'test-token-123';

after(async () => {
  await new Promise((r) => server.close(r));
  rmSync(process.env.VAIA_DATA_DIR, { recursive: true, force: true });
});

const get = async (path, headers = {}) => {
  const res = await fetch(BASE + path, { headers });
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
};
const post = async (path, payload, headers = {}) => {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

test('health and page shells stay open, and /health reports authRequired', async () => {
  const health = await get('/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.authRequired, true);

  const dash = await fetch(BASE + '/');
  assert.equal(dash.status, 200);
  const demo = await fetch(BASE + '/demo');
  assert.equal(demo.status, 200);
});

test('protected endpoints reject missing and wrong tokens with 401 + WWW-Authenticate', async () => {
  for (const path of ['/api/stats', '/api/events', '/api/export', '/shots/00000000-0000-4000-8000-000000000000.jpg']) {
    const res = await get(path);
    assert.equal(res.status, 401, `${path} must 401 without a token`);
    assert.equal(res.headers.get('www-authenticate'), 'Bearer');
  }
  const wrong = await get('/api/stats', { 'x-api-key': 'nope' });
  assert.equal(wrong.status, 401);
  const post401 = await post('/api/events', { events: [] });
  assert.equal(post401.status, 401);
});

test('x-api-key, Authorization Bearer, and ?token= all authorize; write path works', async () => {
  const viaHeader = await get('/api/stats', { 'x-api-key': TOKEN });
  assert.equal(viaHeader.status, 200);
  assert.equal(viaHeader.body.ok, true);

  const viaBearer = await get('/api/stats', { Authorization: `Bearer ${TOKEN}` });
  assert.equal(viaBearer.status, 200);

  const viaQuery = await get(`/api/stats?token=${encodeURIComponent(TOKEN)}`);
  assert.equal(viaQuery.status, 200);

  const writeRes = await post(
    '/api/events',
    { events: [{ id: 'auth-e1', ts: Date.now(), type: 'click', url: 'https://x.test/', data: {} }] },
    { 'x-api-key': TOKEN },
  );
  assert.equal(writeRes.status, 200);
  assert.equal(writeRes.body.inserted, 1);

  const stats = await get('/api/stats', { 'x-api-key': TOKEN });
  assert.ok(stats.body.events >= 1, 'event should be persisted behind auth');
});

test('malformed Authorization headers are rejected, not crashy', async () => {
  const garbage = await get('/api/stats', { Authorization: 'Basic zzzz' });
  assert.equal(garbage.status, 401);
  const bare = await get('/api/stats', { Authorization: 'Bearer' });
  assert.equal(bare.status, 401);
});
