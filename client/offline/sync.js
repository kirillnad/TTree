import {
  cacheArticle,
  cacheArticlesIndex,
  getCachedArticle,
  getCachedArticlesIndex,
  getCachedArticlesSyncMeta,
  updateCachedDocJson,
} from './cache.js';
import { listOutbox, markOutboxError, removeOutboxOp } from './outbox.js';
import { deleteSectionEmbeddings, upsertArticleEmbeddings } from './embeddings.js';
import { startMediaPrefetchLoop, pruneUnusedMedia, updateMediaRefsForArticle } from './media.js';

let syncLoopStarted = false;
let isFlushing = false;
let fullPullStarted = false;
let fullPullRunning = false;

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
    throw new Error(details.detail || 'Request failed');
  }
  if (response.status === 204) {
    return null;
  }
  return response.json();
}

export async function tryPullBootstrap() {
  try {
    const index = await rawApiRequest('/api/articles');
    await cacheArticlesIndex(index);
    return true;
  } catch {
    return false;
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
    // Keep index in sync (lightweight pull)
    try {
      const index = await rawApiRequest('/api/articles');
      await cacheArticlesIndex(index);
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

export async function flushOutboxOnce() {
  if (isFlushing) return;
  isFlushing = true;
  try {
    const ops = await listOutbox(50);
    for (const op of ops) {
      try {
        await flushOp(op);
        await removeOutboxOp(op.id);
        if (op.type !== 'save_doc_json') {
          try {
            const index = await rawApiRequest('/api/articles');
            await cacheArticlesIndex(index);
          } catch {
            // ignore
          }
        }
      } catch (err) {
        await markOutboxError(op.id, err?.message || String(err || 'error'));
        // stop on first error to avoid hammering the server
        break;
      }
    }
  } finally {
    isFlushing = false;
  }
}

export function startSyncLoop() {
  if (syncLoopStarted) return;
  syncLoopStarted = true;
  // Media prefetch runs independently of outbox.
  try {
    startMediaPrefetchLoop();
  } catch {
    // ignore
  }
  window.addEventListener('online', () => {
    flushOutboxOnce().catch(() => {});
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushOutboxOnce().catch(() => {});
    }
  });
  // periodic best-effort flush
  setInterval(() => {
    if (navigator.onLine) flushOutboxOnce().catch(() => {});
  }, 15000);
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
        index = (await rawApiRequest('/api/articles')) || [];
        await cacheArticlesIndex(index);
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
            // Ensure we at least have embeddings for semantic search.
            try {
              const emb = await rawApiRequest(
                `/api/articles/${encodeURIComponent(row.id)}/embeddings?since=${encodeURIComponent(serverUpdatedAt)}`,
              );
              await upsertArticleEmbeddings(row.id, emb?.embeddings || []);
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
