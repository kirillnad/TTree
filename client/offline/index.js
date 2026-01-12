import { state } from '../state.js';
import { showToast } from '../toast.js';
import { getOfflineDb } from './storage.js';
import { idbPing } from './idb.js';

let initPromise = null;
let currentUserKey = null;
let initAttempt = 0;
let loggedStartAttempt = null;
let loggedResultAttempt = null;

const PERF_KEY = 'ttree_profile_v1';
const DEBUG_OFFLINE_KEY = 'ttree_debug_offline_v1';
function perfEnabled() {
  try {
    return window?.localStorage?.getItem?.(PERF_KEY) === '1';
  } catch {
    return false;
  }
}
function debugOfflineEnabled() {
  try {
    return window?.localStorage?.getItem?.(DEBUG_OFFLINE_KEY) === '1';
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

function getBuildIdSafe() {
  try {
    const id = window.__BUILD_ID__;
    return id ? String(id) : '';
  } catch {
    return '';
  }
}

function postClientLog(kind, data) {
  try {
    fetch('/api/client/log', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, data }),
    }).catch(() => {});
  } catch {
    // ignore
  }
}

async function gatherOfflineEnvInfo() {
  const info = {};
  try {
    info.ua = navigator?.userAgent || '';
  } catch {
    info.ua = '';
  }
  try {
    info.buildId = getBuildIdSafe();
  } catch {
    info.buildId = '';
  }
  try {
    info.onLine = navigator?.onLine !== false;
  } catch {
    info.onLine = null;
  }
  try {
    info.indexedDB = typeof indexedDB !== 'undefined';
  } catch {
    info.indexedDB = null;
  }
  try {
    info.storagePersist = typeof navigator?.storage?.persist === 'function';
  } catch {
    info.storagePersist = null;
  }
  try {
    info.storageEstimate = typeof navigator?.storage?.estimate === 'function';
  } catch {
    info.storageEstimate = null;
  }
  try {
    if (navigator?.storage?.estimate) {
      const est = await navigator.storage.estimate().catch(() => null);
      if (est && typeof est === 'object') {
        info.quota = Number(est.quota || 0) || null;
        info.usage = Number(est.usage || 0) || null;
      }
    }
  } catch {
    // ignore
  }
  return info;
}

function buildUserKey(user) {
  try {
    const forced = window?.localStorage?.getItem?.('ttree_offline_user_key_v1') || '';
    const k = String(forced || '').trim();
    if (k) return k;
  } catch {
    // ignore
  }
  return (user && (user.id || user.username)) || 'anon';
}

export async function initOfflineForUser(user) {
  const key = buildUserKey(user);
  if (initPromise && currentUserKey === key) return initPromise;
  currentUserKey = key;
  initAttempt += 1;
  const attempt = initAttempt;
  initPromise = (async () => {
    const t0 = perfEnabled() ? performance.now() : 0;
    state.offlineReady = false;
    state.offlineInitStatus = 'initializing';
    state.offlineInitError = '';
    state.offlineInitStartedAt = Date.now();
    try {
      if (loggedStartAttempt !== attempt) {
        loggedStartAttempt = attempt;
        const env = await gatherOfflineEnvInfo().catch(() => ({}));
        postClientLog('offline.init.start', {
          t: new Date().toISOString(),
          attempt,
          userKey: key,
          env,
        });
      }
    } catch {
      // ignore
    }
    try {
      if (debugOfflineEnabled()) {
        // eslint-disable-next-line no-console
        console.log('[offline] init start', { userKey: key });
      }
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
        if (loggedResultAttempt !== attempt) {
          loggedResultAttempt = attempt;
          const env = await gatherOfflineEnvInfo().catch(() => ({}));
          postClientLog('offline.init.ready', {
            t: new Date().toISOString(),
            attempt,
            userKey: key,
            env,
          });
        }
      } catch {
        // ignore
      }
      try {
        if (debugOfflineEnabled()) {
          // eslint-disable-next-line no-console
          console.log('[offline] init ready');
        }
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
      try {
        if (loggedResultAttempt !== attempt) {
          loggedResultAttempt = attempt;
          const env = await gatherOfflineEnvInfo().catch(() => ({}));
          postClientLog('offline.init.failed', {
            t: new Date().toISOString(),
            attempt,
            userKey: key,
            msg,
            err: {
              name: String(err?.name || ''),
              message: String(err?.message || ''),
              stack: String(err?.stack || '').slice(0, 1500),
            },
            env,
          });
        }
      } catch {
        // ignore
      }
      throw err;
    }
  })();
  return initPromise;
}

export async function getOfflineDbReady() {
  if (initPromise) return initPromise;
  return initOfflineForUser(state.currentUser);
}
