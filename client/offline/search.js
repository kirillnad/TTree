import { getOfflineDbReady } from './index.js';

function normalizeQuery(q) {
  return String(q || '').trim();
}

export async function localClassicSearch(query, { blockLimit = 30, articleLimit = 15 } = {}) {
  const q = normalizeQuery(query);
  if (!q) return [];
  const db = await getOfflineDbReady();
  const like = `%${q.toLowerCase()}%`;

  const articlesRes = await db.query(
    'SELECT id AS articleId, title AS articleTitle FROM articles WHERE deleted_at IS NULL AND LOWER(title) LIKE $1 ORDER BY updated_at DESC LIMIT $2',
    [like, articleLimit],
  );
  const articleResults = (articlesRes?.rows || []).map((row) => ({
    type: 'article',
    articleId: row.articleId,
    articleTitle: row.articleTitle || '',
    snippet: row.articleTitle || '',
  }));

  // If we haven't pulled doc_json yet, sections table may be empty.
  try {
    const countRes = await db.query('SELECT COUNT(1) AS c FROM outline_sections');
    const c = Number(countRes?.rows?.[0]?.c || 0);
    if (!c) {
      return navigator.onLine ? null : articleResults;
    }
  } catch {
    // ignore
  }

  let blockRows = [];
  const likeRes = await db.query(
    'SELECT s.section_id AS blockId, s.article_id AS articleId, a.title AS articleTitle, s.text AS blockText ' +
      'FROM outline_sections s ' +
      'JOIN articles a ON a.id = s.article_id ' +
      'WHERE LOWER(s.text) LIKE $1 ' +
      'ORDER BY s.updated_at DESC ' +
      'LIMIT $2',
    [like, blockLimit],
  );
  blockRows = likeRes?.rows || [];

  const blockResults = [];
  for (const row of blockRows) {
    const articleTitle = row.articleTitle || '';
    const blockText = row.blockText || '';
    blockResults.push({
      type: 'block',
      articleId: row.articleId,
      articleTitle,
      blockId: row.blockId,
      snippet: blockText.slice(0, 160),
      blockText,
    });
  }

  return [...articleResults, ...blockResults];
}
