import { openOfflineIdb } from './idb.js';

let dbPromise = null;
let dbUserKey = null;

export async function getOfflineDb({ userKey } = {}) {
  const nextKey = userKey || 'anon';
  if (dbPromise && dbUserKey === nextKey) return dbPromise;
  dbUserKey = nextKey;
  dbPromise = (async () => {
    const db = await openOfflineIdb({ userKey: nextKey });
    return db;
  })();
  return dbPromise;
}
