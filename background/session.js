/**
 * session.js — tracks one browser monitoring session: identity, timing, event
 * counters, tab state and page history. Persisted on start and end.
 */
import { uuid, now, sanitizeUrl } from '../shared/utils.js';

export class Session {
  constructor({ id, userId, startedAt, device }) {
    this.id = id || uuid();
    this.userId = userId || '';
    this.device = device || 'chrome';
    this.startedAt = startedAt || now();
    this.endedAt = null;
    this.tabId = null;
    this.pageCount = 0;
    this.events = 0;
    this.eventTypes = {};
    this.screenshots = 0;
    this.insights = 0;
    this.errors = 0;
    this.rageClicks = 0;
    this.deadClicks = 0;
    this.lastActivityAt = this.startedAt;
    this.pages = []; // recent page views: [{url,title,ts,durationMs}]
    this.attribution = {}; // top element fingerprints interacted with
    this.extra = {};
  }

  touch(ts = now()) {
    this.lastActivityAt = ts;
  }

  recordEvent(ev) {
    this.events++;
    this.eventTypes[ev.type] = (this.eventTypes[ev.type] || 0) + 1;
    if (ev.type === 'error' || ev.type === 'unhandled_rejection' || ev.type === 'console_error' || ev.type === 'resource_error') {
      this.errors++;
    }
    if (ev.type === 'rage_click') this.rageClicks++;
    if (ev.type === 'dead_click') this.deadClicks++;
    if (ev.type === 'page_view') {
      this.pageCount++;
      const d = ev.data || {};
      this.pages.push({
        url: sanitizeUrl(ev.url),
        title: ev.title || '',
        ts: ev.ts,
        durationMs: null,
      });
      if (this.pages.length > 50) this.pages.shift();
    }
    if (ev.data && ev.data.target && ev.data.target.fingerprint) {
      const fp = ev.data.target.fingerprint;
      const rec = this.attribution[fp] || { count: 0, lastTs: 0, tag: ev.data.target.tag, text: ev.data.target.text };
      rec.count++;
      rec.lastTs = ev.ts;
      rec.tag = ev.data.target.tag;
      rec.text = ev.data.target.text;
      this.attribution[fp] = rec;
    }
  }

  end() {
    this.endedAt = now();
    this.durationMs = this.endedAt - this.startedAt;
    return this.toRecord();
  }

  toRecord() {
    return {
      id: this.id,
      userId: this.userId,
      device: this.device,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      durationMs: this.durationMs,
      tabId: this.tabId,
      pageCount: this.pageCount,
      events: this.events,
      eventTypes: this.eventTypes,
      screenshots: this.screenshots,
      insights: this.insights,
      errors: this.errors,
      rageClicks: this.rageClicks,
      deadClicks: this.deadClicks,
      lastActivityAt: this.lastActivityAt,
      pages: this.pages,
      attribution: Object.entries(this.attribution)
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 20)
        .reduce((acc, [k, v]) => {
          acc[k] = v;
          return acc;
        }, {}),
      extra: this.extra,
    };
  }
}
