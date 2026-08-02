import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attentionByHost, topHosts, hostOf } from '../../shared/attention.js';

test('hostOf extracts a clean hostname', () => {
  assert.equal(hostOf('https://github.com/foo'), 'github.com');
  assert.equal(hostOf('https://www.Youtube.com/watch'), 'youtube.com');
  assert.equal(hostOf(''), '');
});

test('attention counts time on a single host between page events', () => {
  const base = 1_000_000_000;
  const events = [
    { ts: base, type: 'page_view', url: 'https://github.com/x' },
    { ts: base + 60_000, type: 'click', url: 'https://github.com/x' },
    { ts: base + 120_000, type: 'navigation', url: 'https://youtube.com/v' },
  ];
  const { byHost, totalMs } = attentionByHost(events, { nowMs: base + 120_000 });
  assert.equal(byHost['github.com'], 120_000);
  assert.equal(byHost['youtube.com'] || 0, 0); // no time yet after nav
  assert.equal(totalMs, 120_000);
});

test('tab switch reassigns attention to the new host', () => {
  const base = 1_000_000_000;
  const events = [
    { ts: base, type: 'page_view', url: 'https://github.com/x' },
    { ts: base + 60_000, type: 'tab_activated', url: '', data: { tabId: 2, url: 'https://youtube.com/z' } },
    { ts: base + 120_000, type: 'click', url: 'https://youtube.com/z' },
  ];
  const { byHost } = attentionByHost(events, { nowMs: base + 180_000 });
  assert.equal(byHost['github.com'], 60_000);
  assert.equal(byHost['youtube.com'], 120_000); // 60s before click + 60s after
});

test('idle suspends attention and idle_end resumes on last host', () => {
  const base = 1_000_000_000;
  const events = [
    { ts: base, type: 'page_view', url: 'https://github.com/x' },
    { ts: base + 60_000, type: 'idle_start', url: 'https://github.com/x' },
    { ts: base + 180_000, type: 'idle_end', url: 'https://github.com/x' },
    { ts: base + 300_000, type: 'click', url: 'https://github.com/x' },
  ];
  const { byHost } = attentionByHost(events, { nowMs: base + 300_000 });
  // 60s before idle, none during idle, then resumes after idle_end up to click (120s)
  assert.equal(byHost['github.com'], 60_000 + 120_000);
});

test('hidden tab suspends attention until visible again', () => {
  const base = 1_000_000_000;
  const events = [
    { ts: base, type: 'page_view', url: 'https://youtube.com/v' },
    { ts: base + 60_000, type: 'visibility', url: 'https://youtube.com/v', data: { state: 'hidden' } },
    { ts: base + 180_000, type: 'visibility', url: 'https://youtube.com/v', data: { state: 'visible' } },
    { ts: base + 240_000, type: 'click', url: 'https://youtube.com/v' },
  ];
  const { byHost } = attentionByHost(events, { nowMs: base + 240_000 });
  assert.equal(byHost['youtube.com'], 60_000 + 60_000);
});

test('window blur suspends and focus resumes', () => {
  const base = 1_000_000_000;
  const events = [
    { ts: base, type: 'page_view', url: 'https://github.com/x' },
    { ts: base + 30_000, type: 'window_focus', url: '', data: { focused: false } },
    { ts: base + 90_000, type: 'window_focus', url: 'https://github.com/x', data: { focused: true } },
    { ts: base + 120_000, type: 'click', url: 'https://github.com/x' },
  ];
  const { byHost } = attentionByHost(events, { nowMs: base + 120_000 });
  assert.equal(byHost['github.com'], 30_000 + 30_000);
});

test('page_leave ends the segment; next page starts fresh', () => {
  const base = 1_000_000_000;
  const events = [
    { ts: base, type: 'page_view', url: 'https://github.com/x' },
    { ts: base + 60_000, type: 'page_leave', url: 'https://github.com/x' },
    { ts: base + 120_000, type: 'page_view', url: 'https://gitlab.com/y' },
    { ts: base + 180_000, type: 'click', url: 'https://gitlab.com/y' },
  ];
  const { byHost } = attentionByHost(events, { nowMs: base + 180_000 });
  assert.equal(byHost['github.com'], 60_000);
  assert.equal(byHost['gitlab.com'], 60_000);
});

test('gaps longer than maxGapMs are capped', () => {
  const base = 1_000_000_000;
  const events = [
    { ts: base, type: 'page_view', url: 'https://github.com/x' },
    { ts: base + 20 * 60 * 1000, type: 'click', url: 'https://github.com/x' },
  ];
  const { byHost } = attentionByHost(events, { nowMs: base + 20 * 60 * 1000, maxGapMs: 5 * 60 * 1000 });
  assert.equal(byHost['github.com'], 5 * 60 * 1000);
});

test('topHosts sorts and formats minutes', () => {
  const top = topHosts({ a: 90_000, b: 600_000, c: 30_000 }, 2);
  assert.deepEqual(top.map((t) => t.host), ['b', 'a']);
  assert.equal(top[0].minutes, 10);
});
