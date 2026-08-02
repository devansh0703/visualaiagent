import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDistractionGoal, distractionMinutes } from '../../shared/goals.js';

test('checkDistractionGoal returns null when disabled', () => {
  const events = [{ ts: 1, type: 'page_view', url: 'https://youtube.com/v' }];
  assert.equal(checkDistractionGoal(events, {}), null);
  assert.equal(checkDistractionGoal(events, { goals: { enabled: false } }), null);
});

test('distraction budget counts only distraction-category hosts', () => {
  const base = 1_000_000_000;
  const events = [
    { ts: base, type: 'page_view', url: 'https://youtube.com/v' },
    { ts: base + 60_000, type: 'page_view', url: 'https://github.com/x' },
    { ts: base + 120_000, type: 'page_view', url: 'https://youtube.com/v' },
  ];
  const res = checkDistractionGoal(events, { goals: { enabled: true, distractionsMinutes: 1 } }, { nowMs: base + 180_000 });
  assert.ok(res);
  assert.equal(res.limitMs, 60_000);
  assert.ok(res.distractionMs > 60_000);
  assert.equal(res.breakdown[0].host, 'youtube.com');
  assert.equal(distractionMinutes(res), Math.round(res.distractionMs / 60000 * 10) / 10);
});

test('budget not exceeded returns null', () => {
  const base = 1_000_000_000;
  const events = [
    { ts: base, type: 'page_view', url: 'https://github.com/x' },
    { ts: base + 60_000, type: 'page_view', url: 'https://youtube.com/v' },
    { ts: base + 120_000, type: 'click', url: 'https://youtube.com/v' },
  ];
  const res = checkDistractionGoal(events, { goals: { enabled: true, distractionsMinutes: 60 } }, { nowMs: base + 180_000 });
  assert.equal(res, null);
});

test('deep subdomain counts as distraction', () => {
  const base = 1_000_000_000;
  const events = [
    { ts: base, type: 'page_view', url: 'https://m.youtube.com/v' },
    { ts: base + 30_000, type: 'click', url: 'https://m.youtube.com/v' },
    { ts: base + 90_000, type: 'click', url: 'https://m.youtube.com/v' },
  ];
  const res = checkDistractionGoal(events, { goals: { enabled: true, distractionsMinutes: 1 } }, { nowMs: base + 120_000 });
  assert.ok(res);
  assert.equal(res.breakdown[0].host, 'm.youtube.com');
});
