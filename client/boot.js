(() => {
  const APP_MODULE = window.__memusAppModule || '/app.js';
  const BOOT_SESSION_KEY = 'ttree_boot_session_v1';
  const LAST_USER_KEY = 'ttree_last_user_v1';
  const LAST_ACTIVE_KEY = 'ttree_last_active_at_v1';
  const MAX_QUEUED_SECTIONS = 200;
  const IDLE_MS = 15 * 60 * 1000;
  const SLOW_BOOT_MS = 2500;
  const DEBUG_KEY = 'ttree_debug_quick_notes_v1';
  const KNOWN_USER_KEYS_KEY = 'ttree_offline_known_user_keys_v1';
  const OFFLINE_DB_PREFIX = 'memus_offline_v1_';
  const FORCE_CACHED_INDEX_KEY = 'ttree_offline_recovery_force_index_v1';

  function debugEnabled() {
    try {
      return window?.localStorage?.getItem?.(DEBUG_KEY) === '1';
    } catch {
      return false;
    }
  }
  function dlog(...args) {
    try {
      if (!debugEnabled()) return;
      // eslint-disable-next-line no-console
      console.log('[quick-notes][boot]', ...args);
    } catch {
      // ignore
    }
  }

  function rlog(...args) {
    try {
      // eslint-disable-next-line no-console
      console.log('[quick-notes][recovery]', ...args);
    } catch {
      // ignore
    }
  }

  function elog(...args) {
    try {
      // eslint-disable-next-line no-console
      console.error('[quick-notes][recovery]', ...args);
    } catch {
      // ignore
    }
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    try {
      navigator.serviceWorker
        .register('/uploads-sw.js', { scope: '/', updateViaCache: 'none' })
        .then((reg) => {
          try {
            // If a new SW is waiting (server __BUILD_ID__ changed), activate it immediately.
            if (reg && reg.waiting) {
              reg.waiting.postMessage({ type: 'memus:skipWaiting' });
            }
            reg?.addEventListener?.('updatefound', () => {
              try {
                const installing = reg.installing;
                if (!installing) return;
                installing.addEventListener('statechange', () => {
                  if (installing.state !== 'installed') return;
                  // If we already have a controller, this is an update -> activate it.
                  if (navigator.serviceWorker.controller) {
                    try {
                      reg.waiting?.postMessage?.({ type: 'memus:skipWaiting' });
                    } catch {
                      // ignore
                    }
                  }
                });
              } catch {
                // ignore
              }
            });
          } catch {
            // ignore
          }
          try {
            const p = reg?.update?.();
            if (p && typeof p.catch === 'function') p.catch(() => {});
          } catch {
            // ignore
          }
        })
        .catch(() => {});

	      try {
	        // Avoid a "double reload" after a user-initiated refresh:
	        // the SW can finish installing/claiming a few seconds later and fire `controllerchange`.
	        // Only force-reload when the page started controlled (this is an in-place update),
	        // and it wasn't a manual reload navigation.
	        const startedControlled = Boolean(navigator.serviceWorker.controller);
	        const manualReloadNav = isReloadNavigation();
	        let reloaded = false;
	        navigator.serviceWorker.addEventListener('controllerchange', () => {
	          if (reloaded) return;
	          reloaded = true;
	          if (!startedControlled) return;
	          if (manualReloadNav) return;
	          try {
	            window.location.reload();
	          } catch {
	            // ignore
	          }
	        });
	      } catch {
	        // ignore
	      }
	    } catch {
      // ignore
    }
  }

  function isPublicPath() {
    try {
      return String(window.location.pathname || '').startsWith('/p/');
    } catch {
      return false;
    }
  }

  function isOffline() {
    try {
      return Boolean(typeof navigator !== 'undefined' && navigator && navigator.onLine === false);
    } catch {
      return false;
    }
  }

  function isReloadNavigation() {
    try {
      const entries = performance.getEntriesByType?.('navigation') || [];
      const nav = entries && entries[0];
      return String(nav?.type || '') === 'reload';
    } catch {
      return false;
    }
  }

  function readLastActiveMs() {
    try {
      const raw = window.localStorage.getItem(LAST_ACTIVE_KEY) || '';
      const ms = Number(raw);
      return Number.isFinite(ms) ? ms : 0;
    } catch {
      return 0;
    }
  }

  function markActiveNow() {
    try {
      window.localStorage.setItem(LAST_ACTIVE_KEY, String(Date.now()));
    } catch {
      // ignore
    }
  }

  function isIdleTooLong() {
    const last = readLastActiveMs();
    if (!last) return true;
    return Date.now() - last > IDLE_MS;
  }

  function isColdStart() {
    try {
      const prev = window.sessionStorage.getItem(BOOT_SESSION_KEY);
      if (!prev) {
        window.sessionStorage.setItem(BOOT_SESSION_KEY, '1');
        return true;
      }
      return false;
    } catch {
      // If sessionStorage is blocked, assume cold (better UX for quick note).
      return true;
    }
  }

  function hasKnownUser() {
    try {
      const raw = window.localStorage.getItem(LAST_USER_KEY);
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      return Boolean(parsed && (parsed.id || parsed.username));
    } catch {
      return false;
    }
  }

  function uuid() {
    try {
      if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
        return globalThis.crypto.randomUUID();
      }
    } catch {
      // ignore
    }
    return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function readKnownUserKeys() {
    try {
      const raw = window.localStorage.getItem(KNOWN_USER_KEYS_KEY) || '[]';
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.filter(Boolean).map(String) : [];
    } catch {
      return [];
    }
  }

  async function listOfflineDbUserKeys() {
    try {
      if (!('indexedDB' in window)) return [];
      if (typeof indexedDB.databases === 'function') {
        const dbs = (await indexedDB.databases()) || [];
        const names = dbs.map((d) => d && d.name).filter(Boolean);
        const keys = names
          .filter((name) => String(name).startsWith(OFFLINE_DB_PREFIX))
          .map((name) => String(name).slice(OFFLINE_DB_PREFIX.length))
          .filter(Boolean);
        const uniq = Array.from(new Set(keys));
        return uniq;
      }
    } catch {
      // ignore
    }
    // Fallback: use keys we remembered when IDB was opened.
    return Array.from(new Set(readKnownUserKeys()));
  }

  function openIdbByName(name, version) {
    return new Promise((resolve, reject) => {
      try {
        const req = version ? indexedDB.open(name, version) : indexedDB.open(name);
        if (version) {
          req.onupgradeneeded = () => {
            try {
              const db = req.result;
              if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });

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
                try {
                  // eslint-disable-next-line no-undef
                  const tx = req.transaction;
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
            } catch {
              // ignore
            }
          };
        }
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => {
          const err = req.error || new Error('IndexedDB open failed');
          elog('idb.open.error', { name, version: version || null, message: String(err?.message || err) });
          reject(err);
        };
      } catch (e) {
        elog('idb.open.throw', { name, version: version || null, message: String(e?.message || e) });
        reject(e);
      }
    });
  }

  function idbGetAll(db, storeName) {
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction([storeName], 'readonly');
        const store = tx.objectStore(storeName);
        const req = store.getAll();
        req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
        req.onerror = () => {
          const err = req.error || new Error('IndexedDB getAll failed');
          elog('idb.getAll.error', { storeName, message: String(err?.message || err) });
          reject(err);
        };
      } catch (e) {
        elog('idb.getAll.throw', { storeName, message: String(e?.message || e) });
        reject(e);
      }
    });
  }

  function idbCount(db, storeName) {
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction([storeName], 'readonly');
        const store = tx.objectStore(storeName);
        const req = store.count();
        req.onsuccess = () => resolve(Number(req.result || 0));
        req.onerror = () => {
          const err = req.error || new Error('IndexedDB count failed');
          elog('idb.count.error', { storeName, message: String(err?.message || err) });
          reject(err);
        };
      } catch (e) {
        elog('idb.count.throw', { storeName, message: String(e?.message || e) });
        reject(e);
      }
    });
  }

  function downloadJson(filename, payload) {
    try {
      const text = JSON.stringify(payload);
      const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        try {
          a.remove();
          URL.revokeObjectURL(url);
        } catch {
          // ignore
        }
      }, 0);
      return true;
    } catch {
      return false;
    }
  }

  function downloadBlob(filename, blob) {
    try {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        try {
          a.remove();
          URL.revokeObjectURL(url);
        } catch {
          // ignore
        }
      }, 0);
      return true;
    } catch {
      return false;
    }
  }

  async function apiJson(path, { method = 'GET', body = null, timeoutMs = 20000 } = {}) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const opts = { method, credentials: 'include', headers: {}, signal: controller?.signal };
    if (body !== null) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    let timer = null;
    let timedOut = false;
    if (controller && typeof timeoutMs === 'number' && timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          timedOut = true;
          // Some browsers support abort(reason); keep it best-effort.
          try {
            controller.abort(new Error(`timeout after ${timeoutMs}ms`));
          } catch {
            controller.abort();
          }
        } catch {
          // ignore
        }
      }, timeoutMs);
    }
    let res;
    try {
      res = await fetch(path, opts);
    } finally {
      if (timer) clearTimeout(timer);
    }
    const text = await res.text().catch(() => '');
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const msg = (json && (json.detail || json.error)) || text || `${res.status} ${res.statusText}`;
      const err = new Error(msg);
      err.status = res.status;
      err.payload = json;
      throw err;
    }
    return json;
  }

  async function apiJsonWithTimeoutHint(path, opts) {
    try {
      return await apiJson(path, opts);
    } catch (e) {
      // Normalize AbortError so logs are actionable.
      const name = String(e?.name || '');
      if (name === 'AbortError' || String(e?.message || '').toLowerCase().includes('aborted')) {
        const ms = typeof opts?.timeoutMs === 'number' ? opts.timeoutMs : null;
        const err = new Error(ms ? `timeout after ${ms}ms` : 'request aborted');
        err.name = 'TimeoutError';
        throw err;
      }
      throw e;
    }
  }

  function safeJsonParse(str) {
    try {
      return str ? JSON.parse(str) : null;
    } catch {
      return null;
    }
  }

  function shouldSkipServerRestoreArticleId(id) {
    const s = String(id || '');
    if (!s) return true;
    if (s === 'inbox') return true;
    if (s.startsWith('inbox-')) return true;
    return false;
  }

  async function restoreOfflineArticlesToServer({ userKey, onProgress }) {
    const key = String(userKey || '').trim();
    if (!key) throw new Error('No userKey');
    const db = await openIdbByName(`${OFFLINE_DB_PREFIX}${key}`).catch((e) => {
      elog('restore.server.idb.open.error', { userKey: key, message: String(e?.message || e) });
      throw e;
    });
    const rows = await idbGetAll(db, 'articles').catch((e) => {
      elog('restore.server.idb.read.error', { userKey: key, message: String(e?.message || e) });
      throw e;
    });
    try {
      db.close();
    } catch {
      // ignore
    }

    const articles = (Array.isArray(rows) ? rows : [])
      .filter((r) => r && !r.deletedAt && !shouldSkipServerRestoreArticleId(r.id))
      .map((r) => {
        const article = safeJsonParse(r.articleJsonStr) || {};
        const docJson = safeJsonParse(r.docJsonStr) || article.docJson || null;
        return {
          id: String(r.id),
          title: (r.title || article.title || '').toString(),
          parentId: r.parentId ?? article.parentId ?? null,
          position: typeof r.position === 'number' ? r.position : typeof article.position === 'number' ? article.position : 0,
          docJson: docJson && typeof docJson === 'object' ? docJson : null,
        };
      })
      .filter((a) => a.id && a.docJson);

    const total = articles.length;
    const createdOrEnsured = { n: 0 };
    const saved = { n: 0 };
    const moved = { n: 0 };

    const progress = (phase, extra = {}) => {
      try {
        onProgress?.({ phase, total, created: createdOrEnsured.n, saved: saved.n, moved: moved.n, ...extra });
      } catch {
        // ignore
      }
    };

    // Phase 1: create + save content
    progress('start');
    for (let i = 0; i < articles.length; i += 1) {
      const a = articles[i];
      progress('content', { idx: i + 1, articleId: a.id, title: a.title });
      // Ensure article exists (server supports client-supplied id).
      try {
        rlog('restore.server.create.start', { idx: i + 1, id: a.id });
        await apiJsonWithTimeoutHint('/api/articles', {
          method: 'POST',
          body: { id: a.id, title: a.title || 'Без названия' },
          timeoutMs: 15000,
        });
        createdOrEnsured.n += 1;
        rlog('restore.server.create.done', { idx: i + 1, id: a.id });
      } catch (e) {
        // If already exists or server rejects, treat as ok and proceed to save.
        rlog('restore.server.create.skip', {
          idx: i + 1,
          id: a.id,
          status: e?.status || null,
          message: String(e?.message || e),
        });
      }
      try {
        rlog('restore.server.save.start', { idx: i + 1, id: a.id });
        // Use lightweight endpoint: store docJson without expensive derived indexes.
        // Main goal for recovery is: stop 404 and persist content. Reindexing can be done later.
        await apiJsonWithTimeoutHint(`/api/articles/${encodeURIComponent(a.id)}/doc-json`, {
          method: 'PUT',
          body: { docJson: a.docJson },
          timeoutMs: 30000,
        });
        saved.n += 1;
        rlog('restore.server.save.done', { idx: i + 1, id: a.id });
      } catch (e) {
        elog('restore.server.save.error', {
          idx: i + 1,
          id: a.id,
          status: e?.status || null,
          message: String(e?.message || e),
          stack: String(e?.stack || ''),
        });
        // Continue with next article (best-effort restore).
      }
    }

    // Phase 2: restore structure/order (best-effort)
    const byParent = new Map();
    for (const a of articles) {
      const pid = a.parentId || null;
      if (!byParent.has(pid)) byParent.set(pid, []);
      byParent.get(pid).push(a);
    }
    for (const [pid, arr] of byParent.entries()) {
      arr.sort((x, y) => Number(x.position || 0) - Number(y.position || 0));
      byParent.set(pid, arr);
    }

    const q = [null];
    const seen = new Set();
    progress('structure');
    while (q.length) {
      const parentId = q.shift();
      const keyPid = parentId || '__root__';
      if (seen.has(keyPid)) continue;
      seen.add(keyPid);
      const children = byParent.get(parentId || null) || [];
      for (const child of children) {
        progress('structure', { articleId: child.id, title: child.title });
        try {
          await apiJson(`/api/articles/${encodeURIComponent(child.id)}/move-tree`, {
            method: 'POST',
            body: { parentId: parentId || null, anchorId: null, placement: 'inside' },
          });
          moved.n += 1;
        } catch (e) {
          rlog('restore.server.move.skip', { id: child.id, status: e?.status || null, message: String(e?.message || e) });
        }
        if (byParent.has(child.id)) q.push(child.id);
      }
    }

    progress('done');
    return { total, created: createdOrEnsured.n, saved: saved.n, moved: moved.n };
  }

  function makeRecoveryNdjsonStream(dump) {
    const te = new TextEncoder();
    const stores = Object.entries(dump?.stores || {});
    const metaLine = {
      type: 'meta',
      exportedAt: dump?.exportedAt || nowIso(),
      sourceUserKey: dump?.sourceUserKey || null,
      dbName: dump?.dbName || null,
      format: 'ndjson.v1',
    };

    let headerSent = false;
    let storeIdx = 0;
    let itemIdx = -1;

    return new ReadableStream({
      pull(controller) {
        try {
          if (!headerSent) {
            headerSent = true;
            controller.enqueue(te.encode(`${JSON.stringify(metaLine)}\n`));
            return;
          }
          while (storeIdx < stores.length) {
            const [storeName, items] = stores[storeIdx];
            const arr = Array.isArray(items) ? items : [];
            if (itemIdx === -1) {
              itemIdx = 0;
              controller.enqueue(
                te.encode(`${JSON.stringify({ type: 'store', store: storeName, count: arr.length })}\n`),
              );
              return;
            }
            if (itemIdx >= arr.length) {
              storeIdx += 1;
              itemIdx = -1;
              // continue to next store
              continue;
            }
            const line = { type: 'item', store: storeName, value: arr[itemIdx] };
            itemIdx += 1;
            controller.enqueue(te.encode(`${JSON.stringify(line)}\n`));
            return;
          }
          controller.close();
        } catch (e) {
          elog('ndjson.stream.error', { message: String(e?.message || e), stack: String(e?.stack || '') });
          controller.error(e);
        }
      },
    });
  }

  async function exportRecoveryDumpAsFile(baseFilename, dump) {
    // Always export as NDJSON (optionally gzipped) to avoid huge JSON stringify limits.
    const stream = makeRecoveryNdjsonStream(dump);
    const canGzip = typeof CompressionStream !== 'undefined';
    const outStream = canGzip ? stream.pipeThrough(new CompressionStream('gzip')) : stream;
    const blob = await new Response(outStream).blob();
    const filename = canGzip ? `${baseFilename}.ndjson.gz` : `${baseFilename}.ndjson`;

    // NOTE: `navigator.share()` requires a direct user gesture, but we do async work above (read IDB + build blob),
    // so calling share here will often fail with NotAllowedError. On desktop, downloading is enough.
    // Keep share disabled to avoid flaky UX.

    if (downloadBlob(filename, blob)) return { ok: true, method: 'download', filename };
    try {
      const url = URL.createObjectURL(blob);
      try {
        window.open(url, '_blank', 'noopener');
      } catch {
        window.location.href = url;
      }
      return { ok: true, method: 'open', filename };
    } catch (e) {
      elog('export.open.error', { filename, message: String(e?.message || e), stack: String(e?.stack || '') });
    }
    return { ok: false, method: 'none', filename };
  }

  function getLastKnownUserKey() {
    try {
      const raw = window.localStorage.getItem(LAST_USER_KEY) || '';
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed?.id || parsed?.username || '';
    } catch {
      return '';
    }
  }

  async function exportOfflineDb(userKey) {
    const safeKey = String(userKey || '').trim();
    if (!safeKey) throw new Error('No userKey');
    const dbName = `${OFFLINE_DB_PREFIX}${safeKey}`;
    const db = await openIdbByName(dbName, 3);
    const stores = [
      'articles',
      'outline_sections',
      'media_assets',
      'media_refs',
      'outbox',
      'pending_uploads',
      'section_embeddings',
      'meta',
    ].filter((s) => {
      try {
        return db.objectStoreNames.contains(s);
      } catch {
        return false;
      }
    });

    const out = { exportedAt: nowIso(), sourceUserKey: safeKey, dbName, stores: {} };
    for (const s of stores) {
      // eslint-disable-next-line no-await-in-loop
      out.stores[s] = await idbGetAll(db, s).catch((e) => {
        elog('export.store.read.error', { userKey: safeKey, store: s, message: String(e?.message || e) });
        return [];
      });
    }
    try {
      db.close();
    } catch {
      // ignore
    }
    return out;
  }

  async function importOfflineDumpToUser(dump, targetUserKey) {
    const targetKey = String(targetUserKey || '').trim();
    if (!targetKey) throw new Error('No target userKey');
    if (!dump || typeof dump !== 'object' || !dump.stores || typeof dump.stores !== 'object') throw new Error('Invalid dump');
    const dbName = `${OFFLINE_DB_PREFIX}${targetKey}`;
    const db = await openIdbByName(dbName, 3);

    const upsertStore = async (storeName, items) => {
      if (!db.objectStoreNames.contains(storeName)) return 0;
      const rows = Array.isArray(items) ? items : [];
      if (!rows.length) return 0;
      const tx = db.transaction([storeName], 'readwrite');
      const store = tx.objectStore(storeName);
      let n = 0;
      await new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => {
          const err = tx.error || new Error('tx failed');
          elog('import.tx.error', { storeName, message: String(err?.message || err) });
          reject(err);
        };
        tx.onabort = () => {
          const err = tx.error || new Error('tx aborted');
          elog('import.tx.abort', { storeName, message: String(err?.message || err) });
          reject(err);
        };
        for (const row of rows) {
          try {
            store.put(row);
            n += 1;
          } catch {
            // ignore single row errors
          }
        }
      });
      return n;
    };

    let total = 0;
    total += await upsertStore('articles', dump.stores.articles);
    total += await upsertStore('outline_sections', dump.stores.outline_sections);
    total += await upsertStore('media_assets', dump.stores.media_assets);
    total += await upsertStore('media_refs', dump.stores.media_refs);
    total += await upsertStore('pending_uploads', dump.stores.pending_uploads);
    total += await upsertStore('section_embeddings', dump.stores.section_embeddings);

    try {
      db.close();
    } catch {
      // ignore
    }
    return total;
  }

  const PENDING_KEY = 'ttree_pending_quick_notes_v1';
  function readPendingQuickNotes() {
    try {
      const raw = window.localStorage.getItem(PENDING_KEY) || '';
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
    } catch {
      return [];
    }
  }
  function writePendingQuickNotes(items) {
    try {
      window.localStorage.setItem(PENDING_KEY, JSON.stringify(Array.isArray(items) ? items : []));
    } catch {
      // ignore
    }
  }

  function addQuickNoteToPending(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return null;
    const sectionId = uuid();
    const note = { id: sectionId, sectionId, createdAt: nowIso(), text: trimmed };
    const items = readPendingQuickNotes();
    const next = [note, ...items].slice(0, MAX_QUEUED_SECTIONS);
    writePendingQuickNotes(next);
    dlog('saved.pending', { id: note.id, len: next.length });
    return note;
  }

  function ensureBootStyles() {
    if (document.getElementById('quickNoteBootStyles')) return;
    const style = document.createElement('style');
    style.id = 'quickNoteBootStyles';
    style.textContent = `
      .boot-modal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:99999;display:flex;align-items:center;justify-content:center;padding:16px}
      .boot-modal{width:min(720px,100%);background:#0b1220;border:1px solid rgba(255,255,255,.08);border-radius:16px;box-shadow:0 24px 80px rgba(0,0,0,.5);color:#e5e7eb}
      .boot-modal__hdr{padding:14px 16px;border-bottom:1px solid rgba(255,255,255,.08);display:flex;align-items:center;justify-content:space-between;gap:12px}
      .boot-modal__title{font-size:14px;font-weight:600;letter-spacing:.2px}
      .boot-modal__meta{font-size:12px;color:#9ca3af}
      .boot-modal__body{padding:12px 16px}
      .boot-note{width:100%;min-height:34vh;max-height:52vh;resize:vertical;border:1px solid rgba(255,255,255,.1);border-radius:12px;padding:12px 12px;font:14px/1.35 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;outline:none}
      .boot-note:focus{border-color:rgba(59,130,246,.6);box-shadow:0 0 0 3px rgba(59,130,246,.25)}
      .boot-modal__ftr{padding:12px 16px;border-top:1px solid rgba(255,255,255,.08);display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
      .boot-actions{display:flex;gap:10px;flex-wrap:wrap}
      .boot-btn{appearance:none;border:1px solid rgba(255,255,255,.14);background:#111827;color:#e5e7eb;border-radius:999px;padding:10px 14px;font:600 13px/1 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;cursor:pointer}
      .boot-btn:hover{background:#0f172a}
      .boot-btn--primary{background:#2563eb;border-color:#2563eb}
      .boot-btn--primary:hover{background:#1d4ed8}
      .boot-btn--ghost{background:transparent}
      .boot-hint{font-size:12px;color:#9ca3af}
      .boot-toast{margin-left:auto;font-size:12px;color:#a7f3d0}
    `;
    document.head.appendChild(style);
  }

  function runOnIdle(fn, { timeout = 5000, fallbackDelay = 1200 } = {}) {
    try {
      if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(() => fn(), { timeout });
        return;
      }
    } catch {
      // ignore
    }
    setTimeout(() => fn(), fallbackDelay);
  }

  function loadFullAppInBackground() {
    runOnIdle(() => {
      try {
        import(APP_MODULE).catch(() => {});
      } catch {
        // ignore
      }
    });
  }

  function showQuickNoteModal({ reason = '' } = {}) {
    ensureBootStyles();

    const backdrop = document.createElement('div');
    backdrop.className = 'boot-modal-backdrop';

    const modal = document.createElement('div');
    modal.className = 'boot-modal';

    const header = document.createElement('div');
    header.className = 'boot-modal__hdr';

    const left = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'boot-modal__title';
    title.textContent = 'Быстрая заметка (оффлайн-буфер)';
    const meta = document.createElement('div');
    meta.className = 'boot-modal__meta';
    const count = readPendingQuickNotes().length;
    meta.textContent = count ? `В очереди: ${count}` : (reason ? `Причина: ${reason}` : 'Можно без интернета и без входа');
    left.appendChild(title);
    left.appendChild(meta);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'boot-btn boot-btn--ghost';
    closeBtn.textContent = 'Закрыть';

    header.appendChild(left);
    header.appendChild(closeBtn);

    const body = document.createElement('div');
    body.className = 'boot-modal__body';
    const textarea = document.createElement('textarea');
    textarea.className = 'boot-note';
    textarea.placeholder = 'Введите заметку…\n\nCtrl+Enter — сохранить\nEsc — закрыть';
    body.appendChild(textarea);

    const footer = document.createElement('div');
    footer.className = 'boot-modal__ftr';

    const hint = document.createElement('div');
    hint.className = 'boot-hint';
    hint.textContent = 'Заметки сохраняются локально и будут отправлены в “Быстрые заметки” при следующем входе.';

    const actions = document.createElement('div');
    actions.className = 'boot-actions';

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'boot-btn boot-btn--primary';
    saveBtn.textContent = 'Сохранить';

    const saveMoreBtn = document.createElement('button');
    saveMoreBtn.type = 'button';
    saveMoreBtn.className = 'boot-btn';
    saveMoreBtn.textContent = 'Сохранить и ещё';

    actions.appendChild(saveBtn);
    actions.appendChild(saveMoreBtn);

    const toast = document.createElement('div');
    toast.className = 'boot-toast';

    footer.appendChild(hint);
    footer.appendChild(actions);
    footer.appendChild(toast);

    modal.appendChild(header);
    modal.appendChild(body);
    modal.appendChild(footer);
    backdrop.appendChild(modal);

    const updateMeta = () => {
      const c = readPendingQuickNotes().length;
      meta.textContent = c ? `В очереди: ${c}` : (reason ? `Причина: ${reason}` : 'Можно без интернета и без входа');
    };

    const close = () => {
      try {
        backdrop.remove();
      } catch {
        // ignore
      }
    };

    const save = (keepOpen) => {
      const note = addQuickNoteToPending(textarea.value);
      if (!note) return;
      textarea.value = '';
      toast.textContent = 'Сохранено локально';
      updateMeta();
      markActiveNow();
      try {
        window.dispatchEvent(new CustomEvent('memus:queued-inbox-changed', { detail: { note } }));
        dlog('event.dispatched', { type: 'memus:queued-inbox-changed' });
      } catch {
        // ignore
      }
      if (!keepOpen) close();
      setTimeout(() => {
        try {
          toast.textContent = '';
        } catch {
          // ignore
        }
      }, 1200);
    };

    closeBtn.addEventListener('click', close);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close();
    });
    saveBtn.addEventListener('click', () => save(false));
    saveMoreBtn.addEventListener('click', () => save(true));
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        save(true);
      }
    });

    const showRecoveryModal = async () => {
      ensureBootStyles();
      const rBackdrop = document.createElement('div');
      rBackdrop.className = 'boot-modal-backdrop';
      const rModal = document.createElement('div');
      rModal.className = 'boot-modal';

      const rHeader = document.createElement('div');
      rHeader.className = 'boot-modal__hdr';
      const rLeft = document.createElement('div');
      const rTitle = document.createElement('div');
      rTitle.className = 'boot-modal__title';
      rTitle.textContent = 'Восстановление локальных данных';
      const rMeta = document.createElement('div');
      rMeta.className = 'boot-modal__meta';
      rMeta.textContent = 'Ищем старые локальные базы…';
      rLeft.appendChild(rTitle);
      rLeft.appendChild(rMeta);

      const rCloseBtn = document.createElement('button');
      rCloseBtn.type = 'button';
      rCloseBtn.className = 'boot-btn boot-btn--ghost';
      rCloseBtn.textContent = 'Закрыть';
      rHeader.appendChild(rLeft);
      rHeader.appendChild(rCloseBtn);

      const rBody = document.createElement('div');
      rBody.className = 'boot-modal__body';
      const list = document.createElement('div');
      list.style.display = 'flex';
      list.style.flexDirection = 'column';
      list.style.gap = '10px';
      rBody.appendChild(list);

      const rFooter = document.createElement('div');
      rFooter.className = 'boot-modal__ftr';
      const rHint = document.createElement('div');
      rHint.className = 'boot-hint';
      rHint.textContent =
        'Если после входа все статьи пропали, возможно изменился userKey. Здесь можно экспортировать старые данные или импортировать их в текущего пользователя.';

      const rToast = document.createElement('div');
      rToast.className = 'boot-toast';
      rFooter.appendChild(rHint);
      rFooter.appendChild(rToast);

      rModal.appendChild(rHeader);
      rModal.appendChild(rBody);
      rModal.appendChild(rFooter);
      rBackdrop.appendChild(rModal);

      const rClose = () => {
        try {
          rBackdrop.remove();
        } catch {
          // ignore
        }
      };
      rCloseBtn.addEventListener('click', rClose);
      rBackdrop.addEventListener('click', (e) => {
        if (e.target === rBackdrop) rClose();
      });

      document.body.appendChild(rBackdrop);

      const renderRow = (userKey, { articleCount } = {}) => {
        const row = document.createElement('div');
        row.style.border = '1px solid rgba(255,255,255,.12)';
        row.style.borderRadius = '12px';
        row.style.padding = '12px';
        row.style.display = 'flex';
        row.style.flexDirection = 'column';
        row.style.gap = '10px';

        const top = document.createElement('div');
        top.style.display = 'flex';
        top.style.alignItems = 'baseline';
        top.style.justifyContent = 'space-between';
        top.style.gap = '12px';

        const keyEl = document.createElement('div');
        keyEl.style.fontWeight = '600';
        keyEl.style.fontSize = '13px';
        keyEl.textContent = userKey;

        const metaEl = document.createElement('div');
        metaEl.dataset.recoveryMeta = '1';
        metaEl.style.fontSize = '12px';
        metaEl.style.color = '#9ca3af';
        metaEl.textContent = typeof articleCount === 'number' ? `Статей: ${articleCount}` : '';

        top.appendChild(keyEl);
        top.appendChild(metaEl);

        const buttons = document.createElement('div');
        buttons.className = 'boot-actions';

        const exportBtn = document.createElement('button');
        exportBtn.type = 'button';
        exportBtn.className = 'boot-btn';
        exportBtn.textContent = 'Экспорт JSON';

        const importBtn = document.createElement('button');
        importBtn.type = 'button';
        importBtn.className = 'boot-btn boot-btn--primary';
        importBtn.textContent = 'Импорт в текущего пользователя';

        const restoreServerBtn = document.createElement('button');
        restoreServerBtn.type = 'button';
        restoreServerBtn.className = 'boot-btn';
        restoreServerBtn.textContent = 'На сервер';

        buttons.appendChild(exportBtn);
        buttons.appendChild(importBtn);
        buttons.appendChild(restoreServerBtn);
        row.appendChild(top);
        row.appendChild(buttons);

        exportBtn.addEventListener('click', async () => {
          const t0 = performance.now();
          try {
            rToast.textContent = 'Экспорт…';
            rlog('export.start', { userKey });
            const dump = await exportOfflineDb(userKey);
            const base = `memus-offline-recovery-${userKey}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
            const res = await exportRecoveryDumpAsFile(base, dump);
            rlog('export.done', { userKey, ok: res.ok, method: res.method, filename: res.filename, ms: Math.round(performance.now() - t0) });
            rToast.textContent = res.ok
              ? (res.method === 'download'
                ? `Скачивание началось: ${res.filename}`
                : res.method === 'open'
                  ? `Открыл файл в новой вкладке: ${res.filename}`
                  : `Экспортировано: ${res.filename}`)
              : 'Не удалось экспортировать (ограничения браузера)';
          } catch (e) {
            elog('export.button.error', { userKey, message: String(e?.message || e), stack: String(e?.stack || '') });
            rToast.textContent = `Ошибка экспорта: ${String(e && e.message ? e.message : e)}`;
          } finally {
            setTimeout(() => {
              try {
                rToast.textContent = '';
              } catch {
                // ignore
              }
            }, 8000);
          }
        });

        importBtn.addEventListener('click', async () => {
          const t0 = performance.now();
          try {
            const targetKey = getLastKnownUserKey();
            if (!targetKey) {
              rToast.textContent = 'Нет “текущего пользователя” в localStorage. Сначала один раз войдите.';
              return;
            }
            rToast.textContent = 'Импорт…';
            rlog('import.start', { from: userKey, to: targetKey });
            const dump = await exportOfflineDb(userKey);
            const imported = await importOfflineDumpToUser(dump, targetKey);
            try {
              window.localStorage.setItem(FORCE_CACHED_INDEX_KEY, '1');
            } catch {
              // ignore
            }
            // Verify quickly (counts only; cheap).
            const targetDb = await openIdbByName(`${OFFLINE_DB_PREFIX}${targetKey}`).catch(() => null);
            let articlesCount = null;
            let sectionsCount = null;
            if (targetDb) {
              articlesCount = await idbCount(targetDb, 'articles').catch(() => null);
              sectionsCount = await idbCount(targetDb, 'outline_sections').catch(() => null);
              try {
                targetDb.close();
              } catch {
                // ignore
              }
            }
            rlog('import.done', {
              from: userKey,
              to: targetKey,
              imported,
              targetArticles: articlesCount,
              targetSections: sectionsCount,
              ms: Math.round(performance.now() - t0),
            });
            const meta = typeof articlesCount === 'number' ? ` (в базе статей: ${articlesCount})` : '';
            rToast.textContent = `Импортировано записей: ${imported}${meta}`;
            try {
              window.dispatchEvent(new CustomEvent('memus:offline-recovery-imported', { detail: { from: userKey, to: targetKey } }));
            } catch {
              // ignore
            }
          } catch (e) {
            elog('import.button.error', { userKey, message: String(e?.message || e), stack: String(e?.stack || '') });
            rToast.textContent = `Ошибка импорта: ${String(e && e.message ? e.message : e)}`;
          } finally {
            setTimeout(() => {
              try {
                rToast.textContent = '';
              } catch {
                // ignore
              }
            }, 8000);
          }
        });

        restoreServerBtn.addEventListener('click', async () => {
          const t0 = performance.now();
          try {
            rToast.textContent = 'Восстановление на сервер…';
            rlog('restore.server.start', { userKey });
            const out = await restoreOfflineArticlesToServer({
              userKey,
              onProgress: (p) => {
                const phase = p.phase;
                if (phase === 'content') {
                  rToast.textContent = `На сервер: ${p.idx}/${p.total} · ${p.title || p.articleId}`;
                } else if (phase === 'structure') {
                  rToast.textContent = `Структура… (${p.moved}/${p.total})`;
                } else if (phase === 'done') {
                  rToast.textContent = `Готово: статей=${p.total}, сохранено=${p.saved}`;
                }
                rlog('restore.server.progress', p);
              },
            });
            rlog('restore.server.done', { ...out, ms: Math.round(performance.now() - t0) });
            rToast.textContent = `На сервер: статей=${out.total}, сохранено=${out.saved}`;
          } catch (e) {
            elog('restore.server.error', { userKey, message: String(e?.message || e), stack: String(e?.stack || '') });
            rToast.textContent = `Ошибка: ${String(e?.message || e)}`;
          } finally {
            setTimeout(() => {
              try {
                rToast.textContent = '';
              } catch {
                // ignore
              }
            }, 12000);
          }
        });

        return row;
      };

      try {
        const keys = await listOfflineDbUserKeys();
        if (!keys.length) {
          rMeta.textContent =
            'Локальные базы не найдены. Если вы точно пользовались Memus на этом устройстве, возможно браузер не даёт перечислять IndexedDB.';
          return;
        }
        rMeta.textContent = `Найдено локальных баз: ${keys.length}`;

        for (const userKey of keys) {
          const row = renderRow(userKey);
          list.appendChild(row);
          // Try to show article count without loading everything.
          // eslint-disable-next-line no-await-in-loop
          const db = await openIdbByName(`${OFFLINE_DB_PREFIX}${userKey}`).catch(() => null);
          if (db) {
            // eslint-disable-next-line no-await-in-loop
            const c = await idbCount(db, 'articles').catch(() => null);
            try {
              db.close();
            } catch {
              // ignore
            }
            if (typeof c === 'number') {
              try {
                const metaEl = row.querySelector('[data-recovery-meta=\"1\"]');
                if (metaEl) metaEl.textContent = `Статей: ${c}`;
              } catch {
                // ignore
              }
            }
          }
        }
      } catch (e) {
        rMeta.textContent = `Ошибка: ${String(e && e.message ? e.message : e)}`;
      }
    };

    document.body.appendChild(backdrop);
    setTimeout(() => textarea.focus({ preventScroll: true }), 0);
  }

  function attachActivityTracking() {
    const bump = () => markActiveNow();
    try {
      window.addEventListener('pointerdown', bump, { passive: true });
      window.addEventListener('keydown', bump, { passive: true });
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') bump();
      });
    } catch {
      // ignore
    }
  }

  // Public pages should load immediately (no boot modal).
  if (isPublicPath()) {
    registerServiceWorker();
    import(APP_MODULE).catch(() => {});
    return;
  }

  registerServiceWorker();

  const coldStart = isColdStart();
  const knownUser = hasKnownUser();
  const offline = isOffline();
  const reloadNav = isReloadNavigation();
  const idleTooLong = isIdleTooLong();
  attachActivityTracking();
  markActiveNow();

  let modalShown = false;
  const showOnce = (reason) => {
    if (modalShown) return;
    modalShown = true;
    try {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => showQuickNoteModal({ reason }), { once: true });
      } else {
        showQuickNoteModal({ reason });
      }
    } catch {
      // ignore
    }
  };

  const shouldShowNow =
    offline ||
    reloadNav ||
    idleTooLong ||
    (coldStart && knownUser);

  if (shouldShowNow) {
    const reason = offline ? 'нет сети' : reloadNav ? 'перезагрузка' : idleTooLong ? 'простой > 15 мин' : 'холодный старт';
    showOnce(reason);
  }

  // "Slow boot" fallback: if full app hasn't started quickly, show the modal anyway.
  window.setTimeout(() => {
    try {
      if (modalShown) return;
      if (window.__memusAppStarted) return;
      showOnce('медленная загрузка');
    } catch {
      // ignore
    }
  }, SLOW_BOOT_MS);

  // Always load the full app; prefer background/idle when we already show the modal.
  if (modalShown || offline) {
    loadFullAppInBackground();
  } else {
    import(APP_MODULE).catch(() => {});
  }
})();
