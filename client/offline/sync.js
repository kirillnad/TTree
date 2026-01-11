import {
  cacheArticle,
  cacheArticlesIndex,
  clearCachedArticleLocalDraft,
  getCachedArticle,
  getCachedArticlesIndex,
  getCachedArticlesSyncMeta,
  touchCachedArticleUpdatedAt,
  touchCachedArticleOutlineStructureRev,
  updateCachedDocJson,
} from './cache.js';
import { enqueueOp, listOutbox, markOutboxError, removeOutboxOp } from './outbox.js';
import { deleteSectionEmbeddings, upsertArticleEmbeddings } from './embeddings.js';
import { startMediaPrefetchLoop, pruneUnusedMedia, updateMediaRefsForArticle } from './media.js';
import { deleteOutlineSections, fetchArticlesIndex } from '../api.js';
import { removePendingQuickNoteBySectionId } from '../quickNotes/pending.js';
import { revertLog, docJsonHash } from '../debug/revertLog.js';

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

// Outline sync policy (Variant B): don't start sync more often than once per 2s per article.
const OUTLINE_FLUSH_MIN_INTERVAL_MS = 2000;
const lastOutlineFlushStartedAtByArticle = new Map();

// Avoid hammering the server with structure snapshots while the user is actively dragging/reordering.
// Snapshot ops are coalesced in the outbox, so it's safe to delay sending the latest one.
const STRUCTURE_SNAPSHOT_MIN_INTERVAL_MS = 3000;
const lastStructureSnapshotSentAtByArticle = new Map();

function applyOutlineStructureSnapshotToDocJson(docJson, nodes) {
  try {
    const root = docJson && typeof docJson === 'object' ? docJson : { type: 'doc', content: [] };
    const content = Array.isArray(root.content) ? root.content : [];

    const existingById = new Map();
    const walk = (items) => {
      if (!Array.isArray(items)) return;
      for (const item of items) {
        if (!item || typeof item !== 'object' || item.type !== 'outlineSection') continue;
        const sid = String(item?.attrs?.id || '').trim();
        if (sid) existingById.set(sid, item);
        const kids = Array.isArray(item.content) ? item.content : [];
        const childrenNode = kids.find((c) => c && typeof c === 'object' && c.type === 'outlineChildren') || null;
        if (childrenNode && Array.isArray(childrenNode.content)) walk(childrenNode.content);
      }
    };
    walk(content);

    const ensureSectionShape = (sec, sid) => {
      const s = sec && typeof sec === 'object' ? sec : { type: 'outlineSection', attrs: { id: sid, collapsed: false }, content: [] };
      s.type = 'outlineSection';
      const attrs = s.attrs && typeof s.attrs === 'object' ? s.attrs : {};
      attrs.id = sid;
      s.attrs = attrs;
      const kids = Array.isArray(s.content) ? s.content : [];
      const heading =
        kids.find((c) => c && typeof c === 'object' && c.type === 'outlineHeading') || { type: 'outlineHeading', content: [] };
      const body =
        kids.find((c) => c && typeof c === 'object' && c.type === 'outlineBody') || { type: 'outlineBody', content: [{ type: 'paragraph' }] };
      let children = kids.find((c) => c && typeof c === 'object' && c.type === 'outlineChildren') || { type: 'outlineChildren', content: [] };
      if (!Array.isArray(children.content)) children = { ...children, content: [] };
      s.content = [heading, body, children];
      return s;
    };

    const mentioned = new Set();
    const byParent = new Map();
    for (const row of Array.isArray(nodes) ? nodes : []) {
      const sid = String(row?.sectionId || '').trim();
      if (!sid) continue;
      const parentRaw = row?.parentId;
      const parentId = parentRaw != null && String(parentRaw).trim() ? String(parentRaw).trim() : null;
      const pos = Number.isFinite(Number(row?.position)) ? Number(row.position) : 0;
      const collapsed = Boolean(row?.collapsed);

      const sec = ensureSectionShape(existingById.get(sid), sid);
      sec.attrs = { ...(sec.attrs || {}), id: sid, collapsed };
      existingById.set(sid, sec);
      mentioned.add(sid);
      if (!byParent.has(parentId)) byParent.set(parentId, []);
      byParent.get(parentId).push({ pos, sid, sec });
    }

    for (const [parentId, list] of byParent.entries()) {
      list.sort((a, b) => (a.pos - b.pos) || String(a.sid).localeCompare(String(b.sid)));
      byParent.set(parentId, list);
    }

    for (const [sid, sec] of existingById.entries()) {
      const list = byParent.get(sid) || [];
      const children = list.map((x) => x.sec);
      try {
        if (!Array.isArray(sec.content)) sec.content = [];
        if (!sec.content[2] || sec.content[2].type !== 'outlineChildren') sec.content[2] = { type: 'outlineChildren', content: [] };
        sec.content[2].content = children;
      } catch {
        // ignore
      }
    }

    const rootList = (byParent.get(null) || []).map((x) => x.sec);
    for (const [sid, sec] of existingById.entries()) {
      if (mentioned.has(sid)) continue;
      rootList.push(sec);
    }
    root.type = 'doc';
    root.content = rootList;
    return root;
  } catch {
    return docJson;
  }
}

function applySectionUpsertToDocJson(docJson, sectionId, headingJson, bodyJson) {
  try {
    const sid = String(sectionId || '').trim();
    if (!sid) return docJson;
    const root = docJson && typeof docJson === 'object' ? docJson : { type: 'doc', content: [] };
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== 'object') continue;
      if (node.type === 'outlineSection' && String(node?.attrs?.id || '').trim() === sid) {
        const content = Array.isArray(node.content) ? node.content : [];
        const children = content.find((c) => c && typeof c === 'object' && c.type === 'outlineChildren') || { type: 'outlineChildren', content: [] };
        node.content = [headingJson, bodyJson, children];
        return root;
      }
      const c = node.content;
      if (Array.isArray(c)) {
        for (const child of c) stack.push(child);
      }
    }
    return root;
  } catch {
    return docJson;
  }
}

function isOutlineOp(op) {
  const t = op?.type || '';
  return t === 'section_upsert_content' || t === 'delete_sections' || t === 'structure_snapshot';
}

function seedSectionSeq(articleId, sectionId, seq) {
  try {
    const aid = String(articleId || '').trim();
    const sid = String(sectionId || '').trim();
    const n = Number(seq);
    if (!aid || !sid || !Number.isFinite(n) || n <= 0) return;
    const key = 'ttree_outline_section_seq_v1';
    const raw = window.localStorage.getItem(key) || '';
    const parsed = raw ? JSON.parse(raw) : {};
    const byArticle = parsed && typeof parsed === 'object' ? parsed : {};
    const row = (byArticle[aid] && typeof byArticle[aid] === 'object' ? byArticle[aid] : {}) || {};
    const current = Number(row[sid] || 0) || 0;
    if (current >= n) return;
    row[sid] = n;
    byArticle[aid] = row;
    window.localStorage.setItem(key, JSON.stringify(byArticle));
  } catch {
    // ignore
  }
}

function computeStructureNodesFromDocJson(docJson) {
  const nodes = [];
  const walkList = (list, parentId) => {
    if (!Array.isArray(list)) return;
    let position = 0;
    for (const item of list) {
      if (!item || typeof item !== 'object' || item.type !== 'outlineSection') continue;
      const sid = String(item?.attrs?.id || '').trim();
      if (!sid) continue;
      nodes.push({
        sectionId: sid,
        parentId: parentId || null,
        position,
        collapsed: Boolean(item?.attrs?.collapsed),
      });
      position += 1;
      const content = Array.isArray(item.content) ? item.content : [];
      const childrenNode = content.find((c) => c && typeof c === 'object' && c.type === 'outlineChildren') || null;
      const children = childrenNode && Array.isArray(childrenNode.content) ? childrenNode.content : [];
      walkList(children, sid);
    }
  };
  const root = docJson && typeof docJson === 'object' ? docJson : null;
  const rootList = root && Array.isArray(root.content) ? root.content : [];
  walkList(rootList, null);
  return nodes;
}

function prefixOutlineHeadingJson(headingJson, prefixText) {
  try {
    const h = headingJson && typeof headingJson === 'object' ? { ...headingJson } : null;
    if (!h || h.type !== 'outlineHeading') return headingJson;
    const prefix = String(prefixText || '');
    if (!prefix) return headingJson;
    const content = Array.isArray(h.content) ? [...h.content] : [];
    content.unshift({ type: 'text', text: prefix });
    h.content = content;
    return h;
  } catch {
    return headingJson;
  }
}

function insertOutlineSectionAfter(docJson, afterSectionId, newSectionNode) {
  const root = docJson && typeof docJson === 'object' ? docJson : { type: 'doc', content: [] };
  if (!Array.isArray(root.content)) root.content = [];
  const afterId = String(afterSectionId || '').trim();
  const insertIntoList = (list) => {
    for (let i = 0; i < list.length; i += 1) {
      const item = list[i];
      if (!item || typeof item !== 'object' || item.type !== 'outlineSection') continue;
      const sid = String(item?.attrs?.id || '').trim();
      if (afterId && sid === afterId) {
        list.splice(i + 1, 0, newSectionNode);
        return true;
      }
      const content = Array.isArray(item.content) ? item.content : [];
      const childrenNode = content.find((c) => c && typeof c === 'object' && c.type === 'outlineChildren') || null;
      if (childrenNode && Array.isArray(childrenNode.content) && insertIntoList(childrenNode.content)) {
        return true;
      }
    }
    return false;
  };
  const inserted = insertIntoList(root.content);
  if (!inserted) root.content.push(newSectionNode);
  return root;
}

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
    return (
      op?.type === 'save_doc_json' ||
      String(op?.type || '').startsWith('section_') ||
      op?.type === 'structure_snapshot' ||
      op?.type === 'delete_sections'
    );
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

function applyDeleteSectionsToDocJson(docJson, sectionIds) {
  try {
    const ids = new Set((Array.isArray(sectionIds) ? sectionIds : []).map((x) => String(x || '').trim()).filter(Boolean));
    if (!ids.size) return docJson;
    const root = docJson && typeof docJson === 'object' ? docJson : { type: 'doc', content: [] };
    const filterList = (items) => {
      if (!Array.isArray(items)) return [];
      const out = [];
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        if (item.type === 'outlineSection') {
          const sid = String(item?.attrs?.id || '').trim();
          if (sid && ids.has(sid)) continue;
          const content = Array.isArray(item.content) ? item.content : [];
          const children = content.find((c) => c && typeof c === 'object' && c.type === 'outlineChildren') || null;
          if (children && Array.isArray(children.content)) {
            children.content = filterList(children.content);
          }
        }
        out.push(item);
      }
      return out;
    };
    if (Array.isArray(root.content)) {
      root.content = filterList(root.content);
    } else {
      root.content = [];
    }
    root.type = root.type || 'doc';
    return root;
  } catch {
    return docJson;
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
      revertLog('sync.flush.save_doc_json.ok', {
        articleId: op.articleId,
        opId: op.id,
        updatedAt,
        docHash: docJsonHash(docJson),
      });
    } catch {
      // ignore
    }
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
      // Keep cached docJson consistent with updatedAt, otherwise offline-first may "trust" stale docJson on reload.
      if (result?.updatedAt) {
        const cached = await getCachedArticle(op.articleId).catch(() => null);
        const cachedDoc = cached?.docJson && typeof cached.docJson === 'object' ? cached.docJson : null;
        if (cachedDoc) {
          const nextDoc = applySectionUpsertToDocJson(cachedDoc, sectionId, headingJson, bodyJson);
          await updateCachedDocJson(op.articleId, nextDoc, result.updatedAt);
        } else {
          // No docJson to patch — don't update updatedAt alone (would pin a null/stale docJson as "fresh").
        }
      }
      try {
        revertLog('sync.flush.section_upsert_content.ok', {
          articleId: op.articleId,
          opId: op.id,
          sectionId,
          updatedAt: result?.updatedAt || null,
        });
      } catch {
        // ignore
      }
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
      // Keep cached docJson consistent with updatedAt, otherwise offline-first may "trust" stale docJson on reload.
      if (result?.updatedAt) {
        const cached = await getCachedArticle(op.articleId).catch(() => null);
        const cachedDoc = cached?.docJson && typeof cached.docJson === 'object' ? cached.docJson : null;
        if (cachedDoc) {
          const nextDoc = applyOutlineStructureSnapshotToDocJson(cachedDoc, nodes);
          await updateCachedDocJson(op.articleId, nextDoc, result.updatedAt);
        } else {
          // No docJson to patch — don't update updatedAt alone.
        }
      }
      try {
        revertLog('sync.flush.structure_snapshot.ok', {
          articleId: op.articleId,
          opId: op.id,
          updatedAt: result?.updatedAt || null,
          nodesCount: Array.isArray(nodes) ? nodes.length : null,
        });
      } catch {
        // ignore
      }
    } catch {
      // ignore
    }
    return;
  }

  if (op.type === 'delete_sections') {
    const sectionIds = Array.isArray(op.payload?.sectionIds) ? op.payload.sectionIds : [];
    if (!sectionIds.length) return;
    const result = await deleteOutlineSections(op.articleId, sectionIds, { opId: op.payload?.opId || op.id });
    try {
      const updatedAt = result?.updatedAt || null;
      const cached = await getCachedArticle(op.articleId).catch(() => null);
      const cachedDoc = cached?.docJson && typeof cached.docJson === 'object' ? cached.docJson : null;
      if (cachedDoc && updatedAt) {
        const nextDoc = applyDeleteSectionsToDocJson(cachedDoc, sectionIds);
        await updateCachedDocJson(op.articleId, nextDoc, updatedAt);
      }
      const removed = Array.isArray(result?.removedBlockIds) ? result.removedBlockIds : [];
      if (removed.length) await deleteSectionEmbeddings(removed);
      revertLog('sync.flush.delete_sections.ok', {
        articleId: op.articleId,
        opId: op.id,
        updatedAt: updatedAt || null,
        sectionIdsCount: sectionIds.length,
        removedCount: removed.length,
      });
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
      op.type === 'save_doc_json' ||
      op.type === 'section_upsert_content' ||
      op.type === 'structure_snapshot' ||
      op.type === 'delete_sections';
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

async function handleOutlineConflicts(articleId, conflicts) {
  const aid = String(articleId || '').trim();
  if (!aid) return;
  for (const c of conflicts || []) {
    try {
      const originalSectionId = String(c?.sectionId || '').trim();
      const headingJson = c?.headingJson || null;
      const bodyJson = c?.bodyJson || null;
      if (!originalSectionId || !headingJson || !bodyJson) continue;
      const newSectionId =
        globalThis.crypto?.randomUUID?.() || `conflict-${Date.now()}-${Math.random().toString(16).slice(2)}`;

      const cached = await getCachedArticle(aid).catch(() => null);
      const cachedDoc = cached?.docJson && typeof cached.docJson === 'object' ? cached.docJson : null;
      const nextHeading = prefixOutlineHeadingJson(headingJson, 'Конфликтная копия: ');
      const newSectionNode = {
        type: 'outlineSection',
        attrs: { id: newSectionId, collapsed: false, isConflictCopy: true },
        content: [
          nextHeading || { type: 'outlineHeading', content: [] },
          bodyJson || { type: 'outlineBody', content: [{ type: 'paragraph' }] },
          { type: 'outlineChildren', content: [] },
        ],
      };

      const patchedDoc = insertOutlineSectionAfter(
        cachedDoc || { type: 'doc', content: [] },
        originalSectionId,
        newSectionNode,
      );
      await updateCachedDocJson(aid, patchedDoc, cached?.updatedAt || null).catch(() => {});

      // Seed seq so the next edit doesn't accidentally use a stale seq.
      seedSectionSeq(aid, newSectionId, 1);

      const clientQueuedAt = Date.now();
      await enqueueOp('section_upsert_content', {
        articleId: aid,
        payload: { sectionId: newSectionId, headingJson: nextHeading, bodyJson, seq: 1, clientQueuedAt },
        coalesceKey: `content:${aid}:${newSectionId}`,
      }).catch(() => {});

      const nodes = computeStructureNodesFromDocJson(patchedDoc);
      if (nodes.length) {
        await enqueueOp('structure_snapshot', {
          articleId: aid,
          payload: { nodes, clientQueuedAt },
          coalesceKey: `structure:${aid}`,
        }).catch(() => {});
      }

      try {
        window.dispatchEvent(
          new CustomEvent('outline-sync-conflict', {
            detail: {
              articleId: aid,
              sectionId: originalSectionId,
              conflictCopySectionId: newSectionId,
            },
          }),
        );
      } catch {
        // ignore
      }
    } catch {
      // ignore per-conflict
    }
  }
}

async function flushOutlineArticleOps(articleId, ops) {
  const aid = String(articleId || '').trim();
  if (!aid) return;
  const now = Date.now();
  const last = Number(lastOutlineFlushStartedAtByArticle.get(aid) || 0) || 0;
  if (last && now - last < OUTLINE_FLUSH_MIN_INTERVAL_MS) return;
  lastOutlineFlushStartedAtByArticle.set(aid, now);

  const loadLatestOutlineOps = async () => {
    const latest = await listOutbox(200);
    const deleteOps = [];
    const upsertOps = [];
    const structureOps = [];
    for (const op of latest || []) {
      if (!op || String(op.articleId || '') !== aid) continue;
      if (op.type === 'delete_sections') deleteOps.push(op);
      else if (op.type === 'section_upsert_content') upsertOps.push(op);
      else if (op.type === 'structure_snapshot') structureOps.push(op);
    }
    return { deleteOps, upsertOps, structureOps };
  };

  // STRICT ordering requirement:
  // When flushing, ALWAYS send update (/sync/compact: delete+upsert) before structure (/structure/snapshot).
  // This prevents the server from applying a structure snapshot that references a section that hasn't been upserted yet.
  // We do at most 2 compact passes per flush to avoid an unbounded loop when user keeps typing.
  let passes = 0;
  let deleteOps = [];
  let upsertOps = [];
  let structureOps = [];
  try {
    ({ deleteOps, upsertOps, structureOps } = await loadLatestOutlineOps());
  } catch {
    // fallback to the snapshot passed in
    deleteOps = [];
    upsertOps = [];
    structureOps = [];
    for (const op of ops || []) {
      if (!op || String(op.articleId || '') !== aid) continue;
      if (op.type === 'delete_sections') deleteOps.push(op);
      else if (op.type === 'section_upsert_content') upsertOps.push(op);
      else if (op.type === 'structure_snapshot') structureOps.push(op);
    }
  }

  const deletedSectionIds = new Set();
  for (const op of deleteOps) {
    const sectionIds = Array.isArray(op.payload?.sectionIds) ? op.payload.sectionIds : [];
    for (const sid of sectionIds) {
      const s = String(sid || '').trim();
      if (s) deletedSectionIds.add(s);
    }
  }

  // If a section is deleted, drop any pending content upserts for it (delete wins).
  if (deletedSectionIds.size && upsertOps.length) {
    for (const op of upsertOps) {
      try {
        const sid = String(op.payload?.sectionId || '').trim();
        if (sid && deletedSectionIds.has(sid)) {
          await removeOutboxOp(op.id);
        }
      } catch {
        // ignore
      }
    }
  }

  const deletes = deleteOps
    .map((op) => {
      const sectionIds = Array.isArray(op.payload?.sectionIds) ? op.payload.sectionIds : [];
      return {
        opId: op.payload?.opId || op.id,
        sectionIds: sectionIds.filter(Boolean).map((x) => String(x)),
        _outboxId: op.id,
      };
    })
    .filter((d) => d.sectionIds.length);

  const upserts = upsertOps
    .map((op) => {
      const sid = String(op.payload?.sectionId || '').trim();
      if (!sid) return null;
      if (deletedSectionIds.has(sid)) return null;
      return {
        opId: op.payload?.opId || op.id,
        sectionId: sid,
        headingJson: op.payload?.headingJson || null,
        bodyJson: op.payload?.bodyJson || null,
        seq: op.payload?.seq || null,
        clientQueuedAt: op.payload?.clientQueuedAt ?? null,
        _outboxId: op.id,
      };
    })
    .filter(Boolean);

  const sendCompactOnce = async () => {
    const deletes = deleteOps
      .map((op) => {
        const sectionIds = Array.isArray(op.payload?.sectionIds) ? op.payload.sectionIds : [];
        return {
          opId: op.payload?.opId || op.id,
          sectionIds: sectionIds.filter(Boolean).map((x) => String(x)),
          _outboxId: op.id,
        };
      })
      .filter((d) => d.sectionIds.length);

    const upserts = upsertOps
      .map((op) => {
        const sid = String(op.payload?.sectionId || '').trim();
        if (!sid) return null;
        if (deletedSectionIds.has(sid)) return null;
        return {
          opId: op.payload?.opId || op.id,
          sectionId: sid,
          headingJson: op.payload?.headingJson || null,
          bodyJson: op.payload?.bodyJson || null,
          seq: op.payload?.seq || null,
          clientQueuedAt: op.payload?.clientQueuedAt ?? null,
          _outboxId: op.id,
        };
      })
      .filter(Boolean);

    const outboxIdByOpId = new Map();
    for (const d of deletes) outboxIdByOpId.set(String(d.opId), d._outboxId);
    for (const u of upserts) outboxIdByOpId.set(String(u.opId), u._outboxId);

    if (!deletes.length && !upserts.length) return false;

    try {
      revertLog('sync.flush.outline_compact.start', {
        articleId: aid,
        deletesCount: deletes.length,
        upsertsCount: upserts.length,
      });
    } catch {
      // ignore
    }
    const result = await rawApiRequest(`/api/articles/${encodeURIComponent(aid)}/sync/compact`, {
      method: 'PUT',
      body: JSON.stringify({
        deletes: deletes.map(({ opId, sectionIds }) => ({ opId, sectionIds })),
        upserts: upserts.map(({ opId, sectionId, headingJson, bodyJson, seq }) => ({
          opId,
          sectionId,
          headingJson,
          bodyJson,
          seq,
        })),
      }),
    });

    const updatedAt = result?.updatedAt || null;
    if (updatedAt) await touchCachedArticleUpdatedAt(aid, updatedAt).catch(() => {});
    try {
      revertLog('sync.flush.outline_compact.ok', {
        articleId: aid,
        updatedAt: updatedAt || null,
        deleteAcks: Array.isArray(result?.deleteAcks) ? result.deleteAcks.length : null,
        upsertAcks: Array.isArray(result?.upsertAcks) ? result.upsertAcks.length : null,
      });
    } catch {
      // ignore
    }

    // Deletes acks
    const deleteAcks = Array.isArray(result?.deleteAcks) ? result.deleteAcks : [];
    for (const ack of deleteAcks) {
      const opId = String(ack?.opId || '').trim();
      if (!opId) continue;
      const outboxId = outboxIdByOpId.get(opId) || opId;
      await removeOutboxOp(outboxId).catch(() => {});
      // Embeddings cleanup is best-effort.
      try {
        const removed = Array.isArray(ack?.removedBlockIds) ? ack.removedBlockIds : [];
        if (removed.length) await deleteSectionEmbeddings(removed);
      } catch {
        // ignore
      }
    }

    // Upserts acks
    const conflicts = [];
    const upsertAcks = Array.isArray(result?.upsertAcks) ? result.upsertAcks : [];
    for (const ack of upsertAcks) {
      const opId = String(ack?.opId || '').trim();
      const sectionId = String(ack?.sectionId || '').trim();
      if (!opId || !sectionId) continue;
      const outboxId = outboxIdByOpId.get(opId) || opId;
      const res = String(ack?.result || '').trim();
      if (res === 'ok' || res === 'duplicate') {
        await removeOutboxOp(outboxId).catch(() => {});
      } else if (res === 'conflict') {
        // Drop the op (it won't apply) and keep changes via conflict copy.
        await removeOutboxOp(outboxId).catch(() => {});
        const originalOp = upserts.find((u) => String(u.opId) === opId) || null;
        if (originalOp) {
          conflicts.push({ sectionId, headingJson: originalOp.headingJson, bodyJson: originalOp.bodyJson });
        }
      }
    }
    if (conflicts.length) {
      await handleOutlineConflicts(aid, conflicts);
    }
    return true;
  };

  while (passes < 2) {
    passes += 1;
    // Compact must always be flushed before any structure snapshot.
    const did = await sendCompactOnce();
    if (!did) break;
    try {
      ({ deleteOps, upsertOps, structureOps } = await loadLatestOutlineOps());
    } catch {
      break;
    }
  }

  // Structure snapshot: send at most one coalesced op.
  // After compact pass(es), we intentionally re-check outbox. If new delete/upsert arrived, we MUST NOT
  // send structure first; it will wait until next flush.
  let structureOp = null;
  try {
    ({ deleteOps, upsertOps, structureOps } = await loadLatestOutlineOps());
  } catch {
    // ignore
  }
  if (!deleteOps.length && !upsertOps.length) {
    structureOp = structureOps.length ? structureOps[structureOps.length - 1] : null;
  }
  if (structureOp) {
    try {
      const lastSent = Number(lastStructureSnapshotSentAtByArticle.get(aid) || 0) || 0;
      const now2 = Date.now();
      if (lastSent && now2 - lastSent < STRUCTURE_SNAPSHOT_MIN_INTERVAL_MS) {
        // Keep the op in outbox; we'll send it on the next flush.
        return;
      }
    } catch {
      // ignore
    }

    const nodes = structureOp.payload?.nodes || null;
    if (Array.isArray(nodes) && nodes.length) {
      const cached = await getCachedArticle(aid).catch(() => null);
      let baseStructureRev = null;
      try {
        if (cached && Object.prototype.hasOwnProperty.call(cached, 'outlineStructureRev')) {
          const n = Number(cached.outlineStructureRev);
          if (Number.isFinite(n) && n >= 0) baseStructureRev = n;
        }
      } catch {
        baseStructureRev = null;
      }
      try {
        revertLog('sync.flush.structure_snapshot.start', {
          articleId: aid,
          opId: structureOp.id,
          baseStructureRev,
          nodesCount: nodes.length,
        });
      } catch {
        // ignore
      }
      const res = await rawApiRequest(`/api/articles/${encodeURIComponent(aid)}/structure/snapshot`, {
        method: 'PUT',
        body: JSON.stringify({
          opId: structureOp.payload?.opId || structureOp.id,
          nodes,
          ...(baseStructureRev != null ? { baseStructureRev } : {}),
        }),
      });
      const updatedAt = res?.updatedAt || null;
      if (updatedAt) await touchCachedArticleUpdatedAt(aid, updatedAt).catch(() => {});
      if (Number.isFinite(Number(res?.newStructureRev))) {
        await touchCachedArticleOutlineStructureRev(aid, Number(res.newStructureRev));
      } else if (Number.isFinite(Number(res?.currentStructureRev))) {
        await touchCachedArticleOutlineStructureRev(aid, Number(res.currentStructureRev));
      }
      try {
        revertLog('sync.flush.structure_snapshot.done', {
          articleId: aid,
          opId: structureOp.id,
          status: String(res?.status || ''),
          updatedAt: updatedAt || null,
          newStructureRev: Number.isFinite(Number(res?.newStructureRev)) ? Number(res.newStructureRev) : null,
          currentStructureRev: Number.isFinite(Number(res?.currentStructureRev)) ? Number(res.currentStructureRev) : null,
        });
      } catch {
        // ignore
      }
      const status = String(res?.status || '');
      if (status === 'ok' || status === 'duplicate') {
        await removeOutboxOp(structureOp.id).catch(() => {});
        try {
          lastStructureSnapshotSentAtByArticle.set(aid, Date.now());
        } catch {
          // ignore
        }
      }
    }
  }

  // If we have no more pending outline ops, allow server fetches to overwrite cache again.
  try {
    const remaining = await listOutbox(200);
    const stillHasOutline = (remaining || []).some((o) => isOutlineOp(o) && String(o.articleId || '') === aid);
    if (!stillHasOutline) {
      await clearCachedArticleLocalDraft(aid).catch(() => {});
      revertLog('sync.flush.localDraft.cleared', { articleId: aid });
    }
  } catch {
    // ignore
  }
}

export async function flushOutboxOnce() {
  if (isFlushing) return null;
  if (!navigator.onLine) return false;
  isFlushing = true;
  try {
    const ops = await listOutbox(200);

    // 1) Outline: flush per-article using the two fixed requests (update → structure).
    const seen = new Set();
    const articleIds = [];
    for (const op of ops || []) {
      if (!isOutlineOp(op)) continue;
      const aid = String(op.articleId || '').trim();
      if (!aid || seen.has(aid)) continue;
      seen.add(aid);
      articleIds.push(aid);
    }
    for (const aid of articleIds) {
      try {
        await flushOutlineArticleOps(aid, ops);
      } catch (err) {
        // Stop early on network/server errors; retry on next tick.
        if (isRetryableOutboxError(err)) break;
      }
    }

    // 2) Other ops: keep legacy per-op flushing.
    const remaining = await listOutbox(50);
    for (const op of remaining) {
      if (isOutlineOp(op)) continue;
      try {
        await flushOp(op);
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
          } catch {
            // ignore
          }
          continue;
        }

        // stop on retryable errors to avoid hammering the server
        if (isRetryableOutboxError(err)) break;
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
  }, 15000);
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
