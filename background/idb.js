/**
 * idb.js — minimal promise wrapper over IndexedDB used by the service worker
 * for the telemetry archive / outbound queue, screenshots and insights.
 */
let dbPromise = null;

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('vaia-db', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of ['events', 'screenshots', 'insights', 'sessions']) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
      }
      const ev = req.transaction.objectStore('events');
      if (!ev.indexNames.contains('ts')) ev.createIndex('ts', 'ts');
      if (!ev.indexNames.contains('sessionId')) ev.createIndex('sessionId', 'sessionId');
      if (!ev.indexNames.contains('sent')) ev.createIndex('sent', 'sent');
      const sh = req.transaction.objectStore('screenshots');
      if (!sh.indexNames.contains('ts')) sh.createIndex('ts', 'ts');
      const in2 = req.transaction.objectStore('insights');
      if (!in2.indexNames.contains('ts')) in2.createIndex('ts', 'ts');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getDB() {
  if (!dbPromise) dbPromise = open();
  return dbPromise;
}

export async function put(store, obj) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(obj);
    tx.oncomplete = () => resolve(obj.id);
    tx.onerror = () => reject(tx.error);
  });
}

export async function putMany(store, objs) {
  if (!objs.length) return;
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    for (const o of objs) os.put(o);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function get(store, id) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function count(store) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteMany(store, ids) {
  if (!ids.length) return;
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    for (const id of ids) os.delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Stream all records of a store/index ordered by key (asc by default). */
export async function each(store, { index, direction = 'next', limit = Infinity, onEach } = {}) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const source = index ? db.transaction(store, 'readonly').objectStore(store).index(index) : db.transaction(store, 'readonly').objectStore(store);
    const req = source.openCursor(null, direction);
    let n = 0;
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor || n >= limit) return resolve();
      n++;
      const keep = onEach(cursor.value, cursor);
      if (keep === false) return resolve();
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

export async function getByIndex(store, index, key, limit = 100) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const out = [];
    const os = db.transaction(store, 'readonly').objectStore(store);
    const idx = os.index(index);
    const req = idx.getAll(key, limit);
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteOlderThan(store, cutoffTs) {
  const db = await getDB();
  const toDelete = [];
  await each(store, {
    index: 'ts',
    onEach: (rec) => {
      if (rec.ts < cutoffTs) toDelete.push(rec.id);
    },
  });
  await deleteMany(store, toDelete);
  return toDelete.length;
}

export async function clearStore(store) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteById(store, id) {
  return deleteMany(store, [id]);
}

export async function bulkGet(store, ids) {
  const db = await getDB();
  const out = [];
  await Promise.all(
    ids.map(
      (id) =>
        new Promise((resolve) => {
          const req = db.transaction(store, 'readonly').objectStore(store).get(id);
          req.onsuccess = () => {
            if (req.result) out.push(req.result);
            resolve();
          };
          req.onerror = () => resolve();
        })
    )
  );
  return out;
}
