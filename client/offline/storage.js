import { openOfflineIdb } from './idb.js';

let dbPromise = null;
let dbUserKey = null;

export function getOfflineDbUserKey() {
  return dbUserKey;
}

export async function getOfflineDb({ userKey } = {}) {
  let nextKey = String(userKey || '').trim();
  // Prevent creating `memus_offline_v1_anon` when we already know the real user.
  // Some modules may call getOfflineDb() early (before auth bootstrap finishes).
  if (!nextKey || nextKey === 'anon') {
    try {
      const forced = window?.localStorage?.getItem?.('ttree_offline_user_key_v1') || '';
      const forcedKey = String(forced || '').trim();
      if (forcedKey) nextKey = forcedKey;
    } catch {
      // ignore
    }
  }
  if (!nextKey || nextKey === 'anon') {
    try {
      const raw = window?.localStorage?.getItem?.('ttree_last_user_v1') || '';
      const parsed = raw ? JSON.parse(raw) : null;
      const lastKey = String(parsed?.id || parsed?.username || '').trim();
      if (lastKey) nextKey = lastKey;
    } catch {
      // ignore
    }
  }
  if (!nextKey) nextKey = 'anon';
  if (dbPromise && dbUserKey === nextKey) return dbPromise;
  dbUserKey = nextKey;
  dbPromise = (async () => {
    const db = await openOfflineIdb({ userKey: nextKey });
    return db;
  })();
  return dbPromise;
}
