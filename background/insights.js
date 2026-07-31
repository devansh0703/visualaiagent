/**
 * insights.js — heuristic + LLM insight generation.
 *
 * Heuristic detectors run over a rolling window of events and surface
 * frustration / abandonment / error signals (the "rage-click" equivalent of
 * Clarity + a session-frustration score). LLM end-of-session summaries run
 * through the vision provider when configured.
 */
import { uuid, now } from '../shared/utils.js';
import * as idb from './idb.js';

const RING = 1200;

export class InsightsEngine {
  constructor({ configRef, onInsight }) {
    this.configRef = configRef;
    this.onInsight = onInsight; // (insightRecord) => void
    this.recent = [];
    this.formActivity = new Map(); // pageUrl -> {textInputs, submitted}
    this.lastPageView = null;
    this.detectorsFired = new Set();
  }

  get config() {
    return (this.configRef && this.configRef()) || {};
  }

  ingest(ev) {
    const cfg = this.config.insights || {};
    if (cfg.enabled === false) return;
    this.recent.push(ev);
    if (this.recent.length > RING) this.recent.shift();

    if (ev.type === 'page_view') {
      this.lastPageView = { url: ev.url, ts: ev.ts, textInputs: 0, submitted: false };
      this.formActivity.set(ev.url, this.lastPageView);
    }
    if (ev.type === 'text_input' && this.lastPageView) this.lastPageView.textInputs++;
    if (ev.type === 'form_submit' && this.lastPageView) this.lastPageView.submitted = true;

    try {
      this.detectErrorSpike(ev, cfg);
      this.detectRapidNavigation(ev, cfg);
      this.detectAbandonment(ev, cfg);
      this.detectSessionWarning(ev, cfg);
    } catch (e) {
      /* detectors must never break ingestion */
    }
  }

  record(type, title, body, signal, confidence) {
    const rec = {
      id: uuid(),
      ts: now(),
      kind: 'rule',
      type,
      title,
      body,
      signal,
      confidence,
    };
    try {
      idb.put('insights', rec);
    } catch {}
    if (this.onInsight) this.onInsight(rec);
    return rec;
  }

  /* ---- detectors ------------------------------------------------------- */

  detectErrorSpike(ev, cfg) {
    if (!/error|unhandled_rejection|console_error|resource_error/.test(ev.type)) return;
    const windowMs = cfg.errorSpikeWindowMs || 60000;
    const threshold = cfg.errorSpikeThreshold || 5;
    const cutoff = ev.ts - windowMs;
    const errors = this.recent.filter(
      (e) => e.ts >= cutoff && /error|unhandled_rejection|console_error|resource_error/.test(e.type)
    );
    if (errors.length >= threshold && !this.detectorsFired.has(`errorSpike-${Math.floor(ev.ts / windowMs)}`)) {
      this.detectorsFired.add(`errorSpike-${Math.floor(ev.ts / windowMs)}`);
      this.record(
        'error_spike',
        'Error spike detected',
        `${errors.length} errors within ${Math.round(windowMs / 1000)}s on ${ev.url}. This usually means a broken page or failing API.`,
        'negative',
        Math.min(1, errors.length / (threshold * 2))
      );
    }
  }

  detectRapidNavigation(ev, cfg) {
    if (ev.type !== 'navigation') return;
    const windowMs = cfg.rapidNavWindowMs || 30000;
    const threshold = cfg.rapidNavThreshold || 6;
    const cutoff = ev.ts - windowMs;
    const navs = this.recent.filter((e) => e.type === 'navigation' && e.ts >= cutoff);
    if (navs.length >= threshold && !this.detectorsFired.has(`rapidNav-${Math.floor(ev.ts / windowMs)}`)) {
      this.detectorsFired.add(`rapidNav-${Math.floor(ev.ts / windowMs)}`);
      this.record(
        'rapid_navigation',
        'Rapid navigation',
        `User navigated ${navs.length} times in ${Math.round(windowMs / 1000)}s — possibly clicking through results or bouncing.`,
        'hesitation',
        Math.min(1, navs.length / (threshold * 2))
      );
    }
  }

  detectAbandonment(ev, cfg) {
    if (ev.type !== 'page_leave') return;
    const page = this.lastPageView;
    if (!page) return;
    const key = `abandon-${page.url}`;
    if (this.detectorsFired.has(key)) return;
    if (page.textInputs > 2 && !page.submitted) {
      this.detectorsFired.add(key);
      this.record(
        'form_abandonment',
        'Form abandonment',
        `User filled ${page.textInputs} fields on ${page.url} but did not submit the form.`,
        'negative',
        0.75
      );
    }
  }

  detectSessionWarning(ev, cfg) {
    if (ev.type !== 'rage_click') return;
    const key = `rage-${Math.floor(ev.ts / 60000)}`;
    if (this.detectorsFired.has(key)) return;
    this.detectorsFired.add(key);
    const count = ev.data && ev.data.count;
    this.record(
      'frustration',
      'Rage clicking',
      `User rapidly clicked the same element ${count || 3}+ times. A button may be broken, unresponsive or hidden.`,
      'negative',
      0.9
    );
  }

  /* ---- scoring --------------------------------------------------------- */

  frustrationScore() {
    const cfg = this.config.insights || {};
    const stats = {
      rage: this.recent.filter((e) => e.type === 'rage_click').length,
      dead: this.recent.filter((e) => e.type === 'dead_click').length,
      errors: this.recent.filter((e) => /error|unhandled_rejection|console_error|resource_error/.test(e.type)).length,
      nav: this.recent.filter((e) => e.type === 'navigation').length,
      idle: this.recent.filter((e) => e.type === 'idle_start').length,
      copy: this.recent.filter((e) => e.type === 'copy').length,
    };
    const score = Math.min(
      1,
      0.22 * stats.rage + 0.14 * stats.dead + 0.12 * Math.min(5, stats.errors) + 0.08 * Math.min(5, stats.rage + stats.dead + stats.errors) + 0.02 * stats.nav
    );
    return { score: Math.round(score * 100) / 100, stats };
  }

  engagementScore() {
    const recent = this.recent;
    if (recent.length < 5) return 0.5;
    const clicks = recent.filter((e) => e.type === 'click').length;
    const scrolls = recent.filter((e) => e.type === 'scroll').length;
    const inputs = recent.filter((e) => e.type === 'text_input').length;
    const idle = recent.filter((e) => e.type === 'idle_start').length;
    const activity = clicks * 2 + scrolls * 0.5 + inputs * 3;
    const e = Math.min(1, activity / (recent.length * 1.5) + 0.1) - idle * 0.1;
    return Math.max(0, Math.min(1, Math.round(e * 100) / 100));
  }

  /* ---- LLM end-of-session summary -------------------------------------- */

  async endOfSessionSummary(session) {
    const cfg = this.config.insights || {};
    if (!cfg.generateEndOfSessionSummary) return null;
    const vision = this.config.vision || {};
    if (!vision.enabled || !vision.apiKey) return null;

    const top = Object.entries(session.eventTypes || {}).sort((a, b) => b[1] - a[1]).slice(0, 12);
    const pages = (session.pages || []).slice(-10);
    const { score, stats } = this.frustrationScore();

    const rec = {
      id: uuid(),
      ts: now(),
      kind: 'llm',
      type: 'session_summary',
      title: 'End-of-session AI summary',
      body: '',
      signal: score > 0.5 ? 'negative' : 'positive',
      confidence: 0.7,
      sessionId: session.id,
      data: {
        durationMs: session.durationMs || now() - session.startedAt,
        pages,
        topEvents: Object.fromEntries(top),
        frustration: score,
        frustrationStats: stats,
        engagement: this.engagementScore(),
      },
    };
    try {
      const { analyze } = await import('./vision.js');
      const prompt = [
        `Write a concise end-of-session summary for a browsing session.`,
        `Duration: ${Math.round((rec.data.durationMs) / 1000)}s, pages: ${pages.length}.`,
        `Pages: ${pages.map((p) => p.title || p.url).join(' | ')}`,
        `Top events: ${JSON.stringify(rec.data.topEvents)}`,
        `Frustration score: ${score} (stats: ${JSON.stringify(stats)}).`,
        `Return JSON: {"summary":"2-3 sentences","highlights":["..."],"lowlights":["..."],"recommendations":["..."]}`,
      ].join('\n');
      const result = await analyze({
        config: { vision },
        context: { url: (pages[pages.length - 1] || {}).url || '', title: (pages[pages.length - 1] || {}).title || '', recentEvents: [], prompt },
      });
      const raw = result.raw || {};
      rec.body = raw.summary || raw.screen?.summary || result.summary || '';
      rec.data.highlights = raw.highlights || [];
      rec.data.lowlights = raw.lowlights || [];
      rec.data.recommendations = raw.recommendations || [];
      rec.confidence = result.confidence ?? 0.7;
    } catch (e) {
      rec.body = `Automated summary (LLM unavailable: ${e.message.slice(0, 80)}).`;
      rec.confidence = 0.3;
    }
    try {
      await idb.put('insights', rec);
    } catch {}
    if (this.onInsight) this.onInsight(rec);
    return rec;
  }
}
