/**
 * storage.js — chrome.storage helpers + device identity + session persistence.
 */
import { uuid } from '../shared/utils.js';
import * as idb from './idb.js';

export const K = {
  CONFIG: 'vaia:config',
  DEVICE_ID: 'vaia:deviceId',
  SESSION: 'vaia:session',
  META: 'vaia:meta',
  MODE: 'vaia:mode',
};

export async function storageGet(keys) {
  try {
    return await chrome.storage.local.get(keys);
  } catch {
    return {};
  }
}

export async function storageSet(obj) {
  try {
    await chrome.storage.local.set(obj);
  } catch (e) {
    console.warn('[vaia] storageSet failed', e);
  }
}

export async function getDeviceId() {
  const res = await storageGet(K.DEVICE_ID);
  let id = res[K.DEVICE_ID];
  if (!id) {
    id = uuid();
    await storageSet({ [K.DEVICE_ID]: id });
  }
  return id;
}

export async function getMode() {
  const res = await storageGet([K.MODE, K.CONFIG]);
  const cfg = res[K.CONFIG];
  if (cfg && cfg.enabled === false) return 'paused';
  return res[K.MODE] || 'monitor';
}

export async function setMode(mode) {
  await storageSet({ [K.MODE]: mode });
  const res = await storageGet(K.CONFIG);
  const cfg = res[K.CONFIG] || {};
  cfg.enabled = mode !== 'paused';
  await storageSet({ [K.CONFIG]: cfg });
  return mode;
}

/** Persist current session record. */
export async function persistSession(session) {
  try {
    await idb.put('sessions', session.toRecord());
  } catch (e) {
    /* ignore */
  }
  await storageSet({ [K.SESSION]: session.toRecord() });
}
