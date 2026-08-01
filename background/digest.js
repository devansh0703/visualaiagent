/**
 * background/digest.js — computes a periodic "Daily digest" insight from the
 * local telemetry archive (IndexedDB). Pure-ish and unit-testable: all reads go
 * through an injected `idb` so tests can substitute a fake.
 */
import { uuid, now } from '../shared/utils.js';
import { focusScoreOf, topSites } from '../shared/categories.js';

export async function computeDigest({ idb, config, deviceId, userId, sessionId, windowMs, sinceTs }) {
  const cfg = config.digest || {};
  const windowMsEffective = windowMs || (cfg.windowHours || 24) * 60 * 60 * 1000;
  const cutoff = sinceTs != null ? sinceTs : now() - windowMsEffective;

  const events = [];
  await idb.each('events', {
    index: 'ts',
    onEach: (r) => {
      if (r.ts >= cutoff) events.push(r);
    },
  });

  const byType = {};
  const pages = [];
  let errors = 0;
  let rage = 0;
  let clicks = 0;
  let searches = 0;
  for (const ev of events) {
    byType[ev.type] = (byType[ev.type] || 0) + 1;
    if (/error|unhandled_rejection|console_error|resource_error/.test(ev.type)) errors++;
    if (ev.type === 'rage_click') rage++;
    if (ev.type === 'click') clicks++;
    if (ev.type === 'search') searches++;
    if (ev.type === 'page_view' && ev.url) {
      pages.push({ url: ev.url, title: ev.title || '', ts: ev.ts });
    }
  }

  const focus = focusScoreOf(pages.slice(-200));
  const top = topSites(pages);

  const insights = [];
  await idb.each('insights', {
    index: 'ts',
    onEach: (r) => {
      if (r.ts >= cutoff && r.kind === 'rule') insights.push({ type: r.type, title: r.title, signal: r.signal });
    },
  });

  const total = events.length;
  const active = total ? Math.min(1, clicks / Math.max(1, total)) : 0;
  const title =
    total === 0
      ? 'Daily digest — no activity'
      : `Daily digest — ${total.toLocaleString()} events, ${focus ? Math.round(focus.score * 100) : 0}% focus`;

  return {
    id: uuid(),
    ts: now(),
    kind: 'digest',
    type: 'daily_digest',
    title,
    body: '',
    signal: errors > 0 || rage > 0 ? 'negative' : 'positive',
    confidence: 0.9,
    sessionId: sessionId || null,
    userId,
    deviceId,
    data: {
      windowMs: windowMsEffective,
      total,
      byType,
      pages: pages.length,
      topSites: top,
      focus,
      errors,
      rageClicks: rage,
      clicks,
      searches,
      engagement: active,
      insights,
    },
  };
}

export function buildDigestBody(rec) {
  const d = rec.data || {};
  const lines = [];
  const focus = d.focus;
  if (focus) lines.push(`Focus score ${Math.round(focus.score * 100)}% across ${focus.pages} page views.`);
  const sites = (d.topSites || []).slice(0, 5).map((s) => `${s.host || s.url} (${s.n})`).join(', ');
  if (sites) lines.push(`Top sites: ${sites}.`);
  const parts = [];
  for (const [k, v] of Object.entries(d.byType || {})) {
    if (v > 0 && /error|rage_click|dead_click|form_submit|search|insight|download/.test(k)) parts.push(`${k}: ${v}`);
  }
  if (parts.length) lines.push(`Signals: ${parts.join(', ')}.`);
  if ((d.errors || 0) > 0) lines.push(`${d.errors} error(s) detected.`);
  if ((d.rageClicks || 0) > 0) lines.push(`${d.rageClicks} rage-click episode(s).`);
  if (!lines.length) lines.push('A quiet period — no significant activity recorded.');
  return lines.join(' ');
}
