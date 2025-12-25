import { state } from '../state.js';
import { showToast } from '../toast.js';
import { getOfflineDb } from './storage.js';
import { migrateOfflineDb } from './migrations.js';

let initPromise = null;
let currentUserKey = null;

function buildUserKey(user) {
  return (user && (user.id || user.username)) || 'anon';
}

export async function initOfflineForUser(user) {
  const key = buildUserKey(user);
  if (initPromise && currentUserKey === key) return initPromise;
  currentUserKey = key;
  initPromise = (async () => {
    state.offlineReady = false;
    state.offlineInitStatus = 'initializing';
    state.offlineInitError = '';
    state.offlineInitStartedAt = Date.now();
    try {
      // eslint-disable-next-line no-console
      console.log('[offline] init start', { userKey: key });
    } catch {
      // ignore
    }
    try {
      const db = await getOfflineDb({ userKey: key });
      await migrateOfflineDb(db);
      try {
        if (navigator?.storage?.persist) {
          navigator.storage.persist().catch(() => {});
        }
      } catch {
        // ignore
      }
      state.offlineReady = true;
      state.offlineInitStatus = 'ready';
      state.offlineInitError = '';
      state.offlineInitStartedAt = null;
      try {
        // eslint-disable-next-line no-console
        console.log('[offline] init ready');
      } catch {
        // ignore
      }
      return db;
    } catch (err) {
      state.offlineReady = false;
      state.offlineInitStatus = 'error';
      state.offlineInitStartedAt = null;
      try {
        console.error('[offline] init failed', err);
      } catch {
        // ignore
      }
      const msg = err?.message ? `Offline база недоступна: ${err.message}` : 'Offline база недоступна в этом браузере';
      state.offlineInitError = msg;
      showToast(msg);
      throw err;
    }
  })();
  return initPromise;
}

export async function getOfflineDbReady() {
  if (initPromise) return initPromise;
  return initOfflineForUser(state.currentUser);
}
