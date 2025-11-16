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
  const inserted = insertBlock(req.params.articleId, req.params.blockId, direction);
  if (!inserted) {
    return res.status(404).json({ message: 'Cannot insert block' });
  }
  return res.status(201).json(inserted);
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
