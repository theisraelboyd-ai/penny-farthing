/* Sync — data export/import + local-file sync.
 *
 * Three layers, simplest to most capable:
 *
 *   1. exportAllData / importAllData — JSON serialise/deserialise of the
 *      entire IndexedDB. Universal foundation.
 *
 *   2. clipboardExport / textImport — convenience wrappers that work on
 *      any browser, any device. The "always works" fallback.
 *
 *   3. connectLocalSyncFile / writeToSyncFile — File System Access API
 *      for pick-a-folder-and-the-app-writes-to-it. Chrome/Edge only.
 *      Used in tandem with the user's OneDrive/Dropbox/iCloud desktop
 *      sync client to get cross-device propagation without OAuth.
 */

import { getAll, put, remove } from './storage/indexeddb.js';

const SCHEMA_VERSION = 2;
const STORES = ['accounts', 'assets', 'transactions', 'taxYears', 'settings'];

// ============================================================
// Layer 1: export/import as JSON
// ============================================================

export async function exportAllData() {
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    app: 'Penny Farthing',
    appVersion: '1.17',
    data: {},
  };
  for (const store of STORES) {
    payload.data[store] = await getAll(store);
  }
  return payload;
}

/**
 * Replace the entire DB with the imported payload. Mode: 'replace' (default)
 * fully wipes existing records before importing; 'merge' upserts by id.
 */
export async function importAllData(payload, mode = 'replace') {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid backup file');
  }
  if (!payload.data) {
    throw new Error('Backup file has no data section');
  }
  if (payload.schemaVersion && payload.schemaVersion > SCHEMA_VERSION) {
    throw new Error(`Backup is from a newer app version (schema ${payload.schemaVersion}). Update the app first.`);
  }

  for (const store of STORES) {
    const incoming = payload.data[store] || [];
    if (mode === 'replace') {
      const existing = await getAll(store);
      // Preserve a copy of the privacy/sync local state if the incoming
      // settings record doesn't have it. Avoids losing per-device state
      // (privacy mode is local UI, not portable data).
      let preservedPrivacy = null;
      if (store === 'settings') {
        const oldMain = existing.find((r) => r.id === 'main');
        if (oldMain) {
          preservedPrivacy = {
            privacyMode: oldMain.privacyMode,
            syncFileConfigured: oldMain.syncFileConfigured,
          };
        }
      }
      for (const rec of existing) {
        const key = rec.id ?? rec.year;
        if (key !== undefined) await remove(store, key);
      }
      for (const rec of incoming) {
        if (store === 'settings' && rec.id === 'main' && preservedPrivacy) {
          rec.privacyMode = preservedPrivacy.privacyMode ?? rec.privacyMode;
          // syncFileConfigured stays per-device — don't overwrite if local had it
          if (preservedPrivacy.syncFileConfigured) {
            rec.syncFileConfigured = preservedPrivacy.syncFileConfigured;
          }
        }
        await put(store, rec);
      }
    } else {
      // Merge mode — upsert each record by id
      for (const rec of incoming) {
        await put(store, rec);
      }
    }
  }
  return {
    counts: Object.fromEntries(
      STORES.map((s) => [s, (payload.data[s] || []).length])
    ),
  };
}

// ============================================================
// Layer 2: clipboard / text
// ============================================================

export async function clipboardExport() {
  const data = await exportAllData();
  const text = JSON.stringify(data, null, 2);
  await navigator.clipboard.writeText(text);
  return { bytes: text.length };
}

export async function textImport(text, mode = 'replace') {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (err) {
    throw new Error('Pasted text is not valid JSON. Check that you copied the whole backup.');
  }
  return importAllData(payload, mode);
}

// ============================================================
// Layer 3: File System Access API — local-file sync
// ============================================================

let activeFileHandle = null;

/**
 * Detect whether the browser supports the File System Access API.
 * Chromium-based desktop browsers do; Safari and Firefox don't.
 */
export function localFileSyncSupported() {
  return typeof window.showSaveFilePicker === 'function'
    && typeof window.showOpenFilePicker === 'function';
}

/**
 * Prompt the user to create or pick a sync file. The handle is kept
 * in memory for the session. On a refresh the user has to re-pick
 * (the API doesn't allow persistent handles in localStorage cross-session
 * for security reasons — they'd have to be stored in IndexedDB which is
 * possible but adds complexity. Acceptable trade-off for now: re-pick
 * each session is fine for a tool used periodically.)
 */
export async function connectLocalSyncFile() {
  if (!localFileSyncSupported()) {
    throw new Error('Local file sync requires Chrome, Edge, or another Chromium-based browser on desktop. Use Export to clipboard instead.');
  }
  // Show a save-file picker so user can place it in their OneDrive folder
  const handle = await window.showSaveFilePicker({
    suggestedName: 'penny-farthing-data.json',
    types: [{
      description: 'Penny Farthing backup',
      accept: { 'application/json': ['.json'] },
    }],
  });
  activeFileHandle = handle;
  // Mark settings so we know the user has connected at some point
  const { put, get } = await import('./storage/indexeddb.js');
  const settings = (await get('settings', 'main')) || { id: 'main' };
  settings.syncFileConfigured = true;
  settings.syncFileName = handle.name;
  await put('settings', settings);
  // Write current data to the file immediately so it's not empty
  await writeToSyncFile();
  return { ok: true, name: handle.name };
}

/**
 * Pick an existing sync file to LOAD data from.
 */
export async function loadFromSyncFile() {
  if (!localFileSyncSupported()) {
    throw new Error('Local file sync requires a Chromium-based desktop browser. Use Import from text instead.');
  }
  const [handle] = await window.showOpenFilePicker({
    types: [{
      description: 'Penny Farthing backup',
      accept: { 'application/json': ['.json'] },
    }],
    multiple: false,
  });
  const file = await handle.getFile();
  const text = await file.text();
  const payload = JSON.parse(text);
  const result = await importAllData(payload, 'replace');
  // Keep this handle for future writes
  activeFileHandle = handle;
  const { put, get } = await import('./storage/indexeddb.js');
  const settings = (await get('settings', 'main')) || { id: 'main' };
  settings.syncFileConfigured = true;
  settings.syncFileName = handle.name;
  await put('settings', settings);
  return result;
}

/**
 * Write the current full DB to the connected sync file. Errors if no
 * file is connected in this session.
 */
export async function writeToSyncFile() {
  if (!activeFileHandle) {
    throw new Error('No sync file connected this session. Click "Connect sync file" to pick one.');
  }
  // Re-request permission if needed (Chromium policy)
  const opts = { mode: 'readwrite' };
  if (await activeFileHandle.queryPermission(opts) !== 'granted') {
    const result = await activeFileHandle.requestPermission(opts);
    if (result !== 'granted') {
      throw new Error('Permission to write to the sync file was denied.');
    }
  }
  const data = await exportAllData();
  const writable = await activeFileHandle.createWritable();
  await writable.write(JSON.stringify(data, null, 2));
  await writable.close();
  return { ok: true, name: activeFileHandle.name };
}

export function isLocalFileConnected() {
  return activeFileHandle !== null;
}
