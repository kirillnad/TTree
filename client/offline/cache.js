import { getOfflineDbReady } from './index.js';
import { reindexOutlineSections } from './indexer.js';
import { updateMediaRefsForArticle } from './media.js';

function pickArticleIndexRow(article) {
  return {
    id: article.id,
    title: article.title,
    updatedAt: article.updatedAt,
    parentId: article.parentId ?? null,
    position: typeof article.position === 'number' ? article.position : 0,
    publicSlug: article.publicSlug ?? null,
    encrypted: !!article.encrypted,
  };
}

export async function cacheArticlesIndex(indexRows) {
  const db = await getOfflineDbReady();
  const rows = Array.isArray(indexRows) ? indexRows : [];
  await db.query('BEGIN');
  try {
    for (const article of rows) {
      const row = pickArticleIndexRow(article);
      await db.query(
        'INSERT INTO articles (id, title, updated_at, parent_id, position, public_slug, encrypted, deleted_at) ' +
          'VALUES ($1, $2, $3, $4, $5, $6, $7, NULL) ' +
          'ON CONFLICT (id) DO UPDATE SET ' +
          'title = EXCLUDED.title, ' +
          'updated_at = EXCLUDED.updated_at, ' +
          'parent_id = EXCLUDED.parent_id, ' +
          'position = EXCLUDED.position, ' +
          'public_slug = EXCLUDED.public_slug, ' +
          'encrypted = EXCLUDED.encrypted, ' +
          'deleted_at = NULL',
        [
          row.id,
          row.title || '',
          row.updatedAt || null,
          row.parentId,
          row.position || 0,
          row.publicSlug,
          row.encrypted ? 1 : 0,
        ],
      );
    }
    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}

export async function getCachedArticlesIndex() {
  const db = await getOfflineDbReady();
  const result = await db.query(
    'SELECT id, title, updated_at, parent_id, position, public_slug, encrypted FROM articles WHERE deleted_at IS NULL ORDER BY position ASC',
  );
  const rows = result?.rows || [];
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    updatedAt: row.updated_at,
    parentId: row.parent_id ?? null,
    position: row.position ?? 0,
    publicSlug: row.public_slug ?? null,
    encrypted: !!row.encrypted,
  }));
}

export async function getCachedArticlesSyncMeta() {
  const db = await getOfflineDbReady();
  const result = await db.query(
    'SELECT id, updated_at, (doc_json IS NOT NULL) AS has_doc_json FROM articles WHERE deleted_at IS NULL',
  );
  const rows = result?.rows || [];
  return rows.map((row) => ({
    id: row.id,
    updatedAt: row.updated_at || null,
    hasDocJson: !!row.has_doc_json,
  }));
}

export async function cacheArticle(article) {
  if (!article || !article.id) return;
  const db = await getOfflineDbReady();
  const docJson = article.docJson && typeof article.docJson === 'object' ? article.docJson : null;
  const updatedAt = article.updatedAt || null;
  await db.query(
    'INSERT INTO articles (id, title, updated_at, parent_id, position, public_slug, encrypted, deleted_at, doc_json, article_json) ' +
      'VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8, $9) ' +
      'ON CONFLICT (id) DO UPDATE SET ' +
      'title = EXCLUDED.title, ' +
      'updated_at = EXCLUDED.updated_at, ' +
      'parent_id = EXCLUDED.parent_id, ' +
      'position = EXCLUDED.position, ' +
      'public_slug = EXCLUDED.public_slug, ' +
      'encrypted = EXCLUDED.encrypted, ' +
      'deleted_at = NULL, ' +
      'doc_json = EXCLUDED.doc_json, ' +
      'article_json = EXCLUDED.article_json',
    [
      article.id,
      article.title || '',
      updatedAt,
      article.parentId ?? null,
      typeof article.position === 'number' ? article.position : 0,
      article.publicSlug ?? null,
      article.encrypted ? 1 : 0,
      docJson ? JSON.stringify(docJson) : null,
      JSON.stringify(article),
    ],
  );
  if (docJson) {
    reindexOutlineSections(db, { articleId: article.id, docJson, updatedAt }).catch(() => {});
    updateMediaRefsForArticle(article.id, docJson).catch(() => {});
  }
}

export async function getCachedArticle(articleId) {
  if (!articleId) return null;
  const db = await getOfflineDbReady();
  const result = await db.query('SELECT article_json, doc_json FROM articles WHERE id = $1', [articleId]);
  const row = result?.rows?.[0];
  if (!row) return null;
  try {
    const article = JSON.parse(row.article_json || 'null');
    if (article && !article.docJson && row.doc_json) {
      article.docJson = JSON.parse(row.doc_json);
    }
    return article;
  } catch {
    return null;
  }
}

export async function updateCachedDocJson(articleId, docJson, updatedAt) {
  if (!articleId) return;
  const db = await getOfflineDbReady();
  await db.query('UPDATE articles SET doc_json = $1, updated_at = $2 WHERE id = $3', [
    docJson ? JSON.stringify(docJson) : null,
    updatedAt || null,
    articleId,
  ]);
  if (docJson && typeof docJson === 'object') {
    reindexOutlineSections(db, { articleId, docJson, updatedAt }).catch(() => {});
    updateMediaRefsForArticle(articleId, docJson).catch(() => {});
  }
}

export async function updateCachedArticleTreePositions(changes) {
  const db = await getOfflineDbReady();
  const rows = Array.isArray(changes) ? changes : [];
  if (!rows.length) return;
  await db.query('BEGIN');
  try {
    for (const c of rows) {
      if (!c || !c.id) continue;
      await db.query('UPDATE articles SET parent_id = $1, position = $2 WHERE id = $3', [
        c.parentId ?? null,
        typeof c.position === 'number' ? c.position : 0,
        c.id,
      ]);
    }
    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}
