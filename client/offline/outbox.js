import { getOfflineDbReady } from './index.js';
import { reqToPromise, txDone } from './idb.js';

function emitOutboxChanged() {
  try {
    window.dispatchEvent(new CustomEvent('offline-outbox-changed'));
  } catch {
    // ignore
  }
}

function uuid() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  // fallback (not cryptographically strong, but ok for offline ids)
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function nowIso() {
  return new Date().toISOString();
}

export async function enqueueOp(type, { articleId, payload, coalesceKey } = {}) {
  const db = await getOfflineDbReady();
  const opId = uuid();
  const createdAt = nowIso();
  const payloadJson = payload ? JSON.stringify(payload) : '{}';

  const tx = db.transaction(['outbox'], 'readwrite');
  const store = tx.objectStore('outbox');
  const byTypeArticleId = store.index('byTypeArticleId');
  const byTypeCoalesceKey = store.index('byTypeCoalesceKey');
  if (coalesceKey) {
    const key = [String(type || ''), String(coalesceKey || '')];
    let cursor = await reqToPromise(byTypeCoalesceKey.openCursor(IDBKeyRange.only(key))).catch(() => null);
    while (cursor) {
      cursor.delete();
      cursor = await reqToPromise(cursor.continue()).catch(() => null);
    }
  } else if (articleId) {
    // Backward-compatible coarse coalescing by (type, articleId).
    const key = [String(type || ''), articleId || null];
    let cursor = await reqToPromise(byTypeArticleId.openCursor(IDBKeyRange.only(key))).catch(() => null);
    while (cursor) {
      cursor.delete();
      cursor = await reqToPromise(cursor.continue()).catch(() => null);
    }
  }

  await reqToPromise(
    store.put({
      id: opId,
      createdAt,
      createdAtMs: Date.now(),
      type: String(type || ''),
      articleId: articleId || null,
      coalesceKey: coalesceKey ? String(coalesceKey) : null,
      payloadJson,
      attempts: 0,
      lastError: null,
      lastAttemptAt: null,
    }),
  );
  await txDone(tx);
  emitOutboxChanged();
  return opId;
}

export async function listOutbox(limit = 50) {
  const db = await getOfflineDbReady();
  const tx = db.transaction(['outbox'], 'readonly');
  const store = tx.objectStore('outbox');
  const idx = store.index('byCreatedAtMs');
  const out = [];
  let cursor = await reqToPromise(idx.openCursor()).catch(() => null);
  while (cursor) {
    out.push(cursor.value);
    if (out.length >= limit) break;
    cursor = await reqToPromise(cursor.continue()).catch(() => null);
  }
  await txDone(tx);

  return out.map((row) => {
    let payload = {};
    try {
      payload = JSON.parse(row?.payloadJson || '{}');
    } catch {
      payload = {};
    }
    return {
      id: row.id,
      createdAt: row.createdAt,
      type: row.type,
      articleId: row.articleId,
      payload,
      attempts: row.attempts || 0,
    };
  });
}

export async function hasPendingOpsByTypeAndArticleId(types = [], articleId = null) {
  const aid = String(articleId || '').trim();
  const wanted = Array.isArray(types) ? types.map((t) => String(t || '').trim()).filter(Boolean) : [];
  if (!aid || !wanted.length) return false;
  const db = await getOfflineDbReady();
  const tx = db.transaction(['outbox'], 'readonly');
  const store = tx.objectStore('outbox');
  const byTypeArticleId = store.index('byTypeArticleId');
  for (const type of wanted) {
    try {
      const key = [String(type), aid];
      const cursor = await reqToPromise(byTypeArticleId.openCursor(IDBKeyRange.only(key))).catch(() => null);
      if (cursor) {
        await txDone(tx);
        return true;
      }
    } catch {
      // ignore per-type
    }
  }
  await txDone(tx);
  return false;
}

export async function hasPendingOutlineOps(articleId) {
  // Variant B: outline sync uses only these op types.
  return hasPendingOpsByTypeAndArticleId(
    ['delete_sections', 'section_upsert_content', 'structure_snapshot', 'save_doc_json'],
    articleId,
  );
}

export async function countOutbox() {
  const db = await getOfflineDbReady();
  const tx = db.transaction(['outbox'], 'readonly');
  const store = tx.objectStore('outbox');
  const n = await reqToPromise(store.count()).catch(() => 0);
  await txDone(tx);
  return Number(n || 0) || 0;
}

export async function markOutboxError(opId, message) {
  const db = await getOfflineDbReady();
  const tx = db.transaction(['outbox'], 'readwrite');
  const store = tx.objectStore('outbox');
  const existing = await reqToPromise(store.get(opId)).catch(() => null);
  if (existing) {
    await reqToPromise(
      store.put({
        ...existing,
        attempts: Number(existing.attempts || 0) + 1,
        lastError: String(message || 'error'),
        lastAttemptAt: nowIso(),
      }),
    );
  }
  await txDone(tx);
  emitOutboxChanged();
}

export async function removeOutboxOp(opId) {
  const db = await getOfflineDbReady();
  const tx = db.transaction(['outbox'], 'readwrite');
  const store = tx.objectStore('outbox');
  await reqToPromise(store.delete(opId));
  await txDone(tx);
  emitOutboxChanged();
}
