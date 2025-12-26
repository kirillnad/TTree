import { getOfflineDbReady } from './index.js';
import { reqToPromise, txDone } from './idb.js';

let embeddingCache = null;
let embeddingCacheLoadedAt = 0;

function normalizeEmbedding(vec) {
  const arr = Array.isArray(vec) ? vec : [];
  const out = new Float32Array(arr.length);
  let sum = 0;
  for (let i = 0; i < arr.length; i += 1) {
    const v = Number(arr[i] || 0);
    out[i] = v;
    sum += v * v;
  }
  if (sum > 0) {
    const inv = 1 / Math.sqrt(sum);
    for (let i = 0; i < out.length; i += 1) out[i] *= inv;
  }
  return out;
}

export function invalidateEmbeddingsCache() {
  embeddingCache = null;
  embeddingCacheLoadedAt = 0;
}

export async function upsertArticleEmbeddings(articleId, embeddings) {
  if (!articleId) return;
  const db = await getOfflineDbReady();
  const items = Array.isArray(embeddings) ? embeddings : [];
  const tx = db.transaction(['section_embeddings'], 'readwrite');
  const store = tx.objectStore('section_embeddings');
  for (const item of items) {
    const sectionId = String(item?.blockId || item?.sectionId || '');
    const updatedAt = String(item?.updatedAt || '') || null;
    const vec = item?.embedding;
    if (!sectionId || !Array.isArray(vec) || !vec.length) continue;
    const normalized = normalizeEmbedding(vec);
    await reqToPromise(
      store.put({
        sectionId,
        articleId: String(articleId),
        updatedAt,
        vec: normalized,
      }),
    );
  }
  await txDone(tx);
  invalidateEmbeddingsCache();
}

export async function deleteSectionEmbeddings(sectionIds) {
  const ids = (sectionIds || []).map((x) => String(x || '')).filter(Boolean);
  if (!ids.length) return;
  const db = await getOfflineDbReady();
  const tx = db.transaction(['section_embeddings'], 'readwrite');
  const store = tx.objectStore('section_embeddings');
  for (const id of ids) {
    await reqToPromise(store.delete(id));
  }
  await txDone(tx);
  invalidateEmbeddingsCache();
}

export async function countLocalEmbeddings() {
  const db = await getOfflineDbReady();
  const tx = db.transaction(['section_embeddings'], 'readonly');
  const store = tx.objectStore('section_embeddings');
  const n = await reqToPromise(store.count());
  await txDone(tx);
  return Number(n || 0);
}

export async function loadEmbeddingsCache() {
  if (embeddingCache) return embeddingCache;
  const db = await getOfflineDbReady();
  const tx = db.transaction(['section_embeddings'], 'readonly');
  const store = tx.objectStore('section_embeddings');
  const rows = (await reqToPromise(store.getAll()).catch(() => [])) || [];
  await txDone(tx);

  const cache = [];
  for (const row of rows) {
    const sectionId = String(row?.sectionId || '');
    const articleId = String(row?.articleId || '');
    const raw = row?.vec;
    if (!sectionId || !articleId || !raw) continue;
    let vec = null;
    if (raw instanceof Float32Array) vec = raw;
    else if (raw instanceof ArrayBuffer) vec = new Float32Array(raw);
    else if (Array.isArray(raw)) vec = normalizeEmbedding(raw);
    if (!vec || !vec.length) continue;
    cache.push({ sectionId, articleId, vec });
  }
  embeddingCache = cache;
  embeddingCacheLoadedAt = Date.now();
  return cache;
}

export function dot(a, b) {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i += 1) s += a[i] * b[i];
  return s;
}
