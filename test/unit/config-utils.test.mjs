import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deepMerge, normalizeConfig, DEFAULTS } from '../../shared/config.js';
import { uuid, sanitizeUrl, truncate, clamp, round, LRUSet, stableStringify, hostOf } from '../../shared/utils.js';

test('deepMerge merges nested objects and replaces arrays', () => {
  const base = { a: { b: 1, c: 2 }, list: [1, 2], x: 1 };
  const over = { a: { b: 9 }, list: [3] };
  const out = deepMerge(base, over);
  assert.equal(out.a.b, 9);
  assert.equal(out.a.c, 2);
  assert.deepEqual(out.list, [3]);
  assert.equal(out.x, 1);
});

test('deepMerge leaves base untouched', () => {
  const base = { a: { b: 1 } };
  deepMerge(base, { a: { b: 2 } });
  assert.equal(base.a.b, 1);
});

test('normalizeConfig fills defaults', () => {
  const c = normalizeConfig({ capture: { intervalMs: 999 } });
  assert.equal(c.capture.intervalMs, 999);
  assert.equal(c.tracking.trackClicks, DEFAULTS.tracking.trackClicks);
  assert.equal(c.vision.enabled, false);
  assert.equal(c.capture.quality, DEFAULTS.capture.quality);
});

test('uuid is unique and formatted', () => {
  const a = uuid();
  const b = uuid();
  assert.match(a, /^[0-9a-f-]{36}$/);
  assert.notEqual(a, b);
});

test('sanitizeUrl strips query and credentials', () => {
  assert.equal(sanitizeUrl('https://x.com/path?secret=1'), 'https://x.com/path');
  assert.equal(sanitizeUrl('https://u:p@x.com/'), 'https://x.com/');
  assert.equal(sanitizeUrl('not a url', false).length, 9);
});

test('truncate/clamp/round basics', () => {
  assert.equal(truncate('hello world', 5), 'hell…'); // total length <= max
  assert.equal(truncate('short', 50), 'short');
  assert.equal(clamp(15, 0, 10), 10);
  assert.equal(clamp(-5, 0, 10), 0);
  assert.equal(round(1.235, 2), 1.24);
});

test('hostOf extracts hostname', () => {
  assert.equal(hostOf('https://Sub.Example.com:8080/x'), 'sub.example.com');
});

test('LRUSet evicts oldest beyond limit', () => {
  const s = new LRUSet(3);
  s.add('a'); s.add('b'); s.add('c'); s.add('d');
  assert.equal(s.has('a'), false);
  assert.equal(s.has('b'), true);
});

test('stableStringify sorts keys', () => {
  const a = stableStringify({ z: 1, a: 2 });
  const b = stableStringify({ a: 2, z: 1 });
  assert.equal(a, b);
});
