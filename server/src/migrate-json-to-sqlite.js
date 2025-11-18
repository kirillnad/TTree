const fs = require('fs');
const path = require('path');
const { v4: uuid } = require('uuid');
const db = require('./db');
const initSchema = require('./schema');
const {
  sanitizeContent,
  stripHtml,
  buildLemma,
  buildNormalizedTokens,
} = require('./text-utils');

initSchema();

const JSON_PATH = path.join(__dirname, '..', 'data', 'articles.json');

function readSourceData() {
  if (!fs.existsSync(JSON_PATH)) {
    return null;
  }
  const raw = fs.readFileSync(JSON_PATH, 'utf-8');
  if (!raw.trim()) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    console.error('Не удалось разобрать JSON статьи:', error.message);
    return null;
  }
}

function normalizeBlocks(blocks = []) {
  return (blocks || []).map((block) => ({
    id: block.id || uuid(),
    text: sanitizeContent(block.text || ''),
    collapsed: Boolean(block.collapsed),
    children: normalizeBlocks(block.children),
  }));
}

const insertArticleStmt = db.prepare(
  `
    INSERT INTO articles (id, title, created_at, updated_at, history, redo_history)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
);
const insertBlockStmt = db.prepare(
  `
    INSERT INTO blocks (id, article_id, parent_id, position, text, normalized_text, collapsed, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
);
const deleteBlocksStmt = db.prepare('DELETE FROM blocks WHERE article_id = ?');
const deleteBlocksFtsStmt = db.prepare('DELETE FROM blocks_fts WHERE article_id = ?');
const insertBlockFtsStmt = db.prepare(
  `
    INSERT OR REPLACE INTO blocks_fts (block_rowid, article_id, text, lemma, normalized_text)
    VALUES (?, ?, ?, ?, ?)
  `,
);

function insertBlocksRecursive(articleId, blocks, timestamp, parentId = null) {
  blocks.forEach((block, index) => {
    const plainText = stripHtml(block.text || '');
    const lemma = buildLemma(plainText);
    const normalizedTokens = buildNormalizedTokens(plainText);
    const result = insertBlockStmt.run(
      block.id,
      articleId,
      parentId,
      index,
      block.text || '',
      normalizedTokens,
      block.collapsed ? 1 : 0,
      timestamp,
      timestamp,
    );
    const blockRowId = result.lastInsertRowid;
    insertBlockFtsStmt.run(blockRowId, articleId, block.text || '', lemma, normalizedTokens);
    if (block.children && block.children.length > 0) {
      insertBlocksRecursive(articleId, block.children, timestamp, block.id);
    }
  });
}

function migrate() {
  const data = readSourceData();
  if (!data || !Array.isArray(data.articles) || !data.articles.length) {
    console.log('Нет данных для миграции из JSON.');
    return;
  }
  const articleCount = db.prepare('SELECT COUNT(1) AS count FROM articles').get()?.count ?? 0;
  if (articleCount > 0) {
    console.log(`SQLite содержит ${articleCount} статей — данные будут перезаписаны.`);
  }
  db.prepare('DELETE FROM blocks_fts').run();
  db.prepare('DELETE FROM blocks').run();
  db.prepare('DELETE FROM articles').run();
  const transaction = db.transaction(() => {
    data.articles.forEach((article) => {
      const articleId = article.id || uuid();
      const createdAt = article.createdAt || article.updatedAt || new Date().toISOString();
      const updatedAt = article.updatedAt || createdAt;
      insertArticleStmt.run(
        articleId,
        article.title || 'Новая статья',
        createdAt,
        updatedAt,
        JSON.stringify(article.history || []),
        JSON.stringify(article.redoHistory || []),
      );
      deleteBlocksStmt.run(articleId);
      deleteBlocksFtsStmt.run(articleId);
      const normalizedBlocks = normalizeBlocks(article.blocks);
      insertBlocksRecursive(articleId, normalizedBlocks, updatedAt);
    });
  });
  transaction();
  console.log(`Мигрировано ${data.articles.length} статей в SQLite.`);
}

if (require.main === module) {
  migrate();
}
