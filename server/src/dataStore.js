const fs = require('fs');
const path = require('path');
const { v4: uuid } = require('uuid');

const DATA_FILE = path.join(__dirname, '..', 'data', 'articles.json');

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
  };

  const sample = {
    id: uuid(),
    title: 'Пример статьи',
    updatedAt: new Date().toISOString(),
    blocks: [introBlock],
  };

  data.articles = [sample];
  writeData(data);
}

function getArticles() {
  const data = readData();
  return data.articles;
}

function getArticle(id) {
  return getArticles().find((article) => article.id === id) || null;
}

function saveArticle(article) {
  const data = readData();
  const idx = data.articles.findIndex((a) => a.id === article.id);
  if (idx >= 0) {
    data.articles[idx] = article;
  } else {
    data.articles.push(article);
  }
  writeData(data);
}

function createArticle(title = 'Новая статья') {
  const article = {
    id: uuid(),
    title,
    updatedAt: new Date().toISOString(),
    blocks: [
      {
        id: uuid(),
        text: 'Новый блок',
        collapsed: false,
        children: [],
      },
    ],
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

function updateBlock(articleId, blockId, attrs) {
  const article = getArticle(articleId);
  if (!article) {
    return null;
  }
  const located = findBlockRecursive(article.blocks, blockId, null);
  if (!located) {
    return null;
  }

  located.block.text = attrs.text ?? located.block.text;
  if (typeof attrs.collapsed === 'boolean') {
    located.block.collapsed = attrs.collapsed;
  }
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

function insertBlock(articleId, targetBlockId, direction = 'after') {
  const article = getArticle(articleId);
  if (!article) {
    return null;
  }
  const located = findBlockRecursive(article.blocks, targetBlockId, null);
  if (!located) {
    return null;
  }

  const { parent, siblings, index } = located;
  const newBlock = {
    id: uuid(),
    text: 'Новый блок',
    collapsed: false,
    children: [],
  };

  const insertionIndex = direction === 'before' ? index : index + 1;
  siblings.splice(insertionIndex, 0, newBlock);

  article.updatedAt = new Date().toISOString();
  saveArticle(article);
  return { block: newBlock, parentId: parent ? parent.id : null };
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
};
