import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InsightsEngine } from '../../background/insights.js';

function makeEngine() {
  const records = [];
  const cfg = {
    insights: {
      enabled: true,
      errorSpikeWindowMs: 60000,
      errorSpikeThreshold: 5,
      rapidNavWindowMs: 30000,
      rapidNavThreshold: 6,
      scrollSpikeWindowMs: 3000,
      scrollSpikeThreshold: 8,
      generateEndOfSessionSummary: false,
    },
  };
  const engine = new InsightsEngine({ configRef: () => cfg, onInsight: (r) => records.push(r) });
  return { engine, records };
}

function ev(type, ts, url = 'https://x.com/a') {
  return { id: 'e' + ts + type, ts, type, url, data: {} };
}

test('error spike detector fires', () => {
  const { engine, records } = makeEngine();
  for (let i = 0; i < 5; i++) engine.ingest(ev('error', 1000 + i * 1000));
  assert.equal(records.some((r) => r.type === 'error_spike'), true);
  const rec = records.find((r) => r.type === 'error_spike');
  assert.equal(rec.signal, 'negative');
  assert.ok(rec.confidence > 0);
});

test('rage click detector fires frustration insight', () => {
  const { engine, records } = makeEngine();
  engine.ingest(ev('rage_click', 5000, 'https://x.com/a'));
  assert.equal(records.some((r) => r.type === 'frustration'), true);
});

test('form abandonment detected on leave without submit', () => {
  const { engine, records } = makeEngine();
  engine.ingest(ev('page_view', 1));
  for (let i = 0; i < 4; i++) engine.ingest({ ...ev('text_input', 2 + i), data: {} });
  engine.ingest(ev('page_leave', 100));
  assert.equal(records.some((r) => r.type === 'form_abandonment'), true);
});

test('no abandonment when form submitted', () => {
  const { engine, records } = makeEngine();
  engine.ingest(ev('page_view', 1));
  for (let i = 0; i < 4; i++) engine.ingest(ev('text_input', 2 + i));
  engine.ingest(ev('form_submit', 50));
  engine.ingest(ev('page_leave', 100));
  assert.equal(records.some((r) => r.type === 'form_abandonment'), false);
});

test('frustration score is bounded 0..1 and rises with rage clicks', () => {
  const { engine } = makeEngine();
  assert.ok(engine.frustrationScore().score >= 0 && engine.frustrationScore().score <= 1);
  engine.ingest(ev('rage_click', 1));
  engine.ingest(ev('rage_click', 2));
  engine.ingest(ev('dead_click', 3));
  const s = engine.frustrationScore();
  assert.ok(s.score > 0);
  assert.ok(s.stats.rage === 2);
});

test('engagement score stays in range', () => {
  const { engine } = makeEngine();
  for (let i = 0; i < 20; i++) engine.ingest(ev('click', i));
  const e = engine.engagementScore();
  assert.ok(e >= 0 && e <= 1);
});

test('rapid navigation detector fires', () => {
  const { engine, records } = makeEngine();
  for (let i = 0; i < 7; i++) engine.ingest(ev('navigation', 1000 + i * 1000));
  assert.equal(records.some((r) => r.type === 'rapid_navigation'), true);
});

test('detectors never throw on malformed events', () => {
  const { engine } = makeEngine();
  engine.ingest(null);
  engine.ingest({});
  engine.ingest({ type: 'click' });
  engine.ingest({ type: 'page_leave' });
  assert.equal(engine.recent.length >= 2, true);
});

test('scroll spike detector fires on rapid large scrolls', () => {
  const { engine, records } = makeEngine();
  for (let i = 0; i < 9; i++) {
    engine.ingest({ ...ev('scroll', 1000 + i * 200), data: { dy: i % 2 ? 600 : -500, y: 100 * i } });
  }
  assert.equal(records.some((r) => r.type === 'scroll_spike'), true);
  const rec = records.find((r) => r.type === 'scroll_spike');
  assert.equal(rec.signal, 'hesitation');
});

test('scroll spike ignores small scrolls', () => {
  const { engine, records } = makeEngine();
  for (let i = 0; i < 20; i++) {
    engine.ingest({ ...ev('scroll', 1000 + i * 100), data: { dy: 10, y: i } });
  }
  assert.equal(records.some((r) => r.type === 'scroll_spike'), false);
});
