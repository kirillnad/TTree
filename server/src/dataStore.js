const { v4: uuid } = require('uuid');
const sanitizeHtml = require('sanitize-html');
const db = require('./db');
const initSchema = require('./schema');
const {
  sanitizeContent,
  stripHtml,
  buildLemma,
  buildLemmaTokens,
  buildNormalizedTokens,
} = require('./text-utils');

initSchema();

const DEFAULT_BLOCK_TEXT = sanitizeContent('Новый блок');


function createDefaultBlock() {
  return {
    id: uuid(),
    text: DEFAULT_BLOCK_TEXT,
    collapsed: false,
    children: [],
  };
}

function cloneBlockPayload(block) {
  if (!block) {
    return createDefaultBlock();
  }
  return {
    id: block.id || uuid(),
    text: sanitizeContent(block.text || ''),
    collapsed: Boolean(block.collapsed),
    children: (block.children || []).map((child) => cloneBlockPayload(child)),
  };
}

function sanitizeBlock(block) {
  if (!block) return;
  block.text = sanitizeContent(block.text || '');
  (block.children || []).forEach((child) => sanitizeBlock(child));
}

function normalizeArticle(article) {
  if (!article) {
    return null;
  }
  article.blocks = Array.isArray(article.blocks) ? article.blocks : [];
  article.history = Array.isArray(article.history) ? article.history : [];
  article.redoHistory = Array.isArray(article.redoHistory) ? article.redoHistory : [];
  article.blocks.forEach((block) => sanitizeBlock(block));
  return article;
}

function parseHistory(json) {
  try {
    return JSON.parse(json || '[]') || [];
  } catch {
    return [];
  }
}

function serializeHistory(entries) {
  return JSON.stringify(entries || []);
}

function buildBlockTree(articleId) {
  const rows = db
    .prepare(
      `
      SELECT block_rowid, id, parent_id, text, collapsed, position
      FROM blocks
      WHERE article_id = ?
      ORDER BY position ASC
    `,
    )
    .all(articleId);
  const map = new Map();
  const roots = [];

  rows.forEach((row) => {
    map.set(row.id, {
      id: row.id,
      text: row.text,
      collapsed: Boolean(row.collapsed),
      children: [],
      __position: row.position,
    });
  });

  rows.forEach((row) => {
    const block = map.get(row.id);
    if (!row.parent_id) {
      roots.push(block);
      return;
    }
    const parent = map.get(row.parent_id);
    if (parent) {
      parent.children.push(block);
    } else {
      roots.push(block);
    }
  });

  const sortChildren = (nodes = []) => {
    nodes.sort((a, b) => (a.__position || 0) - (b.__position || 0));
    nodes.forEach((node) => sortChildren(node.children));
  };

  const cleanNode = (node) => {
    delete node.__position;
    node.children.forEach(cleanNode);
  };

  sortChildren(roots);
  roots.forEach(cleanNode);
  return roots;
}

function buildArticleFromRow(row) {
  if (!row) return null;
  const article = {
    id: row.id,
    title: row.title,
    updatedAt: row.updated_at,
    createdAt: row.created_at,
    history: parseHistory(row.history),
    redoHistory: parseHistory(row.redo_history),
    blocks: buildBlockTree(row.id),
  };
  return article;
}

function getArticles() {
  const rows = db.prepare('SELECT * FROM articles ORDER BY updated_at DESC').all();
  return rows.map((row) => buildArticleFromRow(row));
}

function getArticle(id) {
  const row = db.prepare('SELECT * FROM articles WHERE id = ?').get(id);
  return buildArticleFromRow(row);
}

const insertArticleStmt = db.prepare(
  `
    INSERT INTO articles (id, title, created_at, updated_at, history, redo_history)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
);
const updateArticleStmt = db.prepare(
  `
    UPDATE articles
    SET title = ?, updated_at = ?, history = ?, redo_history = ?
    WHERE id = ?
  `,
);
const deleteBlocksStmt = db.prepare('DELETE FROM blocks WHERE article_id = ?');
const deleteBlocksFtsStmt = db.prepare('DELETE FROM blocks_fts WHERE article_id = ?');
const insertBlockStmt = db.prepare(
  `
    INSERT INTO blocks (id, article_id, parent_id, position, text, normalized_text, collapsed, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
);
const insertBlockFtsStmt = db.prepare(
  `
    INSERT OR REPLACE INTO blocks_fts (block_rowid, article_id, text, lemma, normalized_text)
    VALUES (?, ?, ?, ?, ?)
  `,
);

function insertBlocksRecursive(articleId, blocks, articleUpdatedAt, parentId = null) {
  blocks.forEach((block, index) => {
    const plainText = stripHtml(block.text || '');
    const normalizedLemma = buildLemma(plainText);
    const normalizedTokens = buildNormalizedTokens(plainText);
    const result = insertBlockStmt.run(
      block.id,
      articleId,
      parentId,
      index,
      block.text || '',
      normalizedTokens,
      block.collapsed ? 1 : 0,
      articleUpdatedAt,
      articleUpdatedAt,
    );
    const blockRowId = result.lastInsertRowid;
    insertBlockFtsStmt.run(blockRowId, articleId, block.text || '', normalizedLemma, normalizedTokens);
    if (block.children && block.children.length > 0) {
      insertBlocksRecursive(articleId, block.children, articleUpdatedAt, block.id);
    }
  });
}

const saveArticleTransaction = db.transaction((article) => {
  const normalized = normalizeArticle(article);
  if (!normalized) return;
  const now = normalized.updatedAt || new Date().toISOString();
  normalized.updatedAt = now;
  const existing = db.prepare('SELECT created_at FROM articles WHERE id = ?').get(normalized.id);
  const historyJson = serializeHistory(normalized.history);
  const redoJson = serializeHistory(normalized.redoHistory);
  if (existing) {
    updateArticleStmt.run(normalized.title, now, historyJson, redoJson, normalized.id);
  } else {
    insertArticleStmt.run(normalized.id, normalized.title || 'РќРѕРІР°СЏ СЃС‚Р°С‚СЊСЏ', now, now, historyJson, redoJson);
  }
  deleteBlocksStmt.run(normalized.id);
  deleteBlocksFtsStmt.run(normalized.id);
  insertBlocksRecursive(normalized.id, normalized.blocks, now, null);
});

function saveArticle(article) {
  saveArticleTransaction(article);
}

function createArticle(title = 'РќРѕРІР°СЏ СЃС‚Р°С‚СЊСЏ') {
  const now = new Date().toISOString();
  const article = {
    id: uuid(),
    title,
    createdAt: now,
    updatedAt: now,
    blocks: [createDefaultBlock()],
    history: [],
    redoHistory: [],
  };
  saveArticle(article);
  return article;
}

function findBlockRecursive(blocks, blockId, parent = null) {
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    if (block.id === blockId) {
      return { block, parent, index: i, siblings: blocks };
    }
    const nested = findBlockRecursive(block.children || [], blockId, block);
    if (nested) {
      return nested;
    }
  }
  return null;
}

function pushTextHistoryEntry(article, blockId, before, after) {
  if (before === after) {
    return null;
  }
  article.history = article.history || [];
  article.redoHistory = [];
  const entry = {
    id: uuid(),
    blockId,
    before,
    after,
    timestamp: new Date().toISOString(),
  };
  article.history.push(entry);
  return entry;
}

function updateBlock(articleId, blockId, attrs) {
  const article = getArticle(articleId);
  if (!article) {
    return null;
  }
  const located = findBlockRecursive(article.blocks, blockId, null);
  if (!located) {
    return null;
  }
  let historyEntryId = null;
  if (Object.prototype.hasOwnProperty.call(attrs, 'text')) {
    const previousText = typeof located.block.text === 'string' ? located.block.text : '';
    const rawNextText =
      typeof attrs.text === 'string'
        ? attrs.text
        : typeof located.block.text === 'string'
        ? located.block.text
        : '';
    const nextText = sanitizeContent(rawNextText);
    const entry = pushTextHistoryEntry(article, blockId, previousText, nextText);
    historyEntryId = entry ? entry.id : null;
    located.block.text = nextText;
  }
  if (typeof attrs.collapsed === 'boolean') {
    located.block.collapsed = attrs.collapsed;
  }
  article.updatedAt = new Date().toISOString();
  saveArticle(article);
  const responseBlock = { ...located.block };
  if (historyEntryId) {
    responseBlock.historyEntryId = historyEntryId;
  }
  return responseBlock;
}

function updateBlockCollapse(articleId, blockId, collapsed) {
  const article = getArticle(articleId);
  if (!article) {
    return null;
  }
  const located = findBlockRecursive(article.blocks, blockId, null);
  if (!located) {
    return null;
  }
  located.block.collapsed = Boolean(collapsed);
  article.updatedAt = new Date().toISOString();
  saveArticle(article);
  return { updatedAt: article.updatedAt };
}

function undoBlockTextChange(articleId, entryId = null) {
  const article = getArticle(articleId);
  if (!article) {
    return null;
  }
  article.history = article.history || [];
  article.redoHistory = article.redoHistory || [];
  if (!article.history.length) {
    return null;
  }
  const index =
    entryId && entryId !== null
      ? article.history.findIndex((entry) => entry.id === entryId)
      : article.history.length - 1;
  if (index < 0) {
    return null;
  }
  const entry = article.history[index];
  const located = findBlockRecursive(article.blocks, entry.blockId, null);
  if (!located) {
    return null;
  }
  located.block.text = entry.before;
  article.history.splice(index, 1);
  article.redoHistory.push(entry);
  article.updatedAt = new Date().toISOString();
  saveArticle(article);
  return located.block;
}

function redoBlockTextChange(articleId, entryId = null) {
  const article = getArticle(articleId);
  if (!article) {
    return null;
  }
  article.history = article.history || [];
  article.redoHistory = article.redoHistory || [];
  if (!article.redoHistory.length) {
    return null;
  }
  const index =
    entryId && entryId !== null
      ? article.redoHistory.findIndex((entry) => entry.id === entryId)
      : article.redoHistory.length - 1;
  if (index < 0) {
    return null;
  }
  const entry = article.redoHistory[index];
  const located = findBlockRecursive(article.blocks, entry.blockId, null);
  if (!located) {
    return null;
  }
  located.block.text = entry.after;
  article.redoHistory.splice(index, 1);
  article.history.push(entry);
  article.updatedAt = new Date().toISOString();
  saveArticle(article);
  return located.block;
}

function deleteBlock(articleId, blockId) {
  const article = getArticle(articleId);
  if (!article) {
    return null;
  }
  const located = findBlockRecursive(article.blocks, blockId, null);
  if (!located) {
    return null;
  }
  const removed = located.siblings.splice(located.index, 1)[0];
  if (!removed) {
    return null;
  }
  article.updatedAt = new Date().toISOString();
  saveArticle(article);
  return {
    removedBlockId: removed.id,
    parentId: located.parent ? located.parent.id : null,
    index: located.index,
    block: removed,
  };
}

function moveBlock(articleId, blockId, direction) {
  if (!['up', 'down'].includes(direction)) {
    return null;
  }
  const article = getArticle(articleId);
  if (!article) {
    return null;
  }
  const located = findBlockRecursive(article.blocks, blockId, null);
  if (!located) {
    return null;
  }
  const { siblings, index } = located;
  const targetIndex = direction === 'up' ? index - 1 : index + 1;
  if (targetIndex < 0 || targetIndex >= siblings.length) {
    return null;
  }
  const [block] = siblings.splice(index, 1);
  siblings.splice(targetIndex, 0, block);
  article.updatedAt = new Date().toISOString();
  saveArticle(article);
  return {
    block,
    parentId: located.parent ? located.parent.id : null,
  };
}

function indentBlock(articleId, blockId) {
  const article = getArticle(articleId);
  if (!article) {
    return null;
  }
  const located = findBlockRecursive(article.blocks, blockId, null);
  if (!located) {
    return null;
  }
  const { siblings, index } = located;
  const previousSibling = siblings[index - 1];
  if (!previousSibling) {
    return null;
  }
  const [block] = siblings.splice(index, 1);
  previousSibling.children = previousSibling.children || [];
  previousSibling.children.push(block);
  article.updatedAt = new Date().toISOString();
  saveArticle(article);
  return {
    block,
    parentId: previousSibling.id,
  };
}

function outdentBlock(articleId, blockId) {
  const article = getArticle(articleId);
  if (!article) {
    return null;
  }
  const located = findBlockRecursive(article.blocks, blockId, null);
  if (!located || !located.parent) {
    return null;
  }
  const parentInfo = findBlockRecursive(article.blocks, located.parent.id, null);
  if (!parentInfo) {
    return null;
  }
  const { siblings, index } = located;
  const followingSiblings = siblings.splice(index + 1);
  const [block] = siblings.splice(index, 1);
  if (!block) {
    return null;
  }
  block.children = block.children || [];
  block.children.push(...followingSiblings);
  const targetSiblings = parentInfo.siblings;
  const insertionIndex = parentInfo.index + 1;
  targetSiblings.splice(insertionIndex, 0, block);
  article.updatedAt = new Date().toISOString();
  saveArticle(article);
  return {
    block,
    parentId: parentInfo.parent ? parentInfo.parent.id : null,
  };
}

function insertBlock(articleId, targetBlockId, direction = 'after', blockPayload = null) {
  const article = getArticle(articleId);
  if (!article) {
    return null;
  }
  const located = findBlockRecursive(article.blocks, targetBlockId, null);
  if (!located) {
    return null;
  }
  const { parent, siblings, index } = located;
  const newBlock = blockPayload ? cloneBlockPayload(blockPayload) : createDefaultBlock();
  const insertionIndex = direction === 'before' ? index : index + 1;
  siblings.splice(insertionIndex, 0, newBlock);
  article.updatedAt = new Date().toISOString();
  saveArticle(article);
  return { block: newBlock, parentId: parent ? parent.id : null, index: insertionIndex };
}

function restoreBlock(articleId, parentId, index, blockPayload) {
  const article = getArticle(articleId);
  if (!article) {
    return null;
  }
  const siblingsInfo = parentId ? findBlockRecursive(article.blocks, parentId, null) : null;
  const siblings = parentId ? siblingsInfo?.block?.children : article.blocks;
  if (!siblings) {
    return null;
  }
  const insertionIndex =
    typeof index === 'number' && index >= 0 && index <= siblings.length ? index : siblings.length;
  const restoredBlock = cloneBlockPayload(blockPayload);
  siblings.splice(insertionIndex, 0, restoredBlock);
  article.updatedAt = new Date().toISOString();
  saveArticle(article);
  return { block: restoredBlock, parentId: parentId || null, index: insertionIndex };
}

function updateArticleMeta(articleId, attrs = {}) {
  const article = getArticle(articleId);
  if (!article) {
    return null;
  }
  let changed = false;
  if (typeof attrs.title === 'string') {
    const newTitle = sanitizeHtml(attrs.title || '', { allowedTags: [], allowedAttributes: {} }).trim() || 'РќРѕРІР°СЏ СЃС‚Р°С‚СЊСЏ';
    if (newTitle !== article.title) {
      article.title = newTitle;
      changed = true;
    }
  }
  if (!changed) {
    return article;
  }
  article.updatedAt = new Date().toISOString();
  saveArticle(article);
  return article;
}

function buildFtsQuery(term) {
  const lemmaTokens = buildLemmaTokens(term);
  const normalizedTokensQuery = buildNormalizedTokens(term)
    .split(/\s+/)
    .filter(Boolean);
  const predicateParts = [];
  if (lemmaTokens.length) {
    predicateParts.push(
      lemmaTokens.map((token) => `lemma:${token}*`).join(' OR '),
    );
  }
  if (normalizedTokensQuery.length) {
    predicateParts.push(
      normalizedTokensQuery.map((token) => `normalized_text:${token}*`).join(' OR '),
    );
  }
  return predicateParts.filter(Boolean).join(' OR ');
}

const searchStatement = db.prepare(
  `
    SELECT
      blocks.id AS blockId,
      articles.id AS articleId,
      articles.title AS articleTitle,
      snippet(blocks_fts, '', '', '...', -1, 64) AS snippet,
      blocks.text AS blockText
    FROM blocks_fts
    JOIN blocks ON blocks.rowid = blocks_fts.block_rowid
    JOIN articles ON articles.id = blocks.article_id
    WHERE blocks_fts MATCH ?
    ORDER BY bm25(blocks_fts) ASC
    LIMIT ?
  `,
);

function searchBlocks(query, limit = 20) {
  const term = (query || '').trim();
  if (!term) {
    return [];
  }
  const ftsQuery = buildFtsQuery(term);
  if (!ftsQuery) {
    return [];
  }
  const rows = searchStatement.all(ftsQuery, limit);
  return rows.map((row) => ({
    articleId: row.articleId,
    articleTitle: row.articleTitle,
    blockId: row.blockId,
    snippet: row.snippet || stripHtml(row.blockText || '').slice(0, 160),
  }));
}

function ensureSampleArticle() {
  const exists = db.prepare('SELECT 1 FROM articles LIMIT 1').get();
  if (exists) {
    return;
  }
  const introBlock = {
    id: uuid(),
    text: 'РџСЂРёРјРµСЂРЅС‹Р№ Р±Р»РѕРє',
    collapsed: false,
    children: [
      {
        id: uuid(),
        text: 'Р”РѕС‡РµСЂРЅРёР№ СЌР»РµРјРµРЅС‚',
        collapsed: false,
        children: [],
      },
      {
        id: uuid(),
        text: 'Р Р°Р·РІРёРІР°СЋС‰Р°СЏ РІРµС‚РєР°',
        collapsed: false,
        children: [
          {
            id: uuid(),
            text: 'Р“Р»СѓР±РѕРєРѕ РІР»РѕР¶РµРЅРЅС‹Р№ Р±Р»РѕРє',
            collapsed: false,
            children: [],
          },
        ],
      },
    ],
  };
  const sample = {
    id: uuid(),
    title: 'РџСЂРёРјРµСЂ СЃС‚Р°С‚СЊРё',
    updatedAt: new Date().toISOString(),
    blocks: [introBlock],
    history: [],
    redoHistory: [],
  };
  saveArticle(sample);
}

module.exports = {
  ensureSampleArticle,
  getArticles,
  getArticle,
  createArticle,
  updateBlock,
  updateBlockCollapse,
  insertBlock,
  deleteBlock,
  moveBlock,
  indentBlock,
  outdentBlock,
  undoBlockTextChange,
  redoBlockTextChange,
  restoreBlock,
  updateArticleMeta,
  searchBlocks,
};
