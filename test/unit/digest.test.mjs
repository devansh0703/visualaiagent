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
  assert.match(body, /Top sites: github.com \(6\)/);
  assert.match(body, /2 error\(s\)/);
  assert.match(body, /rage-click/);
});

test('empty window yields a quiet-period body', () => {
  const body = buildDigestBody({ data: {} });
  assert.match(body, /quiet period/);
});
