import { state } from '../state.js';
import { showToast } from '../toast.js';
import { getOfflineDb } from './storage.js';
import { idbPing } from './idb.js';

let initPromise = null;
let currentUserKey = null;

const PERF_KEY = 'ttree_profile_v1';
function perfEnabled() {
  try {
    return window?.localStorage?.getItem?.(PERF_KEY) === '1';
  } catch {
    return false;
  }
}
function perfLog(label, data = {}) {
  try {
    if (!perfEnabled()) return;
    // eslint-disable-next-line no-console
    console.log('[perf][offline]', label, data);
  } catch {
    // ignore
  }
}

function buildUserKey(user) {
  return (user && (user.id || user.username)) || 'anon';
}

export async function initOfflineForUser(user) {
  const key = buildUserKey(user);
  if (initPromise && currentUserKey === key) return initPromise;
  currentUserKey = key;
  initPromise = (async () => {
    const t0 = perfEnabled() ? performance.now() : 0;
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
      const tDb = perfEnabled() ? performance.now() : 0;
      const db = await getOfflineDb({ userKey: key });
      if (tDb) perfLog('getOfflineDb()', { ms: Math.round(performance.now() - tDb) });

      const tPing = perfEnabled() ? performance.now() : 0;
      await idbPing(db);
      if (tPing) perfLog('idb.ping', { ms: Math.round(performance.now() - tPing) });
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
      if (t0) perfLog('initOfflineForUser.total', { userKey: key, ms: Math.round(performance.now() - t0) });
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
