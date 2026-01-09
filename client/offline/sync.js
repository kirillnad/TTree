import {
  cacheArticle,
  cacheArticlesIndex,
  getCachedArticle,
  getCachedArticlesIndex,
  getCachedArticlesSyncMeta,
  touchCachedArticleUpdatedAt,
  updateCachedDocJson,
} from './cache.js';
import { listOutbox, markOutboxError, removeOutboxOp } from './outbox.js';
import { deleteSectionEmbeddings, upsertArticleEmbeddings } from './embeddings.js';
import { startMediaPrefetchLoop, pruneUnusedMedia, updateMediaRefsForArticle } from './media.js';
import { fetchArticlesIndex } from '../api.js';
import { removePendingQuickNoteBySectionId } from '../quickNotes/pending.js';

const OUTLINE_QUEUE_KEY = 'ttree_outline_autosave_queue_docjson_v1';

function clearQueuedDocJsonIfNotNewer(articleId, clientQueuedAt = null) {
  try {
    if (!articleId) return;
    const raw = window.localStorage.getItem(OUTLINE_QUEUE_KEY) || '';
    if (!raw) return;
    const queue = JSON.parse(raw);
    if (!queue || typeof queue !== 'object') return;
    const key = String(articleId);
    const entry = queue[key] || null;
    if (!entry) return;
    const queuedAt = Number(entry?.queuedAt || 0) || 0;
    const cutoff = typeof clientQueuedAt === 'number' && Number.isFinite(clientQueuedAt) ? clientQueuedAt : null;
    if (cutoff != null && queuedAt > cutoff) return;
    delete queue[key];
    window.localStorage.setItem(OUTLINE_QUEUE_KEY, JSON.stringify(queue));
  } catch {
    // ignore
  }
}

let syncLoopStarted = false;
let isFlushing = false;
let fullPullStarted = false;
let fullPullRunning = false;
let outboxIntervalId = null;

// Avoid hammering the server with structure snapshots while the user is actively dragging/reordering.
// Snapshot ops are coalesced in the outbox, so it's safe to delay sending the latest one.
const STRUCTURE_SNAPSHOT_MIN_INTERVAL_MS = 3000;
const lastStructureSnapshotSentAtByArticle = new Map();

function debugOfflineEnabled() {
  try {
    return window?.localStorage?.getItem?.('ttree_debug_offline_v1') === '1';
  } catch {
    return false;
  }
}

function dlog(...args) {
  try {
    if (!debugOfflineEnabled()) return;
    // eslint-disable-next-line no-console
    console.log('[offline][queue]', ...args);
  } catch {
    // ignore
  }
}

function pruneOutlineDocJsonQueueToInboxOnly() {
  try {
    const raw = window.localStorage.getItem(OUTLINE_QUEUE_KEY) || '';
    if (!raw) return { changed: false, removed: 0 };
    const queue = JSON.parse(raw);
    if (!queue || typeof queue !== 'object') return { changed: false, removed: 0 };

    const keys = Object.keys(queue);
    if (!keys.length) return { changed: false, removed: 0 };

    let removed = 0;
    for (const k of keys) {
      if (k === 'inbox') continue;
      delete queue[k];
      removed += 1;
    }
    if (!removed) return { changed: false, removed: 0 };

    window.localStorage.setItem(OUTLINE_QUEUE_KEY, JSON.stringify(queue));
    dlog('prune.queue', { removed });
    return { changed: true, removed };
  } catch (err) {
    dlog('prune.queue.error', { message: err?.message || String(err || 'error') });
    return { changed: false, removed: 0 };
  }
}

let fullPullStatus = {
  running: false,
  processed: 0,
  total: 0,
  errors: 0,
  phase: 'idle', // idle | index | articles | done | error
  lastError: null,
  startedAt: null,
  finishedAt: null,
};

function emitFullPullStatus() {
  try {
    window.dispatchEvent(new CustomEvent('offline-full-pull-status', { detail: { ...fullPullStatus } }));
  } catch {
    // ignore
  }
}

export function getBackgroundFullPullStatus() {
  return { ...fullPullStatus };
}

async function rawApiRequest(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    credentials: 'include',
    ...options,
  });
  if (!response.ok) {
    const details = await response.json().catch(() => ({}));
    const err = new Error(details.detail || 'Request failed');
    err.status = response.status;
    err.details = details;
    err.path = path;
    throw err;
  }
  if (response.status === 204) {
    return null;
  }
  return response.json();
}

function isRetryableOutboxError(err) {
  const status = Number(err?.status || 0);
  if (!status) return true; // network / unknown
  if (status >= 500) return true;
  if (status === 408 || status === 429) return true;
  // Auth problems should block the queue (user needs to re-login)
  if (status === 401 || status === 403) return true;
  return false;
}

function shouldDropOutboxOp(err, op) {
  const status = Number(err?.status || 0);
  if (status === 404 || status === 410) return true;
  // Some client errors are permanent for a given op.
  if (status >= 400 && status < 500 && status !== 401 && status !== 403 && status !== 408 && status !== 429) {
    // For safety, drop content/structure ops on permanent 4xx besides auth/rate-limit.
    return op?.type === 'save_doc_json' || String(op?.type || '').startsWith('section_') || op?.type === 'structure_snapshot';
  }
  return false;
}

export async function tryPullBootstrap() {
  try {
    const index = await fetchArticlesIndex();
    cacheArticlesIndex(index).catch(() => {});
    return Array.isArray(index) ? index : [];
  } catch {
    return null;
  }
}

async function flushOp(op) {
  if (op.type === 'create_article') {
    const title = op.payload?.title || 'Новая статья';
    const id = op.payload?.id || op.articleId;
    const article = await rawApiRequest('/api/articles', {
      method: 'POST',
      body: JSON.stringify({ title, id }),
    });
    await cacheArticle(article);
    return;
  }

  if (op.type === 'save_doc_json') {
    const docJson = op.payload?.docJson || null;
    if (!docJson || typeof docJson !== 'object') return;
    const result = await rawApiRequest(`/api/articles/${encodeURIComponent(op.articleId)}/doc-json/save`, {
      method: 'PUT',
      body: JSON.stringify({ docJson, createVersionIfStaleHours: 12 }),
    });
    const updatedAt = result?.updatedAt || null;
    await updateCachedDocJson(op.articleId, docJson, updatedAt);
    try {
      const changed = Array.isArray(result?.changedBlockIds) ? result.changedBlockIds : [];
      const removed = Array.isArray(result?.removedBlockIds) ? result.removedBlockIds : [];
      if (removed.length) await deleteSectionEmbeddings(removed);
      if (changed.length) {
        const resp = await rawApiRequest(
          `/api/articles/${encodeURIComponent(op.articleId)}/embeddings?ids=${encodeURIComponent(changed.join(','))}`,
        );
        await upsertArticleEmbeddings(op.articleId, resp?.embeddings || []);
      }
    } catch {
      // ignore embeddings refresh failures
    }
    return;
  }

  if (op.type === 'section_upsert_content') {
    const sectionId = op.payload?.sectionId || null;
    const headingJson = op.payload?.headingJson || null;
    const bodyJson = op.payload?.bodyJson || null;
    const seq = op.payload?.seq || null;
    if (!sectionId || !headingJson || !bodyJson || !seq) return;
    const result = await rawApiRequest(`/api/articles/${encodeURIComponent(op.articleId)}/sections/upsert-content`, {
      method: 'PUT',
      body: JSON.stringify({
        opId: op.payload?.opId || op.id,
        sectionId,
        headingJson,
        bodyJson,
        seq,
        createVersionIfStaleHours: 12,
      }),
    });
    try {
      if (result?.updatedAt) await touchCachedArticleUpdatedAt(op.articleId, result.updatedAt);
    } catch {
      // ignore
    }
    return;
  }

  if (op.type === 'structure_snapshot') {
    const nodes = op.payload?.nodes || null;
    if (!Array.isArray(nodes) || !nodes.length) return;
    const result = await rawApiRequest(`/api/articles/${encodeURIComponent(op.articleId)}/structure/snapshot`, {
      method: 'PUT',
      body: JSON.stringify({
        opId: op.payload?.opId || op.id,
        nodes,
      }),
    });
    try {
      if (result?.updatedAt) await touchCachedArticleUpdatedAt(op.articleId, result.updatedAt);
    } catch {
      // ignore
    }
    return;
  }

  if (op.type === 'move_article_position') {
    const direction = op.payload?.direction || null;
    if (!direction) return;
    await rawApiRequest(`/api/articles/${encodeURIComponent(op.articleId)}/move`, {
      method: 'POST',
      body: JSON.stringify({ direction }),
    });
    return;
  }

  if (op.type === 'indent_article') {
    await rawApiRequest(`/api/articles/${encodeURIComponent(op.articleId)}/indent`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    return;
  }

  if (op.type === 'outdent_article') {
    await rawApiRequest(`/api/articles/${encodeURIComponent(op.articleId)}/outdent`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    return;
  }

  if (op.type === 'move_article_tree') {
    await rawApiRequest(`/api/articles/${encodeURIComponent(op.articleId)}/move-tree`, {
      method: 'POST',
      body: JSON.stringify(op.payload || {}),
    });
    return;
  }
}

async function maybeClearQueuedDocJsonAfterSuccessfulFlush(op) {
  try {
    if (!op || !op.articleId) return;
    const isRelevant =
      op.type === 'save_doc_json' || op.type === 'section_upsert_content' || op.type === 'structure_snapshot';
    if (!isRelevant) return;
    const cutoff = op.payload?.clientQueuedAt ?? null;
    if (typeof cutoff !== 'number' || !Number.isFinite(cutoff)) return;

    // Only clear the queued docJson when ALL ops for the same queuedAt are flushed.
    const remaining = await listOutbox(500);
    const stillHasSameBatch = (remaining || []).some(
      (o) =>
        o &&
        o.articleId === op.articleId &&
        (o.type === 'save_doc_json' || o.type === 'section_upsert_content' || o.type === 'structure_snapshot') &&
        (o.payload?.clientQueuedAt ?? null) === cutoff,
    );
    if (stillHasSameBatch) return;
    clearQueuedDocJsonIfNotNewer(op.articleId, cutoff);
  } catch {
    // ignore
  }
}

export async function flushOutboxOnce() {
  if (isFlushing) return null;
  if (!navigator.onLine) return false;
  isFlushing = true;
  try {
    const ops = await listOutbox(50);
	    for (const op of ops) {
		      try {
		        // Throttle server writes for structure snapshots: at most once per N ms per article.
		        // Keep the op queued (outbox coalescing ensures we only keep the newest snapshot).
		        try {
		          if (op?.type === 'structure_snapshot') {
		            const aid = String(op.articleId || '').trim();
		            if (aid) {
		              const last = Number(lastStructureSnapshotSentAtByArticle.get(aid) || 0) || 0;
		              const now = Date.now();
		              if (last && now - last < STRUCTURE_SNAPSHOT_MIN_INTERVAL_MS) {
		                continue;
		              }
		            }
		          }
		        } catch {
		          // ignore throttle failures
		        }
			        await flushOp(op);
			        try {
			          if (op?.type === 'structure_snapshot') {
			            const aid = String(op.articleId || '').trim();
			            if (aid) lastStructureSnapshotSentAtByArticle.set(aid, Date.now());
			          }
			        } catch {
			          // ignore
			        }
			        await removeOutboxOp(op.id);
		        try {
		          if (op.type === 'section_upsert_content' && String(op.articleId || '') === 'inbox') {
		            const sid = String(op.payload?.sectionId || '').trim();
		            if (sid) removePendingQuickNoteBySectionId(sid);
		          }
		        } catch {
		          // ignore
		        }
			        await maybeClearQueuedDocJsonAfterSuccessfulFlush(op);
	      } catch (err) {
        const status = Number(err?.status || 0) || null;
        const msg = status ? `${status}: ${err?.message || 'error'}` : err?.message || String(err || 'error');
        await markOutboxError(op.id, msg);

	        if (shouldDropOutboxOp(err, op)) {
	          // Permanent failure for this op (e.g. article removed): drop and continue.
          try {
            // eslint-disable-next-line no-console
            console.warn('[offline][outbox] drop op', {
              opId: op.id,
              type: op.type,
              articleId: op.articleId,
              status,
              message: err?.message || null,
            });
          } catch {
            // ignore
          }
		          try {
		            await removeOutboxOp(op.id);
		            // Do not clear queued docJson on dropped ops: data may not be on the server.
		          } catch {
		            // ignore
		          }
		          continue;
		        }

        // stop on retryable errors to avoid hammering the server
        if (isRetryableOutboxError(err)) break;
        // For unknown non-retryable errors: keep old behavior (stop).
        break;
      }
    }
  } finally {
    isFlushing = false;
  }
  // If anything is still queued, keep/enable the fast loop.
  try {
    const remaining = await listOutbox(1);
    return Array.isArray(remaining) && remaining.length > 0;
  } catch {
    return true;
  }
}

function startOutboxInterval() {
  if (outboxIntervalId) return;
  outboxIntervalId = window.setInterval(async () => {
    try {
      const hasMore = await flushOutboxOnce();
      if (hasMore === false) {
        window.clearInterval(outboxIntervalId);
        outboxIntervalId = null;
        pruneOutlineDocJsonQueueToInboxOnly();
      }
    } catch {
      // keep interval
    }
  }, 7000);
}

function stopOutboxInterval() {
  if (!outboxIntervalId) return;
  window.clearInterval(outboxIntervalId);
  outboxIntervalId = null;
}

export function startSyncLoop() {
  if (syncLoopStarted) return;
  syncLoopStarted = true;
  pruneOutlineDocJsonQueueToInboxOnly();
  // Media prefetch runs independently of outbox.
  try {
    startMediaPrefetchLoop();
  } catch {
    // ignore
  }
  window.addEventListener('online', () => {
    flushOutboxOnce()
      .then((hasMore) => {
        if (hasMore) startOutboxInterval();
        else stopOutboxInterval();
      })
      .catch(() => {});
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushOutboxOnce()
        .then((hasMore) => {
          if (hasMore) startOutboxInterval();
          else stopOutboxInterval();
        })
        .catch(() => {});
    }
  });
  // Start/stop fast flush loop based on actual outbox changes.
  window.addEventListener('offline-outbox-changed', () => {
    flushOutboxOnce()
      .then((hasMore) => {
        if (hasMore) startOutboxInterval();
        else stopOutboxInterval();
      })
      .catch(() => {
        startOutboxInterval();
      });
  });
  // On startup, check once if we already have pending ops.
  flushOutboxOnce()
    .then((hasMore) => {
      if (hasMore) startOutboxInterval();
    })
    .catch(() => {});
}

export function startBackgroundFullPull(options = {}) {
  const force = Boolean(options && options.force);
  if (fullPullRunning) return;
  if (fullPullStarted && !force) return;
  fullPullStarted = true;
  fullPullRunning = true;
  fullPullStatus = {
    running: true,
    processed: 0,
    total: 0,
    errors: 0,
    phase: 'index',
    lastError: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  emitFullPullStatus();
  // Best-effort: постепенно подтягиваем docJson всех статей, чтобы офлайн всегда работал.
  (async () => {
    try {
      if (!navigator.onLine) {
        fullPullStatus = {
          ...fullPullStatus,
          running: false,
          phase: 'error',
          lastError: 'offline',
          finishedAt: new Date().toISOString(),
        };
        emitFullPullStatus();
        return;
      }
      let localMetaById = new Map();
      try {
        const localMeta = await getCachedArticlesSyncMeta();
        localMetaById = new Map((localMeta || []).map((a) => [a.id, a]));
      } catch {
        // ignore (offline db может быть недоступна)
      }
      let index = [];
      try {
        if (Array.isArray(options?.initialIndex)) {
          index = options.initialIndex;
        } else {
          index = (await rawApiRequest('/api/articles')) || [];
        }
        cacheArticlesIndex(index).catch(() => {});
      } catch (err) {
        fullPullStatus = {
          ...fullPullStatus,
          running: false,
          phase: 'error',
          lastError: err?.message || String(err || 'error'),
          finishedAt: new Date().toISOString(),
        };
        emitFullPullStatus();
        return;
      }

      fullPullStatus = { ...fullPullStatus, phase: 'articles', total: Array.isArray(index) ? index.length : 0 };
      emitFullPullStatus();

      for (const row of index || []) {
        try {
          const serverUpdatedAt = row.updatedAt || null;
          const local = localMetaById.get(row.id);
          if (serverUpdatedAt && local?.updatedAt === serverUpdatedAt && local?.hasDocJson) {
            // Ensure media refs are indexed even if we skip pulling the article again.
            try {
              const cached = await getCachedArticle(row.id);
              const docJson = cached?.docJson && typeof cached.docJson === 'object' ? cached.docJson : null;
              if (docJson) {
                updateMediaRefsForArticle(row.id, docJson).catch(() => {});
              }
            } catch {
              // ignore
            }
            continue;
          }

          const article = await rawApiRequest(`/api/articles/${encodeURIComponent(row.id)}`);
          await cacheArticle(article);
          try {
            const emb = await rawApiRequest(`/api/articles/${encodeURIComponent(row.id)}/embeddings`);
            await upsertArticleEmbeddings(row.id, emb?.embeddings || []);
          } catch {
            // ignore embeddings pull
          }
        } catch {
          // ignore single-article failures
          fullPullStatus = { ...fullPullStatus, errors: Number(fullPullStatus.errors || 0) + 1 };
        }
        fullPullStatus = { ...fullPullStatus, processed: Number(fullPullStatus.processed || 0) + 1 };
        emitFullPullStatus();
        // small delay to avoid hammering server
        await new Promise((r) => setTimeout(r, 120));
      }
      // Best-effort cleanup for removed media refs.
      pruneUnusedMedia().catch(() => {});

      fullPullStatus = {
        ...fullPullStatus,
        running: false,
        phase: 'done',
        finishedAt: new Date().toISOString(),
      };
      emitFullPullStatus();
    } finally {
      fullPullRunning = false;
    }
  })().catch(() => {});
}
