/**
 * shared/attention.js — estimate active "attention time" per host from the raw
 * telemetry timeline. Pure functions, no extension APIs, unit-testable.
 *
 * Model: a user is paying attention to a host between the moment a page becomes
 * active (page_view / navigation / tab_activated / window focus) and the moment
 * it stops (page_leave / idle_start / visibility hidden / window blur). Gaps
 * longer than `maxGapMs` between pieces of evidence are not counted — the user
 * probably stopped, and a fresh event starts a fresh segment.
 */

/** Lowercase host of a URL, stripped of a leading "www.". Empty for bad input. */
export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

const PAGE_EVENTS = new Set(['page_view', 'navigation', 'tab_activated']);
const SUSPEND_EVENTS = new Set(['page_leave', 'idle_start']);
const FOCUSED_EVENTS = new Set(['visibility', 'window_focus']);

/**
 * @param {Array<{ts:number,type:string,url?:string,data?:object}>} events
 * @param {{maxGapMs?:number,nowMs?:number}} opts
 * @returns {{ byHost: Object<string,number>, totalMs: number }}
 *   `byHost[host]` = milliseconds of estimated active attention.
 */
export function attentionByHost(events, opts = {}) {
  const maxGapMs = opts.maxGapMs ?? 5 * 60 * 1000;
  const nowMs = opts.nowMs ?? Date.now();

  const list = (events || [])
    .filter((e) => e && Number.isFinite(e.ts))
    .slice()
    .sort((a, b) => a.ts - b.ts);

  const byHost = {};
  let curHost = null; // host of the currently-open active segment
  let segStart = null; // ts when the current segment started
  let lastHost = null; // host remembered while suspended (idle/hidden/blur)
  let lastTs = null;

  const add = (host, from, to) => {
    if (!host || from == null || to == null) return;
    if (to <= from) return;
    const ms = Math.max(0, Math.min(to - from, maxGapMs));
    byHost[host] = (byHost[host] || 0) + ms;
  };

  const closeSegment = (ts) => {
    if (curHost && segStart != null) add(curHost, segStart, ts);
    segStart = null;
  };

  for (const ev of list) {
    const ts = ev.ts;
    if (lastTs == null) lastTs = ts;
    const gap = ts - lastTs;
    lastTs = ts;

    // If the segment went quiet longer than maxGap, count only maxGap and
    // re-open the segment at this event (attention may have resumed).
    if (curHost && segStart != null && gap > maxGapMs) {
      add(curHost, segStart, segStart + maxGapMs);
      segStart = ts;
    }

    const type = ev.type;
    if (PAGE_EVENTS.has(type)) {
      // A page-related event points at a concrete active page: close the old
      // segment and open a new one for this host.
      const host = hostOf(ev.data && ev.data.url ? ev.data.url : ev.url);
      if (host) {
        closeSegment(ts);
        curHost = host;
        lastHost = host;
        segStart = ts;
      }
      continue;
    }

    if (type === 'window_focus') {
      const focused = ev.data && ev.data.focused === true;
      if (focused) {
        // Resume on the host that was active before blur (or the event url).
        const host = hostOf(ev.url) || lastHost;
        if (host && !curHost) {
          closeSegment(ts);
          curHost = host;
          lastHost = host;
          segStart = ts;
        }
      } else {
        closeSegment(ts);
        curHost = null;
      }
      continue;
    }

    if (type === 'visibility') {
      const visible = ev.data && ev.data.state === 'visible';
      if (visible) {
        const host = hostOf(ev.url) || lastHost;
        if (host && !curHost) {
          closeSegment(ts);
          curHost = host;
          lastHost = host;
          segStart = ts;
        }
      } else {
        closeSegment(ts);
        curHost = null;
      }
      continue;
    }

    if (type === 'idle_start') {
      closeSegment(ts);
      curHost = null;
      continue;
    }
    if (type === 'idle_end') {
      // User came back; resume counting on the last active host.
      if (!curHost && lastHost) {
        segStart = ts;
        curHost = lastHost;
      }
      continue;
    }
    if (type === 'page_leave') {
      closeSegment(ts);
      curHost = null;
      continue;
    }

    // Any other event (click/scroll/… ) is activity evidence: keep the current
    // segment open and refresh its start if it had silently ended.
    if (curHost && segStart == null) segStart = ts;
  }

  // Close the final open segment, capped at nowMs and maxGap.
  if (curHost && segStart != null) {
    const end = Math.min(nowMs, segStart + maxGapMs);
    add(curHost, segStart, end);
  }

  const totalMs = Object.values(byHost).reduce((a, b) => a + b, 0);
  return { byHost, totalMs };
}

/** Sorted list of {host, ms, minutes} from a byHost map. */
export function topHosts(byHost, n = 10) {
  return Object.entries(byHost || {})
    .map(([host, ms]) => ({ host, ms, minutes: Math.round(ms / 60000 * 10) / 10 }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, n);
}
