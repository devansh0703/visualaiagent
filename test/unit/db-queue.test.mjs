/**
 * Regression test for the offline outbound queue: a full batch of already-sent
 * records must not block later records from flushing, and the queue must drain
 * completely (not just one batch) on a manual flush.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';

// In-memory stand-in for background/idb.js
const records = [];
const idbMock = {
  async put(store, rec) {
    const i = records.findIndex((r) => r.id === rec.id);
    if (i >= 0) records[i] = rec;
    else records.push(rec);
    return rec.id;
  },
  async count() {
    return records.length;
  },
  async each(store, { onEach } = {}) {
    for (const rec of [...records].sort((a, b) => a.ts - b.ts)) {
      const keep = onEach(rec);
      if (keep === false) break;
    }
  },
  async deleteMany(store, ids) {
    for (const id of ids) records.splice(records.findIndex((r) => r.id === id), 1);
  },
  async getByIndex() {
    return [];
  },
};

// Resolve the mock key like a normal import from this file so the test is
// portable (a hardcoded home path only worked on one machine and broke CI).
mock.module('../../background/idb.js', { namedExports: idbMock });

const { initDb, enqueue, flushNow, cancelScheduler } = await import('../../background/db.js');

const posted = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  for (const ev of body.events) posted.push(ev);
  return { ok: true, status: 200 };
};

const cfgRef = {
  _deviceId: 'd1',
  _userId: 'u1',
  db: {
    endpoint: 'http://receiver/api/events',
    sendEvents: true,
    sendScreenshots: false,
    sendInsights: false,
    batchSize: 10,
    flushIntervalMs: 600000,
  },
};
initDb({ getConfig: () => cfgRef });

after(() => {
  cancelScheduler();
  globalThis.fetch = realFetch;
});

test('queue drains across multiple batches on a single flush', async () => {
  for (let i = 0; i < 25; i++) await enqueue('events', { id: `e${i}`, ts: i, type: i % 2 ? 'click' : 'text_input', data: {} });
  const sent = await flushNow();
  assert.equal(sent, 25, 'all 25 events should flush in one call');
  assert.equal(posted.length, 25, 'receiver should have received every event');
  const types = new Set(posted.map((e) => e.type));
  assert.ok(types.has('click') && types.has('text_input'), 'both event types should be present');
});

test('later records flush after a sent batch, not blocked by it', async () => {
  for (let i = 25; i < 35; i++) await enqueue('events', { id: `e${i}`, ts: i, type: 'scroll', data: {} });
  const sent = await flushNow();
  assert.equal(sent, 10, 'the 10 new records should flush');
  assert.ok(posted.some((e) => e.type === 'scroll'), 'scroll events reached the receiver');
});
