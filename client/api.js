import {
  cacheArticle,
  cacheArticleUnderId,
  cacheArticlesIndex,
  getCachedArticle,
  getCachedArticlesIndex,
  updateCachedArticleTreePositions,
  updateCachedDocJson,
  markCachedArticleDeleted,
} from './offline/cache.js';
import { enqueueOp } from './offline/outbox.js';
import { localSemanticSearch } from './offline/semantic.js';
import { state } from './state.js';
import { revertLog, docJsonHash } from './debug/revertLog.js';

const PERF_KEY = 'ttree_profile_v1';
function perfEnabled() {
  try {
    return window?.localStorage?.getItem?.(PERF_KEY) === '1';
  } catch {
    return false;
  }
}
function perfLog(...args) {
  try {
    if (!perfEnabled()) return;
    // eslint-disable-next-line no-console
    console.log(...args);
  } catch {
    // ignore
  }
}

export async function apiRequest(path, options = {}) {
  const perfStart = perfEnabled() ? performance.now() : 0;
  const perfFetchStart = perfStart ? performance.now() : 0;
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    credentials: 'include',
    ...options,
  });
  const perfHeadersAt = perfFetchStart ? performance.now() : 0;
  if (!response.ok) {
    // Session missing/expired: treat as "auth required" (not "offline").
    if (response.status === 401 || response.status === 403) {
      try {
        state.serverStatus = 'auth';
        state.serverStatusText = 'auth';
      } catch {
        // ignore
      }
      try {
        window.dispatchEvent(new CustomEvent('memus:auth-required', { detail: { path, status: response.status } }));
      } catch {
        // ignore
      }
    }
    const details = await response.json().catch(() => ({}));
    if (perfStart) {
      // eslint-disable-next-line no-console
      console.log('[perf][api]', path, {
        status: response.status,
        ms: Math.round(performance.now() - perfStart),
        fetchMs: perfHeadersAt ? Math.round(perfHeadersAt - perfFetchStart) : null,
      });
    }
    const err = new Error(details.detail || 'Request failed');
    try {
      err.status = response.status;
      err.path = path;
    } catch {
      // ignore
    }
    throw err;
  }
  // Any successful API response means the server is reachable (even if the app started in offline-fallback mode).
  try {
    if (state.serverStatus === 'down') {
      state.serverStatus = 'ok';
      state.serverStatusText = '';
    }
  } catch {
    // ignore
  }
  if (response.status === 204) {
    if (perfStart) {
      // eslint-disable-next-line no-console
      console.log('[perf][api]', path, {
        status: 204,
        ms: Math.round(performance.now() - perfStart),
        fetchMs: perfHeadersAt ? Math.round(perfHeadersAt - perfFetchStart) : null,
      });
    }
    return null;
  }
  const perfJsonStart = perfStart ? performance.now() : 0;
  const data = await response.json();
  const perfDone = perfStart ? performance.now() : 0;
  try {
    if (window?.localStorage?.getItem?.('ttree_debug_article_load_v1') === '1') {
      const ms = response.headers.get('X-Memus-Article-ms');
      const bytes = response.headers.get('X-Memus-DocJson-bytes');
      if (ms || bytes) {
        // eslint-disable-next-line no-console
        console.log('[api]', path, { ms, docJsonBytes: bytes });
      }
    }
  } catch {
    // ignore
  }
  if (perfStart) {
    const serverMs =
      response.headers.get('X-Memus-Article-ms') ||
      response.headers.get('X-Memus-Articles-ms') ||
      response.headers.get('X-Memus-Server-ms');
    const docBytes = response.headers.get('X-Memus-DocJson-bytes');
    const articlesCount = response.headers.get('X-Memus-Articles-count');
    const contentLength = response.headers.get('Content-Length');
    // eslint-disable-next-line no-console
    console.log('[perf][api]', path, {
      status: response.status,
      ms: Math.round(perfDone - perfStart),
      fetchMs: perfHeadersAt ? Math.round(perfHeadersAt - perfFetchStart) : null,
      jsonMs: perfJsonStart ? Math.round(perfDone - perfJsonStart) : null,
      serverMs: serverMs ? Number(serverMs) : null,
      docJsonBytes: docBytes ? Number(docBytes) : null,
      articlesCount: articlesCount ? Number(articlesCount) : null,
      contentLength: contentLength ? Number(contentLength) : null,
    });
  }
  return data;
}

export async function fetchCurrentUser() {
  const response = await fetch('/api/auth/me', {
    method: 'GET',
    credentials: 'include',
  });
  if (response.status === 401 || response.status === 403) {
    try {
      state.serverStatus = 'auth';
      state.serverStatusText = 'auth';
    } catch {
      // ignore
    }
    try {
      window.dispatchEvent(new CustomEvent('memus:auth-required', { detail: { path: '/api/auth/me', status: response.status } }));
    } catch {
      // ignore
    }
    return null;
  }
  if (!response.ok) {
    const details = await response.json().catch(() => ({}));
    throw new Error(details.detail || 'Auth check failed');
  }
  return response.json();
}

export async function login(username, password) {
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.detail || 'Не удалось войти');
  }
  return data;
}

export async function registerUser(username, password, displayName) {
  const response = await fetch('/api/auth/register', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, displayName }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.detail || 'Не удалось создать пользователя');
  }
  return data;
}

export async function logout() {
  await fetch('/api/auth/logout', {
    method: 'POST',
    credentials: 'include',
  });
}

let fetchArticlesIndexInFlight = null;
let refreshArticlesIndexInFlight = null;
const FORCE_CACHED_INDEX_KEY = 'ttree_offline_recovery_force_index_v1';

function forceCachedIndexEnabled() {
  try {
    return window?.localStorage?.getItem?.(FORCE_CACHED_INDEX_KEY) === '1';
  } catch {
    return false;
  }
}

async function fetchArticlesIndexNetwork({ timeoutMs }) {
  const ms = typeof timeoutMs === 'number' ? Math.max(0, Math.floor(timeoutMs)) : 0;
  let timer = null;
  let controller = null;
  try {
    if (ms > 0 && typeof AbortController !== 'undefined') {
      controller = new AbortController();
      timer = setTimeout(() => {
        try {
          controller.abort();
        } catch {
          // ignore
        }
      }, ms);
    }
    return await apiRequest('/api/articles', controller ? { signal: controller.signal } : {});
  } catch (err) {
    // Treat abort/timeout as "server down" so the UI can switch to offline-first behavior.
    const msg = err?.message || String(err || '');
    if (msg.toLowerCase().includes('abort')) {
      try {
        state.serverStatus = 'down';
        state.serverStatusText = 'timeout';
      } catch {
        // ignore
      }
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function fetchArticlesIndex() {
  if (typeof navigator !== 'undefined' && navigator && navigator.onLine === false) {
    return getCachedArticlesIndex().catch(() => []);
  }
  if (fetchArticlesIndexInFlight) return fetchArticlesIndexInFlight;

  // Prefer showing cached index quickly on slow networks, while refreshing in background.
  const preferCacheMs = state?.offlineReady ? 600 : 250;
  const networkTimeoutMs = 2200;

  fetchArticlesIndexInFlight = (async () => {
    const cacheStartedAt = perfEnabled() ? performance.now() : 0;
    let cacheTimer = null;
    let cacheSettled = false;
    const timeoutPromise = new Promise((resolve) => {
      cacheTimer = setTimeout(() => {
        if (!cacheSettled && cacheStartedAt) perfLog('[offline-first][articles] cache.lookup.timeout', { preferCacheMs });
        resolve(null);
      }, preferCacheMs);
    });
    const cachedLookupPromise = getCachedArticlesIndex()
      .then((index) => {
        cacheSettled = true;
        if (cacheTimer) clearTimeout(cacheTimer);
        cacheTimer = null;
        if (cacheStartedAt) {
          perfLog('[offline-first][articles] cache.lookup.done', {
            ms: Math.round(performance.now() - cacheStartedAt),
            hit: Boolean(index && index.length),
          });
        }
        return index;
      })
      .catch((err) => {
        cacheSettled = true;
        if (cacheTimer) clearTimeout(cacheTimer);
        cacheTimer = null;
        // If offline DB was ready but the index read failed, surface it as an offline DB problem
        // so the UI can instruct the user instead of silently showing "Нет статей".
        try {
          if (state.offlineReady) {
            const kind = String(err?.idbKind || err?.name || '').toLowerCase();
            if (kind.includes('timeout')) {
              state.offlineInitStatus = 'timeout';
              state.offlineInitError = 'Локальная база не отвечает (таймаут чтения списка статей). Перезагрузите страницу.';
            } else if (kind.includes('quota')) {
              state.offlineInitStatus = 'quota';
              state.offlineInitError = 'Недостаточно места для локального кэша. Очистите кэш картинок или освободите место.';
            } else {
              state.offlineInitStatus = 'error';
              state.offlineInitError = 'Не удалось прочитать локальный список статей. Перезагрузите страницу или сбросьте оффлайн‑кэш.';
            }
          }
        } catch {
          // ignore
        }
        return null;
      });

    const cachedFast = await Promise.race([cachedLookupPromise, timeoutPromise]);

    if (cachedFast && cachedFast.length) {
      if (!refreshArticlesIndexInFlight) {
        refreshArticlesIndexInFlight = fetchArticlesIndexNetwork({ timeoutMs: networkTimeoutMs })
          .then(async (index) => {
            // Do not block other IndexedDB transactions (e.g., current article open) on a big index update.
            // Schedule in idle so article caching/read can proceed first.
            try {
              if (typeof requestIdleCallback === 'function') {
                requestIdleCallback(() => cacheArticlesIndex(index).catch(() => {}), { timeout: 2500 });
              } else {
                setTimeout(() => cacheArticlesIndex(index).catch(() => {}), 250);
              }
            } catch {
              cacheArticlesIndex(index).catch(() => {});
            }
          })
          .catch(() => {})
          .finally(() => {
            refreshArticlesIndexInFlight = null;
          });
      }
      return cachedFast;
    }

    const index = await fetchArticlesIndexNetwork({ timeoutMs: networkTimeoutMs });

      // Do not block other IndexedDB transactions (e.g., current article open) on a big index update.
      // Schedule in idle so article caching/read can proceed first.
      try {
        if (typeof requestIdleCallback === 'function') {
          requestIdleCallback(() => cacheArticlesIndex(index).catch(() => {}), { timeout: 2500 });
        } else {
          setTimeout(() => cacheArticlesIndex(index).catch(() => {}), 250);
        }
      } catch {
        cacheArticlesIndex(index).catch(() => {});
      }

      // Recovery mode: if server index is unexpectedly tiny but local cache has many articles,
      // prefer showing cached index so user can access recovered offline data.
      try {
        const cached = await getCachedArticlesIndex().catch(() => null);
        const serverLen = Array.isArray(index) ? index.length : 0;
        const cachedLen = cached && Array.isArray(cached) ? cached.length : 0;

        // Strong heuristic: if server shows ~empty but cache is populated, show cache.
        if (cachedLen >= 20 && serverLen <= 3) return cached;

        // Explicit override (set by offline recovery import).
        if (forceCachedIndexEnabled() && cachedLen && cachedLen > serverLen) return cached;
      } catch {
        // ignore
      }

      return index;
  })()
    .catch(async (err) => {
      const cached = await getCachedArticlesIndex().catch(() => null);
      if (cached && cached.length) return cached;
      throw err;
    })
    .finally(() => {
      fetchArticlesIndexInFlight = null;
    });
  return fetchArticlesIndexInFlight;
}

export function fetchDeletedArticlesIndex() {
  if (typeof navigator !== 'undefined' && navigator && navigator.onLine === false) {
    return Promise.resolve([]);
  }
  return apiRequest('/api/articles/deleted').catch(async (err) => {
    // Deleted index is not critical offline; keep empty fallback.
    return [];
  });
}

export function fetchArticle(id, options = {}) {
  const requestedId = String(id || '').trim();
  const canonicalId = requestedId.startsWith('inbox-') ? 'inbox' : requestedId;
  id = canonicalId;
  const { cacheTimeoutMs: _cacheTimeoutMs, metaTimeoutMs: _metaTimeoutMs, ...apiOptions } = options || {};

  // IndexedDB can be briefly busy (e.g. background index caching). If offline is ready, prefer waiting a bit longer
  // for a cache hit to avoid unnecessary network fetches.
  const defaultCacheTimeoutMs = state?.offlineReady ? 400 : 150;
  const cacheTimeoutMs =
    typeof _cacheTimeoutMs === 'number'
      ? Math.max(0, Math.floor(_cacheTimeoutMs))
      : defaultCacheTimeoutMs;
  const metaTimeoutMs =
    typeof _metaTimeoutMs === 'number' ? Math.max(0, Math.floor(_metaTimeoutMs)) : 350;
  const cacheStartedAt = perfEnabled() ? performance.now() : 0;
  let cacheTimer = null;
  let cacheSettled = false;
  const timeoutPromise = new Promise((resolve) => {
    cacheTimer = setTimeout(() => {
      if (!cacheSettled && cacheStartedAt) perfLog('[offline-first][article] cache.lookup.timeout', { id, cacheTimeoutMs });
      resolve(null);
    }, cacheTimeoutMs);
  });
  const cachedLookupPromise = getCachedArticle(id)
    .then((article) => {
      cacheSettled = true;
      if (cacheTimer) clearTimeout(cacheTimer);
      cacheTimer = null;
      if (cacheStartedAt) {
        perfLog('[offline-first][article] cache.lookup.done', {
          id,
          ms: Math.round(performance.now() - cacheStartedAt),
          hit: Boolean(article),
        });
      }
      return article;
    })
    .catch((err) => {
      cacheSettled = true;
      if (cacheTimer) clearTimeout(cacheTimer);
      cacheTimer = null;
      if (cacheStartedAt) {
        perfLog('[offline-first][article] cache.lookup.failed', {
          id,
          ms: Math.round(performance.now() - cacheStartedAt),
          message: err?.message || String(err || ''),
        });
      }
      return null;
    });
  const cachedPromise = Promise.race([cachedLookupPromise, timeoutPromise]);

  const fetchOnline = () =>
    apiRequest(`/api/articles/${id}?include_history=0`, { ...apiOptions, cache: 'no-store' })
      .then(async (article) => {
        try {
          revertLog('article.fetch.network.ok', {
            articleId: id,
            updatedAt: article?.updatedAt || null,
            docHash: docJsonHash(article?.docJson || null),
          });
        } catch {
          // ignore
        }
        cacheArticle(article).catch(() => {});
        if (article && article.id && String(article.id) !== String(id)) {
          cacheArticleUnderId(article, id).catch(() => {});
        }
        return article;
      })
      .catch(async (err) => {
        const cached = await getCachedArticle(id).catch(() => null);
        try {
          revertLog('article.fetch.network.err', {
            articleId: id,
            message: err?.message || String(err || ''),
            cachedHit: Boolean(cached),
            cachedUpdatedAt: cached?.updatedAt || null,
            cachedDocHash: docJsonHash(cached?.docJson || null),
          });
        } catch {
          // ignore
        }
        if (cached) return cached;
        throw err;
      });

  const buildLocalInboxArticle = () => {
    const now = new Date().toISOString();
    const safeUuid =
      (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
        ? () => globalThis.crypto.randomUUID()
        : () => `id-${Date.now()}-${Math.random().toString(16).slice(2)}`);

    const docJson = {
      type: 'doc',
      content: [
        {
          type: 'outlineSection',
          attrs: { id: safeUuid(), collapsed: false },
          content: [
            { type: 'outlineHeading', content: [] },
            { type: 'outlineBody', content: [{ type: 'paragraph' }] },
            { type: 'outlineChildren', content: [] },
          ],
        },
      ],
    };
    return {
      id: 'inbox',
      title: 'Быстрые заметки',
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      parentId: null,
      position: 0,
      authorId: null,
      publicSlug: null,
      encrypted: false,
      docJson,
      history: [],
    };
  };

  const PENDING_QUICK_NOTES_KEY = 'ttree_pending_quick_notes_v1';
  const readPendingQuickNotes = () => {
    try {
      const raw = window?.localStorage?.getItem?.(PENDING_QUICK_NOTES_KEY) || '';
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
    } catch {
      return [];
    }
  };

  const buildOutlineSectionFromPlainText = (sectionId, text) => {
    const sid = String(sectionId || '').trim();
    if (!sid) return null;
    const t = String(text || '').trim();
    const lines = t.split(/\r?\n/);
    const paragraphContent = [];
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line) paragraphContent.push({ type: 'text', text: line });
      if (i !== lines.length - 1) paragraphContent.push({ type: 'hardBreak' });
    }
    return {
      type: 'outlineSection',
      attrs: { id: sid, collapsed: false },
      content: [
        { type: 'outlineHeading', content: [] },
        { type: 'outlineBody', content: [paragraphContent.length ? { type: 'paragraph', content: paragraphContent } : { type: 'paragraph' }] },
        { type: 'outlineChildren', content: [] },
      ],
    };
  };

  const withPendingQuickNotesOverlay = (article) => {
    try {
      if (!article || String(article.id || '') !== 'inbox') return article;
      const pending = readPendingQuickNotes();
      if (!pending.length) return article;
      const baseDoc = article?.docJson && typeof article.docJson === 'object' ? article.docJson : { type: 'doc', content: [] };
      const baseContent = Array.isArray(baseDoc.content) ? baseDoc.content : [];
      const existing = new Set(
        baseContent
          .filter((n) => n && n.type === 'outlineSection' && n.attrs && n.attrs.id)
          .map((n) => String(n.attrs.id)),
      );
      const toAdd = [];
      for (const n of pending) {
        const sid = String(n?.sectionId || n?.id || '').trim();
        if (!sid) continue;
        if (existing.has(sid)) continue;
        const sec = buildOutlineSectionFromPlainText(sid, n?.text || '');
        if (sec) toAdd.push(sec);
      }
      if (!toAdd.length) return article;
      return {
        ...article,
        docJson: { ...baseDoc, type: baseDoc.type || 'doc', content: [...toAdd, ...baseContent] },
      };
    } catch {
      return article;
    }
  };

  const fetchMeta = () =>
    apiRequest(`/api/articles/${encodeURIComponent(id)}/meta`, {
      method: 'GET',
      headers: { ...(apiOptions.headers || {}) },
      cache: 'no-store',
    });
  const fetchMetaWithTimeout = () => {
    if (!metaTimeoutMs) return fetchMeta();
    return Promise.race([
      fetchMeta(),
      new Promise((_, reject) =>
        setTimeout(() => {
          const err = new Error('meta_timeout');
          err.name = 'TimeoutError';
          reject(err);
        }, metaTimeoutMs),
      ),
    ]);
  };

  // Offline-first + version-aware:
  // - If cached exists: compare versions via lightweight /meta.
  //   - unchanged => return cached, skip full GET
  //   - changed/unknown => fetch full article
  // - If no cached: fetch full article
  return cachedPromise.then(async (cachedFast) => {
    if (!cachedFast) {
      if (!navigator.onLine && String(id) === 'inbox') {
        // On mobile (especially iOS), IDB can be slow and our cache timeout can fire even when
        // the inbox is actually cached. Prefer a late cache hit over showing a 1-section stub.
        try {
          const late = await Promise.race([
            cachedLookupPromise,
            new Promise((resolve) => setTimeout(() => resolve(null), Math.max(500, metaTimeoutMs * 5))),
          ]);
          if (late) {
            perfLog('[offline-first][article] choose.cache.late.offline.inbox', { id });
            try {
              revertLog('article.choose', { articleId: id, choose: 'cache.late.offline.inbox' });
            } catch {
              // ignore
            }
            return withPendingQuickNotesOverlay(late);
          }
        } catch {
          // ignore
        }
        perfLog('[offline-first][article] choose.local.inbox.offline', { id });
        return withPendingQuickNotesOverlay(buildLocalInboxArticle());
      }

      // We might have a cache hit that arrived slightly after the timeout (IndexedDB busy).
      // In that case, prefer cached content over a slow network fetch, but still allow the
      // network request to refresh the cache in background.
      const taggedCache = cachedLookupPromise
        .then((cached) => {
          if (!cached) return new Promise(() => {});
          return { src: 'cache', article: withPendingQuickNotesOverlay(cached) };
        })
        .catch(() => new Promise(() => {}));

      const taggedNetwork = (async () => ({
        src: 'network',
        article: await withPendingQuickNotesOverlay(fetchOnline()),
      }))();

      const winner = await Promise.race([taggedCache, taggedNetwork]);
      if (winner?.src === 'cache') {
        perfLog('[offline-first][article] choose.cache.late', { id });
        try {
          revertLog('article.choose', { articleId: id, choose: 'cache.late' });
        } catch {
          // ignore
        }
        // Refresh cache in background (already in flight via taggedNetwork).
        taggedNetwork.catch(() => {});
        return winner.article;
      }
      perfLog('[offline-first][article] choose.network.no-cache', { id });
      try {
        revertLog('article.choose', { articleId: id, choose: 'network.no_cache' });
      } catch {
        // ignore
      }
      return winner.article;
    }
    if (!navigator.onLine) {
      perfLog('[offline-first][article] choose.cache.offline', { id, updatedAt: cachedFast?.updatedAt || null });
      try {
        revertLog('article.choose', {
          articleId: id,
          choose: 'cache.offline',
          cachedUpdatedAt: cachedFast?.updatedAt || null,
          cachedDocHash: docJsonHash(cachedFast?.docJson || null),
        });
      } catch {
        // ignore
      }
      return withPendingQuickNotesOverlay(cachedFast);
    }

    const cachedUpdatedAt = String(cachedFast.updatedAt || cachedFast.updated_at || '').trim();
    if (!cachedUpdatedAt) {
      perfLog('[offline-first][article] choose.network.no-cached-updatedAt', { id });
      try {
        revertLog('article.choose', {
          articleId: id,
          choose: 'network.no_cached_updatedAt',
          cachedDocHash: docJsonHash(cachedFast?.docJson || null),
        });
      } catch {
        // ignore
      }
      return withPendingQuickNotesOverlay(await fetchOnline());
    }

    try {
      perfLog('[offline-first][article] meta.check.start', { id, cachedUpdatedAt });
      const meta = await fetchMetaWithTimeout();
      const serverUpdatedAt = String(meta?.updatedAt || '').trim();
      if (serverUpdatedAt && serverUpdatedAt === cachedUpdatedAt) {
        perfLog('[offline-first][article] choose.cache.meta.same', { id, cachedUpdatedAt });
        try {
          revertLog('article.choose', {
            articleId: id,
            choose: 'cache.meta.same',
            cachedUpdatedAt,
            serverUpdatedAt,
            cachedDocHash: docJsonHash(cachedFast?.docJson || null),
          });
        } catch {
          // ignore
        }
        return withPendingQuickNotesOverlay(cachedFast);
      }
      perfLog('[offline-first][article] choose.network.meta.diff', {
        id,
        cachedUpdatedAt,
        serverUpdatedAt: serverUpdatedAt || null,
      });
      try {
        revertLog('article.choose', {
          articleId: id,
          choose: 'network.meta.diff',
          cachedUpdatedAt,
          serverUpdatedAt: serverUpdatedAt || null,
          cachedDocHash: docJsonHash(cached?.docJson || null),
        });
      } catch {
        // ignore
      }
      return withPendingQuickNotesOverlay(await fetchOnline());
    } catch (err) {
      // If meta check fails, fall back to cached quickly and refresh in background.
      if (String(err?.name || '') === 'TimeoutError' || String(err?.message || '') === 'meta_timeout') {
        perfLog('[offline-first][article] meta.check.timeout', { id, metaTimeoutMs });
      } else {
        perfLog('[offline-first][article] meta.check.failed', { id, message: err?.message || String(err || '') });
      }
      fetchOnline().catch(() => {});
      if (String(err?.name || '') === 'TimeoutError' || String(err?.message || '') === 'meta_timeout') {
        perfLog('[offline-first][article] choose.cache.meta.timeout', { id, cachedUpdatedAt, metaTimeoutMs });
      } else {
        perfLog('[offline-first][article] choose.cache.meta.failed', { id, cachedUpdatedAt });
      }
      try {
        revertLog('article.choose', {
          articleId: id,
          choose:
            String(err?.name || '') === 'TimeoutError' || String(err?.message || '') === 'meta_timeout'
              ? 'cache.meta.timeout'
              : 'cache.meta.failed',
          cachedUpdatedAt,
          cachedDocHash: docJsonHash(cachedFast?.docJson || null),
          error: err?.message || String(err || ''),
        });
      } catch {
        // ignore
      }
      return withPendingQuickNotesOverlay(cachedFast);
    }
  });
}

export function fetchArticleHistory(articleId) {
  if (!articleId) {
    return Promise.reject(new Error('articleId is required'));
  }
  return apiRequest(`/api/articles/${encodeURIComponent(articleId)}/history`, { method: 'GET' });
}

export function search(query) {
  return apiRequest(`/api/search?q=${encodeURIComponent(query.trim())}`);
}

export function semanticSearch(query) {
  const q = (query || '').trim();
  if (!q) return Promise.resolve([]);
  // Client-side semantic ranking first (needs query embedding from server).
  // If local semantic isn't available (no local embeddings / offline), fall back to classic search.
  return localSemanticSearch(q)
    .then((local) => {
      if (Array.isArray(local) && local.length) return local;
      return apiRequest(`/api/search?q=${encodeURIComponent(q)}`);
    })
    .catch(() => apiRequest(`/api/search?q=${encodeURIComponent(q)}`));
}

export function ragSummary(query, results) {
  return apiRequest('/api/search/semantic/rag-summary', {
    method: 'POST',
    body: JSON.stringify({
      query: (query || '').trim(),
      results: Array.isArray(results) ? results : [],
    }),
  });
}

export function createArticle(title, options = {}) {
  const parentId = options && typeof options === 'object' ? options.parentId ?? null : null;
  const runOnline = () => {
    const payload = { title };
    if (parentId) payload.parentId = parentId;
    return apiRequest('/api/articles', { method: 'POST', body: JSON.stringify(payload) });
  };
  if (navigator.onLine) {
    return runOnline().then(async (article) => {
      cacheArticle(article).catch(() => {});
      return article;
    });
  }
  const id =
    globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const now = new Date().toISOString();
  return getCachedArticlesIndex()
    .catch(() => [])
    .then((idx) => {
      const list = Array.isArray(idx) ? idx : [];
      const siblings = list.filter((a) => String(a?.parentId || '') === String(parentId || ''));
      const maxPos = siblings.reduce((acc, a) => Math.max(acc, Number(a.position || 0)), -1);
      const localArticle = {
        id,
        title: title || 'Новая статья',
        updatedAt: now,
        createdAt: now,
        docJson: null,
        blocks: [],
        encrypted: false,
        parentId: parentId || null,
        position: maxPos + 1,
      };
      cacheArticle(localArticle).catch(() => {});
      enqueueOp('create_article', { articleId: id, payload: { id, title: localArticle.title, parentId: parentId || null } }).catch(
        () => {},
      );
      return localArticle;
    });
}

export function replaceArticleBlocksTree(articleId, blocks, options = {}) {
  if (!articleId) {
    return Promise.reject(new Error('articleId is required'));
  }
  const payload = { blocks: Array.isArray(blocks) ? blocks : [] };
  if (options && typeof options.createVersionIfStaleHours === 'number') {
    payload.createVersionIfStaleHours = options.createVersionIfStaleHours;
  }
  if (options && options.docJson) {
    payload.docJson = options.docJson;
  }
  return apiRequest(`/api/articles/${encodeURIComponent(articleId)}/blocks/replace-tree`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

export function updateArticleDocJson(articleId, docJson) {
  if (!articleId) {
    return Promise.reject(new Error('articleId is required'));
  }
  if (!docJson || typeof docJson !== 'object') {
    return Promise.reject(new Error('docJson must be object'));
  }
  return apiRequest(`/api/articles/${encodeURIComponent(articleId)}/doc-json`, {
    method: 'PUT',
    body: JSON.stringify({ docJson }),
  });
}

export function saveArticleDocJson(articleId, docJson, options = {}) {
  if (!articleId) {
    return Promise.reject(new Error('articleId is required'));
  }
  if (!docJson || typeof docJson !== 'object') {
    return Promise.reject(new Error('docJson must be object'));
  }
  const payload = { docJson };
  if (options && typeof options.createVersionIfStaleHours === 'number') {
    payload.createVersionIfStaleHours = options.createVersionIfStaleHours;
  }
	const attempt = () =>
	    apiRequest(`/api/articles/${encodeURIComponent(articleId)}/doc-json/save`, {
	      method: 'PUT',
	      body: JSON.stringify(payload),
	    });
		  return attempt().catch(async (err) => {
		    const now = new Date().toISOString();
		    // IMPORTANT: don't bump `updatedAt` locally on queued saves.
		    // If we bump it, online meta checks will see a mismatch and prefer stale server docJson,
		    // effectively "resurrecting" deleted blocks and hiding the local draft after Ctrl-F5.
		    let preservedUpdatedAt = null;
		    try {
		      if (state?.articleId && String(state.articleId) === String(articleId) && state.article?.updatedAt) {
		        preservedUpdatedAt = state.article.updatedAt;
		      }
		    } catch {
		      // ignore
		    }
		    if (!preservedUpdatedAt) {
		      try {
		        const cached = await getCachedArticle(articleId).catch(() => null);
		        preservedUpdatedAt = cached?.updatedAt || cached?.updated_at || null;
		      } catch {
		        preservedUpdatedAt = null;
		      }
		    }
		    await updateCachedDocJson(articleId, docJson, preservedUpdatedAt).catch(() => {});
		    await enqueueOp('save_doc_json', {
		      articleId,
		      payload: { docJson, createVersionIfStaleHours: payload.createVersionIfStaleHours || 12, clientQueuedAt: Date.now() },
		      coalesceKey: articleId,
		    }).catch(() => {});
		    return { status: 'queued', articleId, updatedAt: preservedUpdatedAt || now, offline: true };
		  });
		}

export function generateOutlineTitle(text) {
  if (typeof text !== 'string') {
    return Promise.reject(new Error('text must be string'));
  }
  return apiRequest('/api/outline/generate-title', {
    method: 'POST',
    body: JSON.stringify({ text }),
  });
}

export function proofreadOutlineHtml(html) {
  if (typeof html !== 'string') {
    return Promise.reject(new Error('html must be string'));
  }
  return apiRequest('/api/outline/proofread-html', {
    method: 'POST',
    body: JSON.stringify({ html }),
  });
}

export function deleteArticle(id, options = {}) {
  const force = options.force ? '?force=true' : '';
  return apiRequest(`/api/articles/${id}${force}`, { method: 'DELETE' }).then((resp) => {
    const deletedAt = force ? new Date().toISOString() : new Date().toISOString();
    markCachedArticleDeleted(id, deletedAt).catch(() => {});
    return resp;
  });
}

export function restoreArticle(id) {
  return apiRequest(`/api/articles/${id}/restore`, { method: 'POST' });
}

export function deleteOutlineSections(articleId, sectionIds, options = {}) {
  const ids = Array.isArray(sectionIds) ? sectionIds.filter(Boolean).map((x) => String(x)) : [];
  if (!articleId) return Promise.reject(new Error('articleId is required'));
  if (!ids.length) return Promise.resolve({ status: 'ok', removedBlockIds: [] });
  return apiRequest(`/api/articles/${encodeURIComponent(articleId)}/sections/delete`, {
    method: 'PUT',
    cache: 'no-store',
    body: JSON.stringify({
      opId: options?.opId || null,
      sectionIds: ids,
    }),
  });
}

export function putArticleStructureSnapshot(articleId, nodes, options = {}) {
  if (!articleId) return Promise.reject(new Error('articleId is required'));
  if (!Array.isArray(nodes)) return Promise.reject(new Error('nodes must be array'));
  return apiRequest(`/api/articles/${encodeURIComponent(articleId)}/structure/snapshot`, {
    method: 'PUT',
    cache: 'no-store',
    body: JSON.stringify({
      opId: options?.opId || null,
      nodes,
    }),
  });
}

export function upsertOutlineSectionContent(articleId, payload, options = {}) {
  if (!articleId) return Promise.reject(new Error('articleId is required'));
  if (!payload || typeof payload !== 'object') return Promise.reject(new Error('payload is required'));
  const sectionId = String(payload.sectionId || '').trim();
  const headingJson = payload.headingJson || null;
  const bodyJson = payload.bodyJson || null;
  const seq = payload.seq;
  if (!sectionId) return Promise.reject(new Error('sectionId is required'));
  if (!headingJson || typeof headingJson !== 'object') return Promise.reject(new Error('headingJson is required'));
  if (!bodyJson || typeof bodyJson !== 'object') return Promise.reject(new Error('bodyJson is required'));
  if (!Number.isFinite(Number(seq))) return Promise.reject(new Error('seq is required'));
  return apiRequest(`/api/articles/${encodeURIComponent(articleId)}/sections/upsert-content`, {
    method: 'PUT',
    cache: 'no-store',
    body: JSON.stringify({
      opId: options?.opId || null,
      sectionId,
      headingJson,
      bodyJson,
      seq: Number(seq),
      createVersionIfStaleHours: payload.createVersionIfStaleHours || 12,
    }),
  });
}

export function fetchUsers(adminPassword) {
  const headers = {};
  if (adminPassword) {
    headers['X-Users-Password'] = adminPassword;
  }
  return apiRequest('/api/users', { headers });
}

export function deleteUser(userId) {
  return apiRequest(`/api/users/${userId}`, { method: 'DELETE' });
}

export function createTelegramLinkToken() {
  return apiRequest('/api/telegram/link-token', { method: 'POST', body: JSON.stringify({}) });
}

export function uploadImageFile(file) {
  if (typeof navigator !== 'undefined' && navigator && navigator.onLine === false) {
    return Promise.reject(new Error('Нет интернета: загрузка изображений недоступна оффлайн'));
  }
  const formData = new FormData();
  formData.append('file', file);

  const logToServer = (payload) => {
    if (typeof navigator !== 'undefined' && navigator && navigator.onLine === false) return;
    try {
      fetch('/api/client/log', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'uploadImageFile',
          data: payload,
        }),
      }).catch(() => {});
    } catch {
      // ignore logging errors
    }
  };

  const viaFetch = () =>
    fetch('/api/uploads', {
      method: 'POST',
      credentials: 'include',
      body: formData,
    }).then(async (res) => {
      const details = await res.json().catch(() => null);
      logToServer({
        transport: 'fetch',
        status: res.status,
        ok: res.ok,
        details,
        name: file && file.name,
        type: file && file.type,
        size: file && file.size,
      });
      if (!res.ok) {
        const message = details?.detail || `Upload failed (status ${res.status})`;
        const err = new Error(message);
        err.status = res.status;
        err.details = details;
        throw err;
      }
      return details;
    });

  const viaXhr = () =>
    new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/uploads');
      xhr.withCredentials = true;
      xhr.onreadystatechange = () => {
        if (xhr.readyState !== XMLHttpRequest.DONE) return;
        try {
          const status = xhr.status;
          let details = null;
          try {
            details = JSON.parse(xhr.responseText || 'null');
          } catch {
            details = null;
          }
          logToServer({
            transport: 'xhr',
            status,
            ok: status >= 200 && status < 300,
            details,
            name: file && file.name,
            type: file && file.type,
            size: file && file.size,
          });
          if (status >= 200 && status < 300) {
            resolve(details);
          } else {
            const message =
              (details && details.detail) || `Upload failed (status ${status})`;
            const err = new Error(message);
            err.status = status;
            err.details = details;
            reject(err);
          }
        } catch (error) {
          reject(error);
        }
      };
      xhr.onerror = () => {
        logToServer({
          transport: 'xhr',
          status: 0,
          ok: false,
          details: { detail: 'Network error during image upload' },
          name: file && file.name,
          type: file && file.type,
          size: file && file.size,
        });
        const err = new Error('Upload failed (network error)');
        err.status = 0;
        err.details = { detail: 'Network error during image upload' };
        reject(err);
      };
      xhr.send(formData);
    });

  // Сначала пробуем обычный fetch, а при сетевой ошибке
  // (например, особенности мобильного браузера) — XHR‑фолбек.
  return viaFetch().catch((error) => {
    const msg = String(error && error.message ? error.message : '').toLowerCase();
    if (msg.includes('status ') || msg.includes('upload failed')) {
      // Для «нормальных» HTTP‑ошибок нет смысла дублировать запрос.
      throw error;
    }
    return viaXhr();
  });
}

export function createArticleVersion(articleId, label = null) {
  if (!articleId) {
    return Promise.reject(new Error('articleId is required'));
  }
  const payload = {};
  if (label) payload.label = String(label);
  return apiRequest(`/api/articles/${encodeURIComponent(articleId)}/versions`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function fetchArticleVersions(articleId) {
  if (!articleId) {
    return Promise.reject(new Error('articleId is required'));
  }
  return apiRequest(`/api/articles/${encodeURIComponent(articleId)}/versions`, {
    method: 'GET',
  });
}

export function restoreArticleVersion(articleId, versionId) {
  if (!articleId) {
    return Promise.reject(new Error('articleId is required'));
  }
  if (!versionId) {
    return Promise.reject(new Error('versionId is required'));
  }
  return apiRequest(
    `/api/articles/${encodeURIComponent(articleId)}/versions/${encodeURIComponent(versionId)}/restore`,
    {
      method: 'POST',
      body: JSON.stringify({}),
    },
  );
}

export function fetchArticleVersion(articleId, versionId) {
  if (!articleId) {
    return Promise.reject(new Error('articleId is required'));
  }
  if (!versionId) {
    return Promise.reject(new Error('versionId is required'));
  }
  return apiRequest(
    `/api/articles/${encodeURIComponent(articleId)}/versions/${encodeURIComponent(versionId)}`,
    {
      method: 'GET',
    },
  );
}

export function uploadAttachmentFile(articleId, file, { sectionId } = {}) {
  if (typeof navigator !== 'undefined' && navigator && navigator.onLine === false) {
    return Promise.reject(new Error('Нет интернета: загрузка файлов недоступна оффлайн'));
  }
  const formData = new FormData();
  formData.append('file', file);
  if (sectionId) formData.append('sectionId', String(sectionId));
  return fetch(`/api/articles/${articleId}/attachments`, {
    method: 'POST',
    credentials: 'include',
    body: formData,
  }).then(async (res) => {
    if (!res.ok) {
      const details = await res.json().catch(() => null);
      const message = details?.detail || `Attachment upload failed (status ${res.status})`;
      throw new Error(message);
    }
    return res.json();
  });
}

export function uploadAttachmentFileWithProgress(articleId, file, onProgress = () => {}, { sectionId } = {}) {
  if (typeof navigator !== 'undefined' && navigator && navigator.onLine === false) {
    return Promise.reject(new Error('Нет интернета: загрузка файлов недоступна оффлайн'));
  }
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/articles/${articleId}/attachments`);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        const percent = Math.round((event.loaded / event.total) * 100);
        onProgress(percent);
      }
    };
    xhr.onreadystatechange = () => {
      if (xhr.readyState !== XMLHttpRequest.DONE) return;
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const data = JSON.parse(xhr.responseText || '{}');
          resolve(data);
        } catch (error) {
          reject(error);
        }
      } else {
        let message = `Attachment upload failed (status ${xhr.status})`;
        try {
          const details = JSON.parse(xhr.responseText || '{}');
          if (details?.detail) message = details.detail;
        } catch (_) {
          /* ignore */
        }
        reject(new Error(message));
      }
    };
    xhr.onerror = () => reject(new Error('Network error during upload'));
    const formData = new FormData();
    formData.append('file', file);
    if (sectionId) formData.append('sectionId', String(sectionId));
    xhr.send(formData);
  });
}

function buildChildrenMap(indexRows) {
  const map = new Map();
  for (const a of indexRows || []) {
    const pid = a.parentId ?? null;
    if (!map.has(pid)) map.set(pid, []);
    map.get(pid).push(a);
  }
  for (const list of map.values()) {
    list.sort((x, y) => (x.position || 0) - (y.position || 0));
  }
  return map;
}

function normalizePositions(list) {
  const changes = [];
  for (let i = 0; i < list.length; i += 1) {
    const a = list[i];
    if (!a) continue;
    const nextPos = i;
    if ((a.position || 0) !== nextPos) {
      a.position = nextPos;
      changes.push({ id: a.id, parentId: a.parentId ?? null, position: nextPos });
    }
  }
  return changes;
}

export function moveArticlePosition(articleId, direction) {
  if (!articleId || !direction) return Promise.resolve(null);
  const attempt = () =>
    apiRequest(`/api/articles/${encodeURIComponent(articleId)}/move`, {
      method: 'POST',
      body: JSON.stringify({ direction }),
    });
  return attempt()
    .then(async (article) => {
      // We already know the intended move and maintain a cached index locally.
      // For single-device usage, avoid refetching the entire /api/articles list on every move.
      try {
        const idx = await getCachedArticlesIndex().catch(() => []);
        const map = buildChildrenMap(idx);
        const current = (idx || []).find((a) => a.id === articleId);
        if (current) {
          const siblings = map.get(current.parentId ?? null) || [];
          const pos = siblings.findIndex((a) => a.id === articleId);
          const delta = direction === 'up' ? -1 : 1;
          const nextIndex = pos + delta;
          if (pos !== -1 && nextIndex >= 0 && nextIndex < siblings.length) {
            const tmp = siblings[pos];
            siblings[pos] = siblings[nextIndex];
            siblings[nextIndex] = tmp;
            const changes = normalizePositions(siblings);
            updateCachedArticleTreePositions(changes).catch(() => {});
          }
        }
      } catch {
        // ignore
      }
      return article;
    })
    .catch(async () => {
      const idx = await getCachedArticlesIndex().catch(() => []);
      const map = buildChildrenMap(idx);
      const current = (idx || []).find((a) => a.id === articleId);
      if (!current) return null;
      const siblings = map.get(current.parentId ?? null) || [];
      const pos = siblings.findIndex((a) => a.id === articleId);
      if (pos === -1) return null;
      const delta = direction === 'up' ? -1 : 1;
      const nextIndex = pos + delta;
      if (nextIndex < 0 || nextIndex >= siblings.length) return null;
      const tmp = siblings[pos];
      siblings[pos] = siblings[nextIndex];
      siblings[nextIndex] = tmp;
      const changes = normalizePositions(siblings);
      updateCachedArticleTreePositions(changes).catch(() => {});
      enqueueOp('move_article_position', { articleId, payload: { direction }, coalesceKey: `${articleId}:move` }).catch(
        () => {},
      );
      return { id: articleId };
    });
}

export function indentArticleApi(articleId) {
  if (!articleId) return Promise.resolve(null);
  const attempt = () =>
    apiRequest(`/api/articles/${encodeURIComponent(articleId)}/indent`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  return attempt().catch(async () => {
    const idx = await getCachedArticlesIndex().catch(() => []);
    const map = buildChildrenMap(idx);
    const current = (idx || []).find((a) => a.id === articleId);
    if (!current) return null;
    const siblings = map.get(current.parentId ?? null) || [];
    const pos = siblings.findIndex((a) => a.id === articleId);
    if (pos <= 0) return null;
    const newParent = siblings[pos - 1];
    const newParentId = newParent?.id || null;
    current.parentId = newParentId;
    const newSiblings = map.get(newParentId) || [];
    newSiblings.push(current);
    const changes = [];
    changes.push(...normalizePositions(siblings.filter((a) => a.id !== articleId)));
    changes.push(...normalizePositions(newSiblings));
    updateCachedArticleTreePositions(changes).catch(() => {});
    enqueueOp('indent_article', { articleId, payload: {}, coalesceKey: `${articleId}:indent` }).catch(() => {});
    return { id: articleId };
  });
}

export function outdentArticleApi(articleId) {
  if (!articleId) return Promise.resolve(null);
  const attempt = () =>
    apiRequest(`/api/articles/${encodeURIComponent(articleId)}/outdent`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  return attempt().catch(async () => {
    const idx = await getCachedArticlesIndex().catch(() => []);
    const map = buildChildrenMap(idx);
    const current = (idx || []).find((a) => a.id === articleId);
    if (!current) return null;
    const parentId = current.parentId ?? null;
    if (!parentId) return null;
    const parent = (idx || []).find((a) => a.id === parentId);
    const newParentId = parent?.parentId ?? null;
    const oldSiblings = map.get(parentId) || [];
    const newOldSiblings = oldSiblings.filter((a) => a.id !== articleId);
    const upperSiblings = map.get(newParentId) || [];
    const parentPos = upperSiblings.findIndex((a) => a.id === parentId);
    const insertAt = parentPos === -1 ? upperSiblings.length : parentPos + 1;
    current.parentId = newParentId;
    upperSiblings.splice(insertAt, 0, current);
    const changes = [];
    changes.push(...normalizePositions(newOldSiblings));
    changes.push(...normalizePositions(upperSiblings));
    updateCachedArticleTreePositions(changes).catch(() => {});
    enqueueOp('outdent_article', { articleId, payload: {}, coalesceKey: `${articleId}:outdent` }).catch(() => {});
    return { id: articleId };
  });
}

export function moveArticleTree(articleId, payload) {
  if (!articleId) return Promise.resolve(null);
  const attempt = () =>
    apiRequest(`/api/articles/${encodeURIComponent(articleId)}/move-tree`, {
      method: 'POST',
      body: JSON.stringify(payload || {}),
    });
  return attempt().catch(async () => {
    const idx = await getCachedArticlesIndex().catch(() => []);
    const map = buildChildrenMap(idx);
    const current = (idx || []).find((a) => a.id === articleId);
    if (!current) return null;

    const placement = (payload && payload.placement) || null;
    const anchorId = (payload && payload.anchorId) || null;
    let targetParentId = payload ? payload.parentId ?? null : null;
    if (placement === 'inside' && anchorId) targetParentId = anchorId;

    const fromParentId = current.parentId ?? null;
    const fromSiblings = map.get(fromParentId) || [];
    const newFromSiblings = fromSiblings.filter((a) => a.id !== articleId);

    const toSiblings = map.get(targetParentId) || [];
    const safeToSiblings = toSiblings.filter((a) => a.id !== articleId);

    let insertAt = safeToSiblings.length;
    if (anchorId) {
      const anchorIdx = safeToSiblings.findIndex((a) => a.id === anchorId);
      if (anchorIdx !== -1) {
        if (placement === 'before') insertAt = anchorIdx;
        else if (placement === 'after') insertAt = anchorIdx + 1;
        else if (placement === 'inside') insertAt = safeToSiblings.length;
      }
    }

    current.parentId = targetParentId;
    safeToSiblings.splice(insertAt, 0, current);

    const changes = [];
    changes.push(...normalizePositions(newFromSiblings));
    changes.push(...normalizePositions(safeToSiblings));
    updateCachedArticleTreePositions(changes).catch(() => {});
    enqueueOp('move_article_tree', {
      articleId,
      payload: payload || {},
      coalesceKey: `${articleId}:move-tree`,
    }).catch(() => {});
    return { id: articleId };
  });
}

export async function getYandexUploadUrl({ articleId, filename, overwrite = false, sha256 = '', size = 0 }) {
  if (typeof navigator !== 'undefined' && navigator && navigator.onLine === false) {
    throw new Error('Нет интернета: загрузка файлов недоступна оффлайн');
  }
  const payload = {
    filename: filename || '',
    articleId: articleId || '',
    overwrite: Boolean(overwrite),
    // sha256 сейчас на сервере не используется, но может пригодиться позже.
    sha256: sha256 || '',
    size: typeof size === 'number' ? size : 0,
  };
  const res = await fetch('/api/yandex/disk/upload-url', {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const message = (data && data.detail) || `Yandex upload URL failed (status ${res.status})`;
    throw new Error(message);
  }
  return data;
}

export async function registerYandexAttachment(articleId, { path, originalName, contentType, size, sectionId }) {
  if (typeof navigator !== 'undefined' && navigator && navigator.onLine === false) {
    throw new Error('Нет интернета: загрузка файлов недоступна оффлайн');
  }
  const payload = {
    path: path || '',
    originalName: originalName || '',
    contentType: contentType || '',
    size: typeof size === 'number' ? size : 0,
  };
  if (sectionId) payload.sectionId = String(sectionId);
  const res = await fetch(`/api/articles/${articleId}/attachments/yandex`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const message = (data && data.detail) || `Register Yandex attachment failed (status ${res.status})`;
    throw new Error(message);
  }
  return data;
}

export async function uploadFileToYandexDisk(articleId, file, { onProgress, sectionId } = {}) {
  if (!file) throw new Error('Файл не указан');
  let sha256 = '';
  try {
    if (window.crypto && window.crypto.subtle && typeof file.arrayBuffer === 'function') {
      const buffer = await file.arrayBuffer();
      const hashBuffer = await window.crypto.subtle.digest('SHA-256', buffer);
      const bytes = new Uint8Array(hashBuffer);
      sha256 = Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    }
  } catch (_) {
    // Если не удалось посчитать хеш — просто продолжаем без него.
    sha256 = '';
  }

  const { href, method, path, exists, same } = await getYandexUploadUrl({
    articleId,
    filename: file.name || 'attachment',
    overwrite: false,
    sha256,
    size: file.size || 0,
  });

  // Если файл с таким именем уже есть и содержимое совпадает —
  // не загружаем повторно, просто регистрируем вложение.
  if (exists && same && !href) {
    const attachment = await registerYandexAttachment(articleId, {
      path,
      originalName: file.name || 'attachment',
      contentType: file.type || '',
      size: file.size || 0,
      sectionId,
    });
    return attachment;
  }

  let uploadedDirect = false;

  if (href) {
    try {
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open(method || 'PUT', href);
        xhr.upload.onprogress = (event) => {
          if (onProgress && event.lengthComputable) {
            const percent = Math.round((event.loaded / event.total) * 100);
            try {
              onProgress(percent);
            } catch (_) {
              /* ignore */
            }
          }
        };
        xhr.onreadystatechange = () => {
          if (xhr.readyState !== XMLHttpRequest.DONE) return;
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve();
          } else {
            reject(new Error(`Yandex upload failed (status ${xhr.status})`));
          }
        };
        xhr.onerror = () => reject(new Error('Network error during Yandex upload'));
        xhr.send(file);
      });
      uploadedDirect = true;
    } catch (error) {
      // На некоторых мобильных браузерах прямой PUT на Яндекс.Диск
      // может падать (status 0/CORS). В этом случае пробуем
      // серверный аплоад через /api/articles/{id}/attachments.
      console.warn('[attachments] Direct Yandex upload failed, falling back to server upload', error);
      uploadedDirect = false;
    }
  }

  if (uploadedDirect) {
    const attachment = await registerYandexAttachment(articleId, {
      path,
      originalName: file.name || 'attachment',
      contentType: file.type || '',
      size: file.size || 0,
      sectionId,
    });
    return attachment;
  }

  // Fallback: загружаем файл через обычный endpoint вложений.
  const attachment = await uploadAttachmentFileWithProgress(articleId, file, onProgress, { sectionId });
  return attachment;
}

export function importArticleFromHtml(file, options = {}) {
  const formData = new FormData();
  formData.append('file', file);
  if (options.mode) {
    formData.append('mode', options.mode);
  }
  if (options.versionPrefix) {
    formData.append('versionPrefix', options.versionPrefix);
  }
  return fetch('/api/import/html', {
    method: 'POST',
    credentials: 'include',
    body: formData,
  }).then(async (res) => {
    const details = await res.json().catch(() => null);
    if (!res.ok) {
      const message = details?.detail || `Import failed (status ${res.status})`;
      throw new Error(message);
    }
    return details;
  });
}

export function importArticleFromMarkdown(file, assetsBaseUrl = '') {
  const formData = new FormData();
  formData.append('file', file);
  if (assetsBaseUrl && typeof assetsBaseUrl === 'string') {
    formData.append('assetsBaseUrl', assetsBaseUrl);
  }
  return fetch('/api/import/markdown', {
    method: 'POST',
    credentials: 'include',
    body: formData,
  }).then(async (res) => {
    const details = await res.json().catch(() => null);
    if (!res.ok) {
      const message = details?.detail || `Import failed (status ${res.status})`;
      throw new Error(message);
    }
    return details;
  });
}

export function importFromLogseqArchive(file, assetsBaseUrl = '') {
  const formData = new FormData();
  formData.append('file', file);
  if (assetsBaseUrl && typeof assetsBaseUrl === 'string') {
    formData.append('assetsBaseUrl', assetsBaseUrl);
  }
  return fetch('/api/import/logseq', {
    method: 'POST',
    credentials: 'include',
    body: formData,
  }).then(async (res) => {
    const details = await res.json().catch(() => null);
    if (!res.ok) {
      const message = details?.detail || `Import failed (status ${res.status})`;
      throw new Error(message);
    }
    return details;
  });
}
