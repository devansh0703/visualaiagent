import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeDigest, buildDigestBody } from '../../background/digest.js';

function fakeIdb(events, insights) {
  return {
    async each(store, { onEach } = {}) {
      const rows = store === 'events' ? events : insights;
      for (const r of [...rows].sort((a, b) => a.ts - b.ts)) onEach(r);
    },
  };
}

test('computeDigest aggregates a window of events', async () => {
  const now = 1_000_000_000;
  const events = [
    { id: '1', ts: now - 60_000, type: 'page_view', url: 'https://github.com/x', title: 'Repo' },
    { id: '2', ts: now - 50_000, type: 'click', url: 'https://github.com/x' },
    { id: '3', ts: now - 40_000, type: 'click', url: 'https://github.com/x' },
    { id: '4', ts: now - 30_000, type: 'error', url: 'https://github.com/x' },
    { id: '5', ts: now - 20_000, type: 'rage_click', url: 'https://youtube.com/v' },
    { id: 'old', ts: now - 3 * 60 * 60 * 1000, type: 'click', url: 'https://old.com' },
  ];
  const rec = await computeDigest({
    idb: fakeIdb(events, []),
    config: { digest: { windowHours: 24 } },
    sessionId: 's1',
    sinceTs: now - 3600_000,
  });
  assert.equal(rec.type, 'daily_digest');
  assert.equal(rec.kind, 'digest');
  assert.equal(rec.data.total, 5); // old event excluded
  assert.equal(rec.data.errors, 1);
  assert.equal(rec.data.rageClicks, 1);
  assert.equal(rec.data.pages, 1); // only page_view events count as pages
  assert.equal(rec.data.focus.score, 1); // single github.com page view
  assert.equal(rec.signal, 'negative');
});

test('buildDigestBody renders a readable summary', () => {
  const rec = {
    data: {
      total: 42,
      focus: { score: 0.8, pages: 10 },
      topSites: [{ host: 'github.com', n: 6 }],
      byType: { click: 30, error: 2 },
      errors: 2,
      rageClicks: 1,
    },
  };
  const body = buildDigestBody(rec);
  assert.match(body, /Focus score 80%/);
  assert.match(body, /Top pages: github.com \(6\)/);
  assert.match(body, /2 error\(s\)/);
  assert.match(body, /rage-click/);
});

test('empty window yields a quiet-period body', () => {
  const body = buildDigestBody({ data: {} });
  assert.match(body, /quiet period/);
});

test('weekly digest uses a 7-day window and its own type', async () => {
  const nowTs = Date.now();
  const events = [
    { id: '1', ts: nowTs - 2 * 24 * 60 * 60 * 1000, type: 'page_view', url: 'https://github.com/x' },
    { id: '2', ts: nowTs - 60_000, type: 'click', url: 'https://github.com/x' },
  ];
  const rec = await computeDigest({
    idb: fakeIdb(events, []),
    config: {},
    sessionId: 's1',
    period: 'weekly',
  });
  assert.equal(rec.type, 'weekly_digest');
  assert.equal(rec.data.period, 'weekly');
  assert.equal(rec.data.windowMs, 7 * 24 * 60 * 60 * 1000);
  assert.equal(rec.data.total, 2);
});

test('digest includes attention time per host', async () => {
  const nowTs = Date.now();
  const events = [
    { id: '1', ts: nowTs - 60_000, type: 'page_view', url: 'https://github.com/x' },
    { id: '2', ts: nowTs - 30_000, type: 'page_view', url: 'https://youtube.com/v' },
    { id: '3', ts: nowTs - 10_000, type: 'click', url: 'https://youtube.com/v' },
  ];
  const rec = await computeDigest({ idb: fakeIdb(events, []), config: {}, sinceTs: nowTs - 3600_000 });
  const att = rec.data.attention;
  assert.ok(att.totalMs >= 60_000 && att.totalMs <= 70_000, `totalMs=${att.totalMs}`);
  assert.equal(att.top.length, 2);
  const hosts = att.top.map((s) => s.host);
  assert.ok(hosts.includes('github.com') && hosts.includes('youtube.com'));
});

test('digest computes a 7-day focus trend', async () => {
  const nowTs = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const events = [
    { id: '1', ts: nowTs - 10_000, type: 'page_view', url: 'https://github.com/a' },
    { id: '2', ts: nowTs - 2 * day, type: 'page_view', url: 'https://github.com/b' },
    { id: '3', ts: nowTs - 2 * day, type: 'page_view', url: 'https://youtube.com/c' },
  ];
  const rec = await computeDigest({ idb: fakeIdb(events, []), config: {}, sinceTs: nowTs - 8 * day });
  const trend = rec.data.focusTrend;
  assert.equal(trend.length, 7);
  assert.equal(trend[6].focus, 1); // today
  assert.equal(trend[4].focus, 0.5); // two days ago: github + youtube
});

test('digest reports a triggered distraction goal as negative', async () => {
  const nowTs = Date.now();
  const events = [
    { id: '1', ts: nowTs - 90_000, type: 'page_view', url: 'https://youtube.com/v' },
    { id: '2', ts: nowTs - 30_000, type: 'click', url: 'https://youtube.com/v' },
  ];
  const rec = await computeDigest({
    idb: fakeIdb(events, []),
    config: { goals: { enabled: true, distractionsMinutes: 1 } },
    sinceTs: nowTs - 3600_000,
  });
  assert.ok(rec.data.goal);
  assert.equal(rec.data.goal.breakdown[0].host, 'youtube.com');
  assert.equal(rec.signal, 'negative');
});

test('buildDigestBody renders attention and goal lines', () => {
  const body = buildDigestBody({
    data: {
      focus: { score: 0.7, pages: 5 },
      topSites: [{ host: 'github.com', n: 4 }],
      attention: { totalMs: 3_600_000, top: [{ host: 'youtube.com', minutes: 30 }] },
      goal: { distractionMs: 4_200_000, limitMs: 3_600_000 },
      focusTrend: [{ focus: 0.5 }, { focus: 0.8 }, { focus: 0.9 }],
    },
  });
  assert.match(body, /Time on sites: youtube.com \(30m\)/);
  assert.match(body, /Estimated active attention: 60 min/);
  assert.match(body, /Distraction goal exceeded — 70 min of distraction time vs 60 min budget/);
  assert.match(body, /Focus trend: 50 → 80 → 90/);
});
