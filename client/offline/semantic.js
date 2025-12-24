import { getOfflineDbReady } from './index.js';
import { countLocalEmbeddings, dot, loadEmbeddingsCache } from './embeddings.js';

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

async function fetchQueryEmbedding(query) {
  const q = String(query || '').trim();
  if (!q) return null;
  const res = await fetch(`/api/search/semantic/query-embedding?q=${encodeURIComponent(q)}`, {
    method: 'GET',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const details = await res.json().catch(() => ({}));
    throw new Error(details.detail || 'Embedding failed');
  }
  const data = await res.json().catch(() => null);
  const vec = data?.embedding;
  if (!Array.isArray(vec) || !vec.length) return null;
  return normalizeEmbedding(vec);
}

async function fetchBlocksBySectionIds(sectionIds) {
  const ids = (sectionIds || []).map((x) => String(x || '')).filter(Boolean);
  if (!ids.length) return [];
  const db = await getOfflineDbReady();
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
  const res = await db.query(
    'SELECT s.section_id AS blockId, s.article_id AS articleId, a.title AS articleTitle, s.text AS blockText ' +
      'FROM outline_sections s ' +
      'JOIN articles a ON a.id = s.article_id ' +
      `WHERE s.section_id IN (${placeholders})`,
    ids,
  );
  return (res?.rows || []).map((row) => ({
    blockId: row.blockId,
    articleId: row.articleId,
    articleTitle: row.articleTitle || '',
    blockText: row.blockText || '',
  }));
}

export async function localSemanticSearch(query, { limit = 30 } = {}) {
  const q = String(query || '').trim();
  if (!q) return null;
  if (!navigator.onLine) return null; // need server to compute query embedding

  const count = await countLocalEmbeddings().catch(() => 0);
  if (!count) return null;

  const qVec = await fetchQueryEmbedding(q);
  if (!qVec) return null;

  const embRows = await loadEmbeddingsCache();
  if (!embRows.length) return null;

  // Keep topK using simple array (K<=30).
  const k = Math.max(1, Math.min(Number(limit) || 30, 50));
  const top = [];
  for (const row of embRows) {
    const score = dot(qVec, row.vec);
    if (!Number.isFinite(score)) continue;
    if (top.length < k) {
      top.push({ sectionId: row.sectionId, score });
      if (top.length === k) top.sort((a, b) => a.score - b.score);
      continue;
    }
    if (score <= top[0].score) continue;
    top[0] = { sectionId: row.sectionId, score };
    top.sort((a, b) => a.score - b.score);
  }
  top.sort((a, b) => b.score - a.score);
  const ids = top.map((t) => t.sectionId);
  const blocks = await fetchBlocksBySectionIds(ids);
  const byId = new Map(blocks.map((b) => [b.blockId, b]));
  const results = [];
  for (const item of top) {
    const block = byId.get(item.sectionId);
    if (!block) continue;
    const text = block.blockText || '';
    results.push({
      type: 'block',
      articleId: block.articleId,
      articleTitle: block.articleTitle,
      blockId: block.blockId,
      snippet: text.slice(0, 160),
      blockText: text,
      score: item.score,
    });
  }
  return results;
}
