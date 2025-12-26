import {
  cacheArticle,
  cacheArticlesIndex,
  getCachedArticle,
  getCachedArticlesIndex,
  updateCachedArticleTreePositions,
  updateCachedDocJson,
} from './offline/cache.js';
import { enqueueOp } from './offline/outbox.js';
import { localSemanticSearch } from './offline/semantic.js';
import { state } from './state.js';

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
    const details = await response.json().catch(() => ({}));
    if (perfStart) {
      // eslint-disable-next-line no-console
      console.log('[perf][api]', path, {
        status: response.status,
        ms: Math.round(performance.now() - perfStart),
        fetchMs: perfHeadersAt ? Math.round(perfHeadersAt - perfFetchStart) : null,
      });
    }
    throw new Error(details.detail || 'Request failed');
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
  if (response.status === 401) return null;
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

export function fetchArticlesIndex() {
  if (typeof navigator !== 'undefined' && navigator && navigator.onLine === false) {
    return getCachedArticlesIndex().catch(() => []);
  }
  return apiRequest('/api/articles')
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
      return index;
    })
    .catch(async (err) => {
      const cached = await getCachedArticlesIndex().catch(() => null);
      if (cached && cached.length) return cached;
      throw err;
    });
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
  // IndexedDB can be briefly busy (e.g. background index caching). If offline is ready, prefer waiting a bit longer
  // for a cache hit to avoid unnecessary network fetches.
  const defaultCacheTimeoutMs = state?.offlineReady ? 400 : 150;
  const cacheTimeoutMs =
    options && typeof options.cacheTimeoutMs === 'number'
      ? Math.max(0, Math.floor(options.cacheTimeoutMs))
      : defaultCacheTimeoutMs;
  const metaTimeoutMs =
    options && typeof options.metaTimeoutMs === 'number' ? Math.max(0, Math.floor(options.metaTimeoutMs)) : 350;
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
    apiRequest(`/api/articles/${id}?include_history=0`, options)
      .then(async (article) => {
        cacheArticle(article).catch(() => {});
        return article;
      })
      .catch(async (err) => {
        const cached = await getCachedArticle(id).catch(() => null);
        if (cached) return cached;
        throw err;
      });

  const fetchMeta = () =>
    apiRequest(`/api/articles/${encodeURIComponent(id)}/meta`, {
      method: 'GET',
      headers: { ...(options.headers || {}) },
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
  return cachedPromise.then(async (cached) => {
    if (!cached) {
      perfLog('[offline-first][article] choose.network.no-cache', { id });
      return fetchOnline();
    }
    if (!navigator.onLine) {
      perfLog('[offline-first][article] choose.cache.offline', { id, updatedAt: cached?.updatedAt || null });
      return cached;
    }

    const cachedUpdatedAt = String(cached.updatedAt || cached.updated_at || '').trim();
    if (!cachedUpdatedAt) {
      perfLog('[offline-first][article] choose.network.no-cached-updatedAt', { id });
      return fetchOnline();
    }

    try {
      perfLog('[offline-first][article] meta.check.start', { id, cachedUpdatedAt });
      const meta = await fetchMetaWithTimeout();
      const serverUpdatedAt = String(meta?.updatedAt || '').trim();
      if (serverUpdatedAt && serverUpdatedAt === cachedUpdatedAt) {
        perfLog('[offline-first][article] choose.cache.meta.same', { id, cachedUpdatedAt });
        return cached;
      }
      perfLog('[offline-first][article] choose.network.meta.diff', {
        id,
        cachedUpdatedAt,
        serverUpdatedAt: serverUpdatedAt || null,
      });
      return fetchOnline();
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
      return cached;
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

export function createArticle(title) {
  const runOnline = () => apiRequest('/api/articles', { method: 'POST', body: JSON.stringify({ title }) });
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
      const root = (idx || []).filter((a) => !a.parentId);
      const maxPos = root.reduce((acc, a) => Math.max(acc, Number(a.position || 0)), -1);
      const localArticle = {
        id,
        title: title || 'Новая статья',
        updatedAt: now,
        createdAt: now,
        docJson: null,
        blocks: [],
        encrypted: false,
        parentId: null,
        position: maxPos + 1,
      };
      cacheArticle(localArticle).catch(() => {});
      enqueueOp('create_article', { articleId: id, payload: { id, title: localArticle.title } }).catch(() => {});
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
    await updateCachedDocJson(articleId, docJson, now).catch(() => {});
    await enqueueOp('save_doc_json', {
      articleId,
      payload: { docJson, createVersionIfStaleHours: payload.createVersionIfStaleHours || 12, coalesceKey: articleId },
      coalesceKey: articleId,
    }).catch(() => {});
    return { status: 'queued', articleId, updatedAt: now, offline: true };
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
  return apiRequest(`/api/articles/${id}${force}`, { method: 'DELETE' });
}

export function restoreArticle(id) {
  return apiRequest(`/api/articles/${id}/restore`, { method: 'POST' });
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

export function uploadAttachmentFile(articleId, file) {
  if (typeof navigator !== 'undefined' && navigator && navigator.onLine === false) {
    return Promise.reject(new Error('Нет интернета: загрузка файлов недоступна оффлайн'));
  }
  const formData = new FormData();
  formData.append('file', file);
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

export function uploadAttachmentFileWithProgress(articleId, file, onProgress = () => {}) {
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
      try {
        const index = await apiRequest('/api/articles');
        cacheArticlesIndex(index).catch(() => {});
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

export async function registerYandexAttachment(articleId, { path, originalName, contentType, size }) {
  if (typeof navigator !== 'undefined' && navigator && navigator.onLine === false) {
    throw new Error('Нет интернета: загрузка файлов недоступна оффлайн');
  }
  const payload = {
    path: path || '',
    originalName: originalName || '',
    contentType: contentType || '',
    size: typeof size === 'number' ? size : 0,
  };
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

export async function uploadFileToYandexDisk(articleId, file, { onProgress } = {}) {
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
    });
    return attachment;
  }

  // Fallback: загружаем файл через обычный endpoint вложений.
  const attachment = await uploadAttachmentFileWithProgress(articleId, file, onProgress);
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
