import { getOfflineDbReady } from './index.js';

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
  const res = await db.query(
    'SELECT ' +
      'COUNT(1) AS total, ' +
      "SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok, " +
      "SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error " +
      'FROM media_assets',
  );
  const row = res?.rows?.[0] || {};
  const total = Number(row.total || 0);
  const ok = Number(row.ok || 0);
  const error = Number(row.error || 0);
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
  await db.query('BEGIN');
  try {
    await db.query('DELETE FROM media_refs WHERE article_id = $1', [articleId]);
    for (const url of urls) {
      await db.query(
        'INSERT INTO media_refs (article_id, url) VALUES ($1, $2) ON CONFLICT (article_id, url) DO NOTHING',
        [articleId, url],
      );
      await db.query(
        'INSERT INTO media_assets (url, status, fetched_at, fail_count, last_error) VALUES ($1, $2, NULL, 0, NULL) ' +
          'ON CONFLICT (url) DO NOTHING',
        [url, 'needed'],
      );
    }
    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}

async function markMediaOk(db, url) {
  await db.query(
    'INSERT INTO media_assets (url, status, fetched_at, fail_count, last_error) VALUES ($1, $2, $3, 0, NULL) ' +
      'ON CONFLICT (url) DO UPDATE SET status = EXCLUDED.status, fetched_at = EXCLUDED.fetched_at, fail_count = 0, last_error = NULL',
    [url, 'ok', new Date().toISOString()],
  );
}

async function markMediaFail(db, url, err) {
  await db.query(
    'INSERT INTO media_assets (url, status, fetched_at, fail_count, last_error) VALUES ($1, $2, NULL, 1, $3) ' +
      'ON CONFLICT (url) DO UPDATE SET status = EXCLUDED.status, fail_count = media_assets.fail_count + 1, last_error = EXCLUDED.last_error',
    [url, 'error', String(err?.message || err || 'error')],
  );
}

async function listPendingMediaUrls(db, limit) {
  const res = await db.query(
    'SELECT url FROM media_assets WHERE (status IS NULL OR status != $1) AND (fail_count IS NULL OR fail_count < 5) ORDER BY fetched_at NULLS FIRST LIMIT $2',
    ['ok', limit],
  );
  return (res?.rows || []).map((r) => r.url).filter(Boolean);
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
  const res = await db.query(
    'SELECT ma.url AS url FROM media_assets ma LEFT JOIN media_refs mr ON mr.url = ma.url WHERE mr.url IS NULL LIMIT 500',
  );
  const urls = (res?.rows || []).map((r) => r.url).filter(Boolean);
  if (!urls.length) return 0;
  for (const url of urls) {
    try {
      await cache.delete(url);
    } catch {
      // ignore
    }
    await db.query('DELETE FROM media_assets WHERE url = $1', [url]).catch(() => {});
  }
  return urls.length;
}
