function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB request failed'));
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
  });
}

function sanitizeKey(key) {
  return String(key || 'anon').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function dbNameForUser(userKey) {
  return `memus_offline_v1_${sanitizeKey(userKey)}`;
}

const DB_VERSION = 4;

const KNOWN_USER_KEYS_KEY = 'ttree_offline_known_user_keys_v1';

function rememberKnownUserKey(userKey) {
  try {
    const key = String(userKey || '').trim();
    if (!key) return;
    const raw = window?.localStorage?.getItem?.(KNOWN_USER_KEYS_KEY) || '[]';
    const arr = JSON.parse(raw);
    const list = Array.isArray(arr) ? arr : [];
    if (!list.includes(key)) list.push(key);
    window.localStorage.setItem(KNOWN_USER_KEYS_KEY, JSON.stringify(list.slice(-200)));
  } catch {
    // ignore
  }
}

export async function openOfflineIdb({ userKey } = {}) {
  const key = userKey || 'anon';
  rememberKnownUserKey(key);
  const name = dbNameForUser(key);
  const req = indexedDB.open(name, DB_VERSION);
  req.onupgradeneeded = () => {
    const db = req.result;

    if (!db.objectStoreNames.contains('meta')) {
      db.createObjectStore('meta', { keyPath: 'key' });
    }

    if (!db.objectStoreNames.contains('articles')) {
      const store = db.createObjectStore('articles', { keyPath: 'id' });
      store.createIndex('byUpdatedAt', 'updatedAt', { unique: false });
      store.createIndex('byDeletedAt', 'deletedAt', { unique: false });
    }

    if (!db.objectStoreNames.contains('outline_sections')) {
      const store = db.createObjectStore('outline_sections', { keyPath: 'sectionId' });
      store.createIndex('byArticleId', 'articleId', { unique: false });
      store.createIndex('byUpdatedAt', 'updatedAt', { unique: false });
    }

    if (!db.objectStoreNames.contains('section_embeddings')) {
      const store = db.createObjectStore('section_embeddings', { keyPath: 'sectionId' });
      store.createIndex('byArticleId', 'articleId', { unique: false });
      store.createIndex('byUpdatedAt', 'updatedAt', { unique: false });
    }

    if (!db.objectStoreNames.contains('media_assets')) {
      const store = db.createObjectStore('media_assets', { keyPath: 'url' });
      store.createIndex('byStatus', 'status', { unique: false });
      store.createIndex('byFetchedAtMs', 'fetchedAtMs', { unique: false });
      store.createIndex('byStatusFetchedAtMs', ['status', 'fetchedAtMs'], { unique: false });
    }

    if (!db.objectStoreNames.contains('media_refs')) {
      const store = db.createObjectStore('media_refs', { keyPath: 'key' });
      store.createIndex('byArticleId', 'articleId', { unique: false });
      store.createIndex('byUrl', 'url', { unique: false });
    }

    if (!db.objectStoreNames.contains('outbox')) {
      const store = db.createObjectStore('outbox', { keyPath: 'id' });
      store.createIndex('byCreatedAtMs', 'createdAtMs', { unique: false });
      store.createIndex('byTypeArticleId', ['type', 'articleId'], { unique: false });
      store.createIndex('byTypeCoalesceKey', ['type', 'coalesceKey'], { unique: false });
    } else {
      // Upgrade: add new index for fine-grained coalescing (e.g. per section).
      // eslint-disable-next-line no-undef
      const tx = req.transaction;
      try {
        const store = tx.objectStore('outbox');
        if (!store.indexNames.contains('byTypeCoalesceKey')) {
          store.createIndex('byTypeCoalesceKey', ['type', 'coalesceKey'], { unique: false });
        }
      } catch {
        // ignore
      }
    }

    if (!db.objectStoreNames.contains('pending_uploads')) {
      const store = db.createObjectStore('pending_uploads', { keyPath: 'token' });
      store.createIndex('byArticleId', 'articleId', { unique: false });
      store.createIndex('byCreatedAtMs', 'createdAtMs', { unique: false });
    }

    if (!db.objectStoreNames.contains('tags_global')) {
      const store = db.createObjectStore('tags_global', { keyPath: 'key' });
      store.createIndex('byCount', 'count', { unique: false });
      store.createIndex('byLastSeenAtMs', 'lastSeenAtMs', { unique: false });
    }

    if (!db.objectStoreNames.contains('tags_by_article')) {
      const store = db.createObjectStore('tags_by_article', { keyPath: 'articleId' });
      store.createIndex('byUpdatedAt', 'updatedAt', { unique: false });
    }
  };

  const db = await reqToPromise(req);
  try {
    db.onversionchange = () => {
      try {
        db.close();
      } catch {
        // ignore
      }
    };
  } catch {
    // ignore
  }
  return db;
}

export async function idbGet(db, storeName, key) {
  const tx = db.transaction([storeName], 'readonly');
  const store = tx.objectStore(storeName);
  const value = await reqToPromise(store.get(key));
  await txDone(tx);
  return value;
}

export async function idbPut(db, storeName, value) {
  const tx = db.transaction([storeName], 'readwrite');
  const store = tx.objectStore(storeName);
  await reqToPromise(store.put(value));
  await txDone(tx);
}

export async function idbDelete(db, storeName, key) {
  const tx = db.transaction([storeName], 'readwrite');
  const store = tx.objectStore(storeName);
  await reqToPromise(store.delete(key));
  await txDone(tx);
}

export async function idbCount(db, storeName) {
  const tx = db.transaction([storeName], 'readonly');
  const store = tx.objectStore(storeName);
  const n = await reqToPromise(store.count());
  await txDone(tx);
  return Number(n || 0);
}

export async function idbGetAll(db, storeName) {
  const tx = db.transaction([storeName], 'readonly');
  const store = tx.objectStore(storeName);
  const items = await reqToPromise(store.getAll());
  await txDone(tx);
  return Array.isArray(items) ? items : [];
}

export async function idbPing(db) {
  const tx = db.transaction(['meta'], 'readonly');
  const store = tx.objectStore('meta');
  await reqToPromise(store.get('ping'));
  await txDone(tx);
}

export { reqToPromise, txDone };
