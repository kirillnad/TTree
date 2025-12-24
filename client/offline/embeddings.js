import { getOfflineDbReady } from './index.js';

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
  await db.query('BEGIN');
  try {
    for (const item of items) {
      const sectionId = String(item?.blockId || item?.sectionId || '');
      const updatedAt = String(item?.updatedAt || '') || null;
      const vec = item?.embedding;
      if (!sectionId || !Array.isArray(vec) || !vec.length) continue;
      await db.query(
        'INSERT INTO section_embeddings (section_id, article_id, embedding_json, updated_at) VALUES ($1, $2, $3, $4) ' +
          'ON CONFLICT (section_id) DO UPDATE SET article_id = EXCLUDED.article_id, embedding_json = EXCLUDED.embedding_json, updated_at = EXCLUDED.updated_at',
        [sectionId, articleId, JSON.stringify(vec), updatedAt],
      );
    }
    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
  invalidateEmbeddingsCache();
}

export async function deleteSectionEmbeddings(sectionIds) {
  const ids = (sectionIds || []).map((x) => String(x || '')).filter(Boolean);
  if (!ids.length) return;
  const db = await getOfflineDbReady();
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
  await db.query(`DELETE FROM section_embeddings WHERE section_id IN (${placeholders})`, ids);
  invalidateEmbeddingsCache();
}

export async function countLocalEmbeddings() {
  const db = await getOfflineDbReady();
  const res = await db.query('SELECT COUNT(1) AS c FROM section_embeddings');
  return Number(res?.rows?.[0]?.c || 0);
}

export async function loadEmbeddingsCache() {
  if (embeddingCache) return embeddingCache;
  const db = await getOfflineDbReady();
  const res = await db.query('SELECT section_id AS sectionId, article_id AS articleId, embedding_json AS emb FROM section_embeddings');
  const cache = [];
  for (const row of res?.rows || []) {
    let vec = null;
    try {
      vec = JSON.parse(row.emb || 'null');
    } catch {
      vec = null;
    }
    if (!Array.isArray(vec) || !vec.length) continue;
    cache.push({
      sectionId: row.sectionId,
      articleId: row.articleId,
      vec: normalizeEmbedding(vec),
    });
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
