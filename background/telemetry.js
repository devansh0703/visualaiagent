/**
 * telemetry.js — in-memory diagnostic ring buffer + lightweight counters for
 * internal status (used by popup/dashboard). Not persisted.
 */
const MAX = 300;
const log = [];
const counters = {};
let lastErrorAt = 0;

export function captureLog(level, message, extra = null) {
  const entry = { ts: Date.now(), level, message, extra };
  log.push(entry);
  if (log.length > MAX) log.shift();
  if (level === 'error') lastErrorAt = Date.now();
  if (level === 'error') {
    try {
      console.error('[vaia]', message, extra || '');
    } catch {}
  }
  return entry;
}

export function inc(name, by = 1) {
  counters[name] = (counters[name] || 0) + by;
  return counters[name];
}

export function counter(name) {
  return counters[name] || 0;
}

export function snapshot() {
  return { log: [...log], counters: { ...counters }, lastErrorAt };
}
