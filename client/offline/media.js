import { getOfflineDbReady } from './index.js';
import { reqToPromise, txDone } from './idb.js';

const CACHE_NAME = 'memus-uploads-v1';
const PAUSE_KEY = 'ttree_media_prefetch_paused_v1';

export function isMediaPrefetchPaused() {
  try {
    return localStorage.getItem(PAUSE_KEY) === '1';
  } catch {
    return false;
  }
}

export function setMediaPrefetchPaused(paused) {
  const next = Boolean(paused);
  try {
    localStorage.setItem(PAUSE_KEY, next ? '1' : '0');
  } catch {
    // ignore
  }
  try {
    window.dispatchEvent(new CustomEvent('media-prefetch-paused', { detail: { paused: next } }));
  } catch {
    // ignore
  }
  return next;
}

export function toggleMediaPrefetchPaused() {
  return setMediaPrefetchPaused(!isMediaPrefetchPaused());
}

export async function getMediaProgress() {
  const db = await getOfflineDbReady();
  const tx = db.transaction(['media_assets'], 'readonly');
  const store = tx.objectStore('media_assets');
  const items = (await reqToPromise(store.getAll()).catch(() => [])) || [];
  await txDone(tx);
  let ok = 0;
  let error = 0;
  for (const it of items) {
    if (it?.status === 'ok') ok += 1;
    if (it?.status === 'error') error += 1;
  }
  return { total: items.length, ok, error };
}

export async function getMediaProgressForArticle(articleId) {
  const id = String(articleId || '').trim();
  if (!id) return { total: 0, ok: 0, error: 0 };
  const db = await getOfflineDbReady();
  const tx = db.transaction(['media_refs', 'media_assets'], 'readonly');
  const refs = tx.objectStore('media_refs');
  const assets = tx.objectStore('media_assets');
  const idx = refs.index('byArticleId');
  const range = IDBKeyRange.only(id);

  let total = 0;
  let ok = 0;
  let error = 0;
  let cursor = await reqToPromise(idx.openCursor(range)).catch(() => null);
  while (cursor) {
    total += 1;
    const url = String(cursor.value?.url || '');
    if (url) {
      const asset = await reqToPromise(assets.get(url)).catch(() => null);
      if (asset?.status === 'ok') ok += 1;
      if (asset?.status === 'error') error += 1;
    }
    cursor = await reqToPromise(cursor.continue()).catch(() => null);
  }

  await txDone(tx);
  return { total, ok, error };
}

function normalizeUploadsUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return null;
  try {
    const u = new URL(raw, window.location.origin);
    // Keep only same-origin uploads in v1.
    if (u.origin !== window.location.origin) {
      // allow absolute memus.pro -> relative
      if (/^https?:\/\/memus\.pro\b/i.test(raw) && u.pathname.startsWith('/uploads/')) {
        return u.pathname + (u.search || '');
      }
      return null;
    }
    if (!u.pathname.startsWith('/uploads/')) return null;
    return u.pathname + (u.search || '');
  } catch {
    // relative path
    if (raw.startsWith('/uploads/')) return raw;
    return null;
  }
}

function extractUploadUrlsFromDocJson(docJson) {
  const out = new Set();
  const walk = (node) => {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node.type === 'image') {
      const src = normalizeUploadsUrl(node.attrs?.src);
      if (src) out.add(src);
    }
    const content = Array.isArray(node.content) ? node.content : [];
    content.forEach(walk);
  };
  walk(docJson?.content || []);
  return Array.from(out);
}

export async function updateMediaRefsForArticle(articleId, docJson) {
  const db = await getOfflineDbReady();
  const urls = extractUploadUrlsFromDocJson(docJson);
  const tx = db.transaction(['media_refs', 'media_assets'], 'readwrite');
  const refs = tx.objectStore('media_refs');
  const assets = tx.objectStore('media_assets');
  const idx = refs.index('byArticleId');
  const range = IDBKeyRange.only(String(articleId));

  // Remove old refs for the article.
  let cursor = await reqToPromise(idx.openCursor(range)).catch(() => null);
  while (cursor) {
    cursor.delete();
    cursor = await reqToPromise(cursor.continue()).catch(() => null);
  }

  for (const url of urls) {
    const key = `${String(articleId)}|${String(url)}`;
    await reqToPromise(refs.put({ key, articleId: String(articleId), url: String(url) }));
    const existing = await reqToPromise(assets.get(url)).catch(() => null);
    if (!existing) {
      await reqToPromise(
        assets.put({
          url: String(url),
          status: 'needed',
          fetchedAtMs: 0,
          failCount: 0,
          lastError: null,
        }),
      );
    }
  }
  await txDone(tx);
}

async function markMediaOk(db, url) {
  const tx = db.transaction(['media_assets'], 'readwrite');
  const store = tx.objectStore('media_assets');
  const existing = await reqToPromise(store.get(url)).catch(() => null);
  await reqToPromise(
    store.put({
      ...(existing || {}),
      url: String(url),
      status: 'ok',
      fetchedAtMs: Date.now(),
      failCount: 0,
      lastError: null,
    }),
  );
  await txDone(tx);
}

async function markMediaFail(db, url, err) {
  const message = String(err?.message || err || 'error');
  const tx = db.transaction(['media_assets'], 'readwrite');
  const store = tx.objectStore('media_assets');
  const existing = await reqToPromise(store.get(url)).catch(() => null);
  const nextFail = Number(existing?.failCount || 0) + 1;
  await reqToPromise(
    store.put({
      ...(existing || {}),
      url: String(url),
      status: 'error',
      fetchedAtMs: Date.now(),
      failCount: nextFail,
      lastError: message,
    }),
  );
  await txDone(tx);
}

async function listPendingMediaUrls(db, limit) {
  const tx = db.transaction(['media_assets'], 'readonly');
  const store = tx.objectStore('media_assets');
  const idx = store.index('byFetchedAtMs');
  const out = [];

  let cursor = await reqToPromise(idx.openCursor()).catch(() => null);
  while (cursor) {
    const v = cursor.value;
    const status = String(v?.status || '');
    const failCount = Number(v?.failCount || 0);
    if (status !== 'ok' && failCount < 5) {
      const url = String(v?.url || '');
      if (url) out.push(url);
      if (out.length >= limit) break;
    }
    cursor = await reqToPromise(cursor.continue()).catch(() => null);
  }

  await txDone(tx);
  return out;
}

async function isCached(cache, url) {
  try {
    const match = await cache.match(url, { ignoreSearch: false });
    return !!match;
  } catch {
    return false;
  }
}

async function fetchAndCache(cache, url) {
  const resp = await fetch(url, { credentials: 'include' });
  if (!resp || !resp.ok) throw new Error(`HTTP ${resp?.status || 0}`);
  await cache.put(url, resp.clone());
}

function getNetworkConcurrency() {
  try {
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    const effectiveType = String(conn?.effectiveType || '');
    const saveData = Boolean(conn?.saveData);
    if (saveData) return 1;
    if (effectiveType.includes('2g')) return 1;
    if (effectiveType.includes('3g')) return 2;
  } catch {
    // ignore
  }
  return 3;
}

let mediaLoopStarted = false;
let mediaLoopInFlight = 0;

export function startMediaPrefetchLoop() {
  if (mediaLoopStarted) return;
  mediaLoopStarted = true;

  const tick = async () => {
    if (!navigator.onLine) return;
    if (isMediaPrefetchPaused()) return;
    const concurrency = getNetworkConcurrency();
    if (mediaLoopInFlight >= concurrency) return;
    const db = await getOfflineDbReady();
    const cache = await caches.open(CACHE_NAME);
    const urls = await listPendingMediaUrls(db, Math.max(5, concurrency * 3));
    if (!urls.length) return;
    for (const url of urls) {
      if (mediaLoopInFlight >= concurrency) break;
      mediaLoopInFlight += 1;
      (async () => {
        try {
          if (await isCached(cache, url)) {
            await markMediaOk(db, url);
            return;
          }
          await fetchAndCache(cache, url);
          await markMediaOk(db, url);
        } catch (err) {
          await markMediaFail(db, url, err);
        } finally {
          mediaLoopInFlight -= 1;
        }
      })();
    }
  };

  setInterval(() => {
    tick().catch(() => {});
  }, 1200);

  window.addEventListener('online', () => {
    tick().catch(() => {});
  });
}

export async function pruneUnusedMedia() {
  const db = await getOfflineDbReady();
  const cache = await caches.open(CACHE_NAME);
  const tx = db.transaction(['media_assets', 'media_refs'], 'readwrite');
  const assets = tx.objectStore('media_assets');
  const refs = tx.objectStore('media_refs');
  const refsByUrl = refs.index('byUrl');
  const urls = [];

  let cursor = await reqToPromise(assets.openCursor()).catch(() => null);
  while (cursor && urls.length < 500) {
    const url = String(cursor.value?.url || '');
    if (url) {
      const refCount = await reqToPromise(refsByUrl.count(IDBKeyRange.only(url))).catch(() => 0);
      if (!refCount) {
        urls.push(url);
        cursor.delete();
      }
    }
    cursor = await reqToPromise(cursor.continue()).catch(() => null);
  }

  await txDone(tx);
  if (!urls.length) return 0;

  for (const url of urls) {
    try {
      await cache.delete(url);
    } catch {
      // ignore
    }
  }
  return urls.length;
}
