/* Penny Farthing — IndexedDB Wrapper
 *
 * A minimal promisified API over IndexedDB.
 * All methods return Promises; errors are always rejections.
 */

import { DB_NAME, DB_VERSION, STORES } from './schema.js';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = event.target.result;

      for (const [storeName, storeDef] of Object.entries(STORES)) {
        if (db.objectStoreNames.contains(storeName)) continue;
        const store = db.createObjectStore(storeName, { keyPath: storeDef.keyPath });
        for (const idx of (storeDef.indexes || [])) {
          store.createIndex(idx.name, idx.keyPath, idx.options || {});
        }
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB open blocked — close other tabs running this app.'));
  });

  return dbPromise;
}

async function tx(storeName, mode = 'readonly') {
  const db = await openDb();
  const t = db.transaction(storeName, mode);
  return t.objectStore(storeName);
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/* ============================================================
   Public API
   ============================================================ */

// ============================================================
// Dirty-marker hook
// ============================================================
// `markDirty` is supplied by app-state.js after init. It bumps a timestamp
// on the settings record. We can't import it directly here without creating
// a circular dependency (app-state needs put/get from this module), so it
// registers itself via setMutationHook(). Writes to the settings store
// itself are skipped to avoid infinite recursion.

let _mutationHook = null;
export function setMutationHook(fn) {
  _mutationHook = fn;
}

function notifyMutation(storeName) {
  // Don't recurse through our own dirty-marker writes
  if (storeName === 'settings') return;
  if (typeof _mutationHook === 'function') {
    // Fire and forget — mutation tracking shouldn't block actual saves
    Promise.resolve(_mutationHook()).catch(() => { /* swallow */ });
  }
}

export async function put(storeName, record) {
  const store = await tx(storeName, 'readwrite');
  const result = await reqToPromise(store.put(record));
  notifyMutation(storeName);
  return result;
}

export async function get(storeName, key) {
  const store = await tx(storeName);
  const result = await reqToPromise(store.get(key));
  return result || null;
}

export async function getAll(storeName) {
  const store = await tx(storeName);
  return reqToPromise(store.getAll());
}

export async function remove(storeName, key) {
  const store = await tx(storeName, 'readwrite');
  const result = await reqToPromise(store.delete(key));
  notifyMutation(storeName);
  return result;
}

export async function clear(storeName) {
  const store = await tx(storeName, 'readwrite');
  const result = await reqToPromise(store.clear());
  notifyMutation(storeName);
  return result;
}

export async function count(storeName) {
  const store = await tx(storeName);
  return reqToPromise(store.count());
}

/**
 * Query an index for all records with a given value.
 */
export async function getAllByIndex(storeName, indexName, value) {
  const store = await tx(storeName);
  const index = store.index(indexName);
  return reqToPromise(index.getAll(value));
}

/**
 * Bulk insert within a single transaction.
 */
export async function putMany(storeName, records) {
  const store = await tx(storeName, 'readwrite');
  return Promise.all(records.map((r) => reqToPromise(store.put(r))));
}

/**
 * Export everything for backup / Gist sync.
 */
export async function exportAll() {
  const out = {};
  for (const storeName of Object.keys(STORES)) {
    out[storeName] = await getAll(storeName);
  }
  out._meta = {
    exportedAt: new Date().toISOString(),
    dbVersion: DB_VERSION,
    app: 'penny-farthing',
  };
  return out;
}

/**
 * Import a full backup (overwrites all data — caller must confirm).
 */
export async function importAll(data) {
  for (const storeName of Object.keys(STORES)) {
    if (!data[storeName]) continue;
    await clear(storeName);
    await putMany(storeName, data[storeName]);
  }
}

/**
 * Generate a UUID. Prefers crypto.randomUUID, falls back otherwise.
 */
export function uuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // fallback (RFC4122 v4-ish)
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
