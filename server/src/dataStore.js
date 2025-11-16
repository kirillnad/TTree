const fs = require('fs');
const path = require('path');
const { v4: uuid } = require('uuid');
const sanitizeHtml = require('sanitize-html');

const DATA_FILE = path.join(__dirname, '..', 'data', 'articles.json');

const SANITIZE_OPTIONS = {
  allowedTags: [
    'b',
    'strong',
    'i',
    'em',
    'u',
    's',
    'mark',
    'code',
    'pre',
    'blockquote',
    'p',
    'br',
    'div',
    'span',
    'ul',
    'ol',
    'li',
    'a',
    'img',
  ],
  allowedAttributes: {
    a: ['href', 'title', 'target', 'rel'],
    img: ['src', 'alt', 'title'],
  },
  allowedSchemes: ['http', 'https', 'mailto', 'data'],
  allowedSchemesByTag: {
    img: ['http', 'https', 'data'],
  },
  allowProtocolRelative: false,
};

function sanitizeContent(html = '') {
  return sanitizeHtml(html || '', SANITIZE_OPTIONS);
}

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

function readData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    const normalized = raw.replace(/^\uFEFF/, '');
    if (!normalized.trim()) {
      return { articles: [] };
    }
    return JSON.parse(normalized);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { articles: [] };
    }
    throw error;
  }
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

function sanitizeBlock(block) {
  if (!block) return;
  block.text = sanitizeContent(block.text || '');
  (block.children || []).forEach((child) => sanitizeBlock(child));
}

function ensureHistoryArrays(article) {
  if (!Array.isArray(article.history)) {
    article.history = [];
  }
  if (!Array.isArray(article.redoHistory)) {
    article.redoHistory = [];
  }
}

function normalizeArticle(article) {
  if (!article) {
    return null;
  }
  ensureHistoryArrays(article);
  (article.blocks || []).forEach((block) => sanitizeBlock(block));
  return article;
}

function ensureSampleArticle() {
  const data = readData();
  if ((data.articles || []).length > 0) {
    return;
  }

  const introBlock = {
    id: uuid(),
    text: 'Заголовок статьи',
    collapsed: false,
    children: [
      {
        id: uuid(),
        text: 'Введение',
        collapsed: false,
        children: [],
      },
      {
        id: uuid(),
        text: 'Основной раздел',
        collapsed: false,
        children: [
          {
            id: uuid(),
            text: 'Подраздел',
            collapsed: false,
            children: [],
          },
        ],
      },
    ],
    history: [],
    redoHistory: [],
  };

  const sample = {
    id: uuid(),
    title: 'Пример статьи',
    updatedAt: new Date().toISOString(),
    blocks: [introBlock],
    history: [],
    redoHistory: [],
  };

  data.articles = [sample];
  writeData(data);
}

function getArticles() {
  const data = readData();
  return data.articles;
}

function getArticle(id) {
  const article = getArticles().find((item) => item.id === id) || null;
  return normalizeArticle(article);
}

function saveArticle(article) {
  const data = readData();
  const prepared = normalizeArticle(article);
  const idx = data.articles.findIndex((a) => a.id === prepared.id);
  if (idx >= 0) {
    data.articles[idx] = prepared;
  } else {
    data.articles.push(prepared);
  }
  writeData(data);
}

function createArticle(title = 'Новая статья') {
  const article = {
    id: uuid(),
    title,
    updatedAt: new Date().toISOString(),
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

module.exports = {
  ensureSampleArticle,
  getArticles,
  getArticle,
  createArticle,
  updateBlock,
  insertBlock,
  deleteBlock,
  moveBlock,
  indentBlock,
  outdentBlock,
  undoBlockTextChange,
  redoBlockTextChange,
  restoreBlock,
};
