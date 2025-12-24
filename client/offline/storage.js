import { PGlite } from './pglite.bundle.js';

let dbPromise = null;
let dbUserKey = null;

export async function getOfflineDb({ userKey } = {}) {
  const nextKey = userKey || 'anon';
  if (dbPromise && dbUserKey === nextKey) return dbPromise;
  dbUserKey = nextKey;
  dbPromise = (async () => {
    // PGlite persistence in IndexedDB.
    const url = `idb://memus_${String(nextKey).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    const db = new PGlite(url);
    return db;
  })();
  return dbPromise;
}

