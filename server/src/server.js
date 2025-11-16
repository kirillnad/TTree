const path = require('path');
const express = require('express');
const cors = require('cors');
const {
  ensureSampleArticle,
  getArticle,
  getArticles,
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
} = require('./dataStore');

const PORT = process.env.PORT || 4000;

const app = express();
app.use(cors());
app.use(express.json());

const CLIENT_DIR = path.join(__dirname, '..', '..', 'client');
app.use(express.static(CLIENT_DIR));

ensureSampleArticle();

app.get('/api/articles', (req, res) => {
  res.json(
    getArticles().map((article) => ({
      id: article.id,
      title: article.title,
      updatedAt: article.updatedAt,
    })),
  );
});

app.post('/api/articles', (req, res) => {
  const { title } = req.body || {};
  const article = createArticle(title);
  res.status(201).json(article);
});

app.get('/api/articles/:articleId', (req, res) => {
  const article = getArticle(req.params.articleId);
  if (!article) {
    return res.status(404).json({ message: 'Article not found' });
  }
  return res.json(article);
});

app.patch('/api/articles/:articleId/blocks/:blockId', (req, res) => {
  const updated = updateBlock(req.params.articleId, req.params.blockId, req.body || {});
  if (!updated) {
    return res.status(404).json({ message: 'Block not found' });
  }
  return res.json(updated);
});

app.post('/api/articles/:articleId/blocks/:blockId/siblings', (req, res) => {
  const direction = req.body?.direction === 'before' ? 'before' : 'after';
  console.log('[API] insert sibling', req.params.articleId, req.params.blockId, direction);
  const inserted = insertBlock(
    req.params.articleId,
    req.params.blockId,
    direction,
    req.body?.payload || null,
  );
  if (!inserted) {
    return res.status(404).json({ message: 'Cannot insert block' });
  }
  return res.status(201).json(inserted);
});

app.delete('/api/articles/:articleId/blocks/:blockId', (req, res) => {
  console.log('[API] delete block', req.params.articleId, req.params.blockId);
  const removed = deleteBlock(req.params.articleId, req.params.blockId);
  if (!removed) {
    return res.status(404).json({ message: 'Block not found' });
  }
  return res.json(removed);
});

app.post('/api/articles/:articleId/blocks/:blockId/move', (req, res) => {
  const direction = req.body?.direction === 'up' ? 'up' : req.body?.direction === 'down' ? 'down' : null;
  if (!direction) {
    return res.status(400).json({ message: 'Unknown move direction' });
  }
  const moved = moveBlock(req.params.articleId, req.params.blockId, direction);
  if (!moved) {
    return res.status(400).json({ message: 'Cannot move block' });
  }
  return res.json(moved);
});

app.post('/api/articles/:articleId/blocks/:blockId/indent', (req, res) => {
  const indented = indentBlock(req.params.articleId, req.params.blockId);
  if (!indented) {
    return res.status(400).json({ message: 'Cannot indent block' });
  }
  return res.json(indented);
});

app.post('/api/articles/:articleId/blocks/:blockId/outdent', (req, res) => {
  const outdented = outdentBlock(req.params.articleId, req.params.blockId);
  if (!outdented) {
    return res.status(400).json({ message: 'Cannot outdent block' });
  }
  return res.json(outdented);
});

app.post('/api/articles/:articleId/blocks/undo-text', (req, res) => {
  const entryId = req.body?.entryId || null;
  const undone = undoBlockTextChange(req.params.articleId, entryId);
  if (!undone) {
    return res.status(400).json({ message: 'Nothing to undo' });
  }
  return res.json({ blockId: undone.id, block: undone });
});

app.post('/api/articles/:articleId/blocks/redo-text', (req, res) => {
  const entryId = req.body?.entryId || null;
  const redone = redoBlockTextChange(req.params.articleId, entryId);
  if (!redone) {
    return res.status(400).json({ message: 'Nothing to redo' });
  }
  return res.json({ blockId: redone.id, block: redone });
});

app.post('/api/articles/:articleId/blocks/restore', (req, res) => {
  console.log('[API] restore block', req.params.articleId, req.body?.parentId, req.body?.index);
  const { parentId = null, index = null, block } = req.body || {};
  if (!block) {
    return res.status(400).json({ message: 'Missing block payload' });
  }
  const restored = restoreBlock(req.params.articleId, parentId, index, block);
  if (!restored) {
    return res.status(400).json({ message: 'Cannot restore block' });
  }
  return res.json(restored);
});

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return next();
  }
  return res.sendFile(path.join(CLIENT_DIR, 'index.html'));
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`API listening on http://localhost:${PORT}`);
});
