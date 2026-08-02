/**
 * background/digest.js — computes a periodic "Daily/Weekly digest" insight from
 * the local telemetry archive (IndexedDB). Pure-ish and unit-testable: all reads
 * go through an injected `idb` so tests can substitute a fake.
 */
import { uuid, now } from '../shared/utils.js';
import { focusScoreOf, topSites } from '../shared/categories.js';
import { attentionByHost, topHosts } from '../shared/attention.js';
import { checkDistractionGoal } from '../shared/goals.js';

function dayKey(ts) {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Per-day focus for the last `days` days, oldest first. */
export function focusTrend(pageViews, days = 7) {
  const buckets = new Map();
  for (const p of pageViews || []) {
    if (!p || !p.url) continue;
    const key = dayKey(p.ts);
    const cur = buckets.get(key) || [];
    cur.push(p);
    buckets.set(key, cur);
  }
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const pages = buckets.get(key) || [];
    const focus = focusScoreOf(pages);
    out.push({ day: key, focus: focus ? focus.score : null, pages: pages.length });
  }
  return out;
}

export async function computeDigest({ idb, config, deviceId, userId, sessionId, windowMs, sinceTs, period }) {
  const cfg = config.digest || {};
  const isWeekly = (period || cfg.period || 'daily') === 'weekly';
  const windowMsEffective = windowMs || (isWeekly ? 7 * 24 * 60 * 60 * 1000 : (cfg.windowHours || 24) * 60 * 60 * 1000);
  const cutoff = sinceTs != null ? sinceTs : now() - windowMsEffective;

  const events = [];
  const pageViews = [];
  await idb.each('events', {
    index: 'ts',
    onEach: (r) => {
      if (r.ts >= cutoff) {
        events.push(r);
        if (r.type === 'page_view' && r.url) pageViews.push({ url: r.url, title: r.title || '', ts: r.ts });
      }
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

  // Attention time per host in the window.
  const attention = attentionByHost(events, { nowMs: now() });
  const topTime = topHosts(attention.byHost, 10);

  const insights = [];
  await idb.each('insights', {
    index: 'ts',
    onEach: (r) => {
      if (r.ts >= cutoff && r.kind === 'rule') insights.push({ type: r.type, title: r.title, signal: r.signal });
    },
  });

  const trend = focusTrend(pageViews, isWeekly ? 14 : 7);
  const goal = checkDistractionGoal(events, config);

  const total = events.length;
  const active = total ? Math.min(1, clicks / Math.max(1, total)) : 0;
  const label = isWeekly ? 'Weekly digest' : 'Daily digest';
  const title =
    total === 0
      ? `${label} — no activity`
      : `${label} — ${total.toLocaleString()} events, ${focus ? Math.round(focus.score * 100) : 0}% focus`;

  return {
    id: uuid(),
    ts: now(),
    kind: 'digest',
    type: isWeekly ? 'weekly_digest' : 'daily_digest',
    title,
    body: '',
    signal: errors > 0 || rage > 0 || goal ? 'negative' : 'positive',
    confidence: 0.9,
    sessionId: sessionId || null,
    userId,
    deviceId,
    data: {
      period: isWeekly ? 'weekly' : 'daily',
      windowMs: windowMsEffective,
      total,
      byType,
      pages: pages.length,
      topSites: top,
      focus,
      attention: { totalMs: attention.totalMs, top: topTime },
      focusTrend: trend,
      goal,
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
  const period = d.period === 'weekly' ? 'week' : 'day';
  if (focus) lines.push(`Focus score ${Math.round(focus.score * 100)}% across ${focus.pages} page views this ${period}.`);
  const sites = (d.topSites || []).slice(0, 5).map((s) => `${s.host || s.url} (${s.n})`).join(', ');
  if (sites) lines.push(`Top pages: ${sites}.`);

  const att = d.attention || {};
  const timeSites = (att.top || []).slice(0, 5).map((s) => `${s.host} (${s.minutes}m)`).join(', ');
  if (timeSites) lines.push(`Time on sites: ${timeSites}.`);
  if (att.totalMs) lines.push(`Estimated active attention: ${Math.round(att.totalMs / 60000)} min.`);

  const goal = d.goal;
  if (goal) {
    lines.push(
      `Distraction goal exceeded — ${Math.round(goal.distractionMs / 60000)} min of distraction time vs ${Math.round(goal.limitMs / 60000)} min budget.`
    );
  }

  const parts = [];
  for (const [k, v] of Object.entries(d.byType || {})) {
    if (v > 0 && /error|rage_click|dead_click|form_submit|search|insight|download/.test(k)) parts.push(`${k}: ${v}`);
  }
  if (parts.length) lines.push(`Signals: ${parts.join(', ')}.`);
  if ((d.errors || 0) > 0) lines.push(`${d.errors} error(s) detected.`);
  if ((d.rageClicks || 0) > 0) lines.push(`${d.rageClicks} rage-click episode(s).`);

  const trend = (d.focusTrend || []).filter((t) => t.focus != null);
  if (trend.length >= 2) {
    const seq = trend.map((t) => Math.round(t.focus * 100)).join(' → ');
    lines.push(`Focus trend: ${seq}.`);
  }
  if (!lines.length) lines.push('A quiet period — no significant activity recorded.');
  return lines.join(' ');
}
