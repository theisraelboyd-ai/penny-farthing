/* App-state utility module.
 *
 * Manages two small but cross-cutting concerns:
 *
 *   1. Sync dirty-state — whether the user has unsynced data changes.
 *      Tracked via a `mostRecentMutationAt` timestamp written by mutation
 *      entry points, compared against `lastSyncedAt` to decide if the sync
 *      banner should pulse.
 *
 *   2. Privacy mode — a global blur over currency/numeric values for use
 *      when sharing your screen. Persisted in localStorage (synchronous,
 *      so it can apply before the first paint) AND in settings (durable).
 *
 * Both states emit DOM events so views can react without polling.
 */

import { get, put } from './storage/indexeddb.js';

// ============================================================
// Sync state
// ============================================================

const SYNC_DIRTY_EVENT = 'penny-sync-dirty';

/**
 * Record that the user has just made a data-modifying change. Call this
 * from save/edit/delete entry points. Updates the settings record with
 * the current timestamp and emits an event so the banner can re-render.
 */
export async function markDirty() {
  const settings = (await get('settings', 'main')) || { id: 'main' };
  settings.mostRecentMutationAt = new Date().toISOString();
  await put('settings', settings);
  document.dispatchEvent(new CustomEvent(SYNC_DIRTY_EVENT));
}

/**
 * Mark the data as freshly synced. Call this after a successful sync write.
 */
export async function markSynced() {
  const settings = (await get('settings', 'main')) || { id: 'main' };
  settings.lastSyncedAt = new Date().toISOString();
  await put('settings', settings);
  document.dispatchEvent(new CustomEvent(SYNC_DIRTY_EVENT));
}

/**
 * Inspect current dirty state. Returns an object describing what we know.
 */
export async function getSyncState() {
  const settings = (await get('settings', 'main')) || {};
  const mostRecentMutationAt = settings.mostRecentMutationAt || null;
  const lastSyncedAt = settings.lastSyncedAt || null;
  // Sync configured? Either a connected file handle (Chromium) or at minimum
  // the user has used Export at some point so they know how to back up.
  const syncConfigured = settings.syncFileConfigured === true;

  let isDirty = false;
  if (mostRecentMutationAt && (!lastSyncedAt || mostRecentMutationAt > lastSyncedAt)) {
    isDirty = true;
  }
  return { isDirty, mostRecentMutationAt, lastSyncedAt, syncConfigured };
}

/**
 * Subscribe to dirty-state changes. Returns an unsubscribe function.
 */
export function onSyncDirtyChange(handler) {
  document.addEventListener(SYNC_DIRTY_EVENT, handler);
  return () => document.removeEventListener(SYNC_DIRTY_EVENT, handler);
}

// ============================================================
// Privacy mode
// ============================================================

const PRIVACY_KEY = 'penny-farthing-privacy';
const PRIVACY_EVENT = 'penny-privacy-toggle';

/**
 * Read the privacy mode synchronously from localStorage. Used at app
 * start to apply the blur class before any data renders, preventing
 * the brief "values visible then hidden" flash.
 */
export function readPrivacySync() {
  try {
    return localStorage.getItem(PRIVACY_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Apply the privacy mode class to the document root.
 */
export function applyPrivacyToDom(on) {
  document.documentElement.classList.toggle('is-privacy', !!on);
}

/**
 * Toggle privacy mode. Updates localStorage immediately AND the settings
 * record (durable). Emits an event so any hot-rendered view can react.
 */
export async function setPrivacyMode(on) {
  try {
    localStorage.setItem(PRIVACY_KEY, on ? '1' : '0');
  } catch { /* private browsing might block this; fail open */ }
  applyPrivacyToDom(on);
  // Best-effort persistence to settings (won't crash if storage is offline)
  try {
    const settings = (await get('settings', 'main')) || { id: 'main' };
    settings.privacyMode = !!on;
    await put('settings', settings);
  } catch { /* not fatal */ }
  document.dispatchEvent(new CustomEvent(PRIVACY_EVENT, { detail: { on: !!on } }));
}

export function isPrivacyOn() {
  return document.documentElement.classList.contains('is-privacy');
}

export function onPrivacyChange(handler) {
  document.addEventListener(PRIVACY_EVENT, handler);
  return () => document.removeEventListener(PRIVACY_EVENT, handler);
}
