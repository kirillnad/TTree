import { getOfflineDbReady } from './index.js';
import { reqToPromise, txDone } from './idb.js';
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
  const chunkSize = 50;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const tx = db.transaction(['articles'], 'readwrite');
    const store = tx.objectStore('articles');
    for (const article of chunk) {
      const row = pickArticleIndexRow(article);
      const existing = await reqToPromise(store.get(row.id)).catch(() => null);
      const next = {
        ...(existing || {}),
        id: row.id,
        title: row.title || '',
        updatedAt: row.updatedAt || null,
        parentId: row.parentId ?? null,
        position: typeof row.position === 'number' ? row.position : 0,
        publicSlug: row.publicSlug ?? null,
        encrypted: row.encrypted ? 1 : 0,
        deletedAt: null,
      };
      await reqToPromise(store.put(next));
    }
    await txDone(tx);
    // Yield to avoid blocking other IDB transactions (e.g., current article load/save).
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 0));
  }
}

export async function getCachedArticlesIndex() {
  const db = await getOfflineDbReady();
  const tx = db.transaction(['articles'], 'readonly');
  const store = tx.objectStore('articles');
  const rows = (await reqToPromise(store.getAll()).catch(() => [])) || [];
  await txDone(tx);
  return rows
    .filter((row) => row && !row.deletedAt)
    .sort((a, b) => Number(a.position || 0) - Number(b.position || 0))
    .map((row) => ({
      id: row.id,
      title: row.title || '',
      updatedAt: row.updatedAt || null,
      parentId: row.parentId ?? null,
      position: typeof row.position === 'number' ? row.position : 0,
      publicSlug: row.publicSlug ?? null,
      encrypted: !!row.encrypted,
    }));
}

export async function getCachedArticlesSyncMeta() {
  const db = await getOfflineDbReady();
  const tx = db.transaction(['articles'], 'readonly');
  const store = tx.objectStore('articles');
  const rows = (await reqToPromise(store.getAll()).catch(() => [])) || [];
  await txDone(tx);
  return rows
    .filter((row) => row && !row.deletedAt)
    .map((row) => ({
      id: row.id,
      updatedAt: row.updatedAt || null,
      hasDocJson: Boolean(row.docJsonStr),
    }));
}

export async function cacheArticle(article) {
  if (!article || !article.id) return;
  const db = await getOfflineDbReady();
  const docJson = article.docJson && typeof article.docJson === 'object' ? article.docJson : null;
  const updatedAt = article.updatedAt || null;
  const tx = db.transaction(['articles'], 'readwrite');
  const store = tx.objectStore('articles');
  const existing = await reqToPromise(store.get(article.id)).catch(() => null);
  const next = {
    ...(existing || {}),
    id: article.id,
    title: article.title || '',
    updatedAt,
    parentId: article.parentId ?? null,
    position: typeof article.position === 'number' ? article.position : 0,
    publicSlug: article.publicSlug ?? null,
    encrypted: article.encrypted ? 1 : 0,
    deletedAt: null,
    docJsonStr: docJson ? JSON.stringify(docJson) : null,
    articleJsonStr: JSON.stringify(article),
  };
  await reqToPromise(store.put(next));
  await txDone(tx);
  if (docJson) {
    reindexOutlineSections(db, { articleId: article.id, docJson, updatedAt }).catch(() => {});
    updateMediaRefsForArticle(article.id, docJson).catch(() => {});
  }
}

export async function getCachedArticle(articleId) {
  if (!articleId) return null;
  const db = await getOfflineDbReady();
  const tx = db.transaction(['articles'], 'readonly');
  const store = tx.objectStore('articles');
  const row = await reqToPromise(store.get(articleId)).catch(() => null);
  await txDone(tx);
  if (!row) return null;
  try {
    const article = JSON.parse(row.articleJsonStr || 'null');
    if (article && !article.docJson && row.docJsonStr) {
      article.docJson = JSON.parse(row.docJsonStr);
    }
    return article;
  } catch {
    return null;
  }
}

export async function updateCachedDocJson(articleId, docJson, updatedAt) {
  if (!articleId) return;
  const db = await getOfflineDbReady();
  const tx = db.transaction(['articles'], 'readwrite');
  const store = tx.objectStore('articles');
  const existing = await reqToPromise(store.get(articleId)).catch(() => null);
  const next = {
    ...(existing || { id: articleId }),
    id: articleId,
    docJsonStr: docJson ? JSON.stringify(docJson) : null,
    updatedAt: updatedAt || null,
  };
  await reqToPromise(store.put(next));
  await txDone(tx);
  if (docJson && typeof docJson === 'object') {
    reindexOutlineSections(db, { articleId, docJson, updatedAt }).catch(() => {});
    updateMediaRefsForArticle(articleId, docJson).catch(() => {});
  }
}

export async function updateCachedArticleTreePositions(changes) {
  const db = await getOfflineDbReady();
  const rows = Array.isArray(changes) ? changes : [];
  if (!rows.length) return;
  const tx = db.transaction(['articles'], 'readwrite');
  const store = tx.objectStore('articles');
  for (const c of rows) {
    if (!c || !c.id) continue;
    const existing = await reqToPromise(store.get(c.id)).catch(() => null);
    if (!existing) continue;
    const next = {
      ...existing,
      parentId: c.parentId ?? null,
      position: typeof c.position === 'number' ? c.position : 0,
    };
    await reqToPromise(store.put(next));
  }
  await txDone(tx);
}
