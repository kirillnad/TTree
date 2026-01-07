import { state } from '../state.js';
import { getOfflineDb } from './storage.js';
import { reqToPromise, txDone } from './idb.js';

function userKeyFromState() {
  const u = state?.currentUser || null;
  return (u && (u.id || u.username)) || 'anon';
}

async function getDb() {
  return getOfflineDb({ userKey: userKeyFromState() });
}

export async function putPendingUpload(payload = {}) {
  const token = String(payload?.token || '').trim();
  const articleId = String(payload?.articleId || '').trim();
  if (!token || !articleId) return false;

  const kind = String(payload?.kind || 'image');
  const blob = payload?.blob || null;
  const mime = String(payload?.mime || (blob && blob.type) || '').trim();
  const fileName = String(payload?.fileName || '').trim() || null;
  const now = Date.now();

  const db = await getDb();
  const tx = db.transaction(['pending_uploads'], 'readwrite');
  const store = tx.objectStore('pending_uploads');
  const existing = await reqToPromise(store.get(token)).catch(() => null);
  const createdAtMs = Number(existing?.createdAtMs || payload?.createdAtMs || now) || now;
  const row = {
    token,
    articleId,
    kind,
    blob,
    mime,
    fileName,
    status: String(payload?.status || existing?.status || 'pending'),
    errorMessage: String(payload?.errorMessage || existing?.errorMessage || ''),
    createdAtMs,
    updatedAtMs: now,
  };
  await reqToPromise(store.put(row));
  await txDone(tx);
  return true;
}

export async function deletePendingUpload(token) {
  const t = String(token || '').trim();
  if (!t) return false;
  const db = await getDb();
  const tx = db.transaction(['pending_uploads'], 'readwrite');
  const store = tx.objectStore('pending_uploads');
  await reqToPromise(store.delete(t));
  await txDone(tx);
  return true;
}

export async function markPendingUploadError(token, message) {
  const t = String(token || '').trim();
  if (!t) return false;
  const db = await getDb();
  const tx = db.transaction(['pending_uploads'], 'readwrite');
  const store = tx.objectStore('pending_uploads');
  const row = await reqToPromise(store.get(t)).catch(() => null);
  if (!row) {
    await txDone(tx);
    return false;
  }
  row.status = 'error';
  row.errorMessage = String(message || 'error');
  row.updatedAtMs = Date.now();
  await reqToPromise(store.put(row));
  await txDone(tx);
  return true;
}

export async function listPendingUploads({ articleId = null, limit = 50 } = {}) {
  const db = await getDb();
  const tx = db.transaction(['pending_uploads'], 'readonly');
  const store = tx.objectStore('pending_uploads');
  let rows = [];
  try {
    const n = Number(limit || 0) || 0;
    if (articleId) {
      const idx = store.index('byArticleId');
      // getAll(query, count) is supported by modern browsers.
      rows = await reqToPromise(idx.getAll(String(articleId), n > 0 ? n : undefined));
    } else {
      rows = await reqToPromise(store.getAll(n > 0 ? n : undefined));
    }
  } catch {
    rows = [];
  }
  await txDone(tx);
  if (!Array.isArray(rows)) return [];
  rows.sort((a, b) => Number(a?.createdAtMs || 0) - Number(b?.createdAtMs || 0));
  return rows;
}

