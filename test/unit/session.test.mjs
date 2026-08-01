import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../../background/session.js';

function ev(type, ts, extra = {}) {
  return { id: 'x-' + ts, ts, type, url: 'https://x.com/a', title: '', data: extra };
}

test('session counts events by type', () => {
  const s = new Session({ id: 's1', userId: 'u1' });
  s.recordEvent(ev('click', 1));
  s.recordEvent(ev('click', 2));
  s.recordEvent(ev('error', 3));
  const rec = s.toRecord();
  assert.equal(rec.events, 3);
  assert.equal(rec.eventTypes.click, 2);
  assert.equal(rec.errors, 1);
  assert.equal(rec.id, 's1');
});

test('session tracks pages and attribution', () => {
  const s = new Session({});
  s.recordEvent(ev('page_view', 1, {}));
  s.recordEvent(ev('click', 2, { target: { fingerprint: 'fp1', tag: 'button', text: 'Buy' } }));
  s.recordEvent(ev('click', 3, { target: { fingerprint: 'fp1', tag: 'button', text: 'Buy' } }));
  const rec = s.toRecord();
  assert.equal(rec.pageCount, 1);
  assert.equal(rec.pages.length, 1);
  assert.equal(rec.attribution.fp1.count, 2);
});

test('session.end sets endedAt and durationMs', () => {
  const s = new Session({ startedAt: 1000 });
  const rec = s.end();
  assert.ok(rec.endedAt >= 1000);
  assert.ok(rec.durationMs >= 0);
  assert.equal(s.durationMs, rec.durationMs);
});

test('session recordEvent caps pages and attribution lists', () => {
  const s = new Session({});
  for (let i = 0; i < 60; i++) s.recordEvent(ev('page_view', i));
  for (let i = 0; i < 30; i++) s.recordEvent(ev('click', i, { target: { fingerprint: 'fp' + i, tag: 'button' } }));
  const rec = s.toRecord();
  assert.equal(rec.pages.length, 50);
  assert.equal(Object.keys(rec.attribution).length, 20);
});
