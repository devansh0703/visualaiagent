/**
 * db.js — outbound sync engine. A single IndexedDB store doubles as the local
 * archive and the offline outbound queue. Events/screenshots/insights are
 * drained in batches to the configured REST endpoint with exponential backoff,
 * retry caps, and per-record sent/failed state so nothing is lost offline.
 */
import { now } from '../shared/utils.js';
import * as idb from './idb.js';
import { captureLog, inc, counter } from './telemetry.js';

let configRef = null;
let flushTimer = null;
let inFlight = false;
let lastFlushAt = 0;
let lastFlushStatus = 'idle';
let lastFlushError = '';

export function initDb({ getConfig }) {
  configRef = getConfig;
  scheduleNext(2000);
  return { flushNow, getStatus, getQueueStats };
}

export function baseOf(endpoint) {
  const m = /^(.*)\/[^/]+$/.exec((endpoint || '').replace(/\/+$/, ''));
  return m ? m[1] : endpoint || '';
}

export function scheduleNext(delayMs) {
  if (flushTimer) clearTimeout(flushTimer);
  const cfg = (configRef && configRef()) || {};
  const interval = Math.max(2000, cfg.db && cfg.db.flushIntervalMs ? cfg.db.flushIntervalMs : 10000);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushNow();
  }, delayMs != null ? delayMs : interval);
}

/** Serialize + mark an event record for outbound sync. */
export function enqueue(store, record) {
  record.sent = false;
  record.failed = false;
  record.attempts = 0;
  record._queue = true;
  inc(`queued_${store}`);
  return idb.put(store, record);
}

async function drain(store, { batchSize, url, buildBody, mark }) {
  const cfg = (configRef && configRef()) || {};
  if (!url) return 0;
  const maxRetries = cfg.db && cfg.db.maxRetries != null ? cfg.db.maxRetries : 6;
  const batch = [];
  await idb.each(store, {
    index: 'ts',
    direction: 'next',
    limit: batchSize,
    onEach: (rec) => {
      if (rec.sent || rec.failed) return;
      if ((rec.attempts || 0) >= maxRetries) {
        rec.failed = true;
        idb.put(store, rec);
        return;
      }
      batch.push(rec);
    },
  });
  if (!batch.length) return 0;
  const headers = { 'Content-Type': 'application/json' };
  const dbCfg = cfg.db || {};
  if (dbCfg.apiKey) headers['x-api-key'] = dbCfg.apiKey;
  for (const [k, v] of Object.entries(dbCfg.headers || {})) headers[k] = v;

  let ok = false;
  let errMsg = '';
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(buildBody(batch)),
      keepalive: false,
    });
    if (res.ok) {
      ok = true;
    } else {
      errMsg = `HTTP ${res.status}`;
      captureLog('error', `db flush ${store} failed: ${errMsg} ${url}`);
    }
  } catch (e) {
    errMsg = e.message;
    captureLog('error', `db flush ${store} network error: ${errMsg}`);
  }

  const at = now();
  if (ok) {
    for (const rec of batch) {
      rec.sent = true;
      rec.sentAt = at;
      rec.attempts = (rec.attempts || 0) + 1;
      idb.put(store, rec);
    }
    inc(`sent_${store}`, batch.length);
    return batch.length;
  }
  const retryBase = dbCfg.retryBaseMs != null ? dbCfg.retryBaseMs : 1500;
  for (const rec of batch) {
    rec.attempts = (rec.attempts || 0) + 1;
    rec.lastAttemptAt = at;
    rec.nextRetryAt = at + retryBase * 2 ** Math.min(rec.attempts, 6);
    idb.put(store, rec);
  }
  lastFlushError = errMsg;
  return 0;
}

/** Drain all three stores. Returns number of records sent. */
export async function flushNow() {
  if (inFlight) return 0;
  inFlight = true;
  try {
    const cfg = (configRef && configRef()) || {};
    const db = cfg.db || {};
    if (!db.endpoint) {
      lastFlushStatus = 'unconfigured';
      scheduleNext();
      return 0;
    }
    let sent = 0;
    lastFlushStatus = 'flushing';
    if (db.sendEvents !== false) {
      sent += await drain('events', {
        batchSize: db.batchSize || 25,
        url: db.endpoint,
        buildBody: (batch) => ({
          kind: 'events',
          ts: now(),
          deviceId: cfg._deviceId,
          userId: cfg._userId,
          events: batch.map((r) => r),
        }),
      });
    }
    if (db.sendScreenshots) {
      sent += await drain('screenshots', {
        batchSize: 2,
        url: db.screenshotEndpoint || baseOf(db.endpoint) + '/screenshots',
        buildBody: (batch) => ({ kind: 'screenshots', ts: now(), deviceId: cfg._deviceId, userId: cfg._userId, screenshots: batch.map((r) => r) }),
      });
    }
    if (db.sendInsights !== false) {
      sent += await drain('insights', {
        batchSize: db.batchSize || 25,
        url: db.insightEndpoint || baseOf(db.endpoint) + '/insights',
        buildBody: (batch) => ({ kind: 'insights', ts: now(), deviceId: cfg._deviceId, userId: cfg._userId, insights: batch.map((r) => r) }),
      });
    }
    lastFlushAt = now();
    lastFlushStatus = sent > 0 ? 'ok' : 'idle';
    inc('flush_count');
  } finally {
    inFlight = false;
    scheduleNext();
  }
}

export function getStatus() {
  return {
    lastFlushAt,
    lastFlushStatus,
    lastFlushError,
    inFlight,
    sentEvents: counter('sent_events'),
    sentScreenshots: counter('sent_screenshots'),
    sentInsights: counter('sent_insights'),
    queue: counter('queued_events'),
  };
}

export async function getQueueStats() {
  let unsent = 0;
  let failed = 0;
  await idb.each('events', {
    index: 'ts',
    onEach: (rec) => {
      if (rec.failed) failed++;
      else if (!rec.sent) unsent++;
    },
  });
  return { unsent, failed, total: unsent + failed, screenshots: await idb.count('screenshots'), insights: await idb.count('insights') };
}
