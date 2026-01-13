import { getOfflineDbReady } from './index.js';
import { reqToPromise, txDone } from './idb.js';
import { reindexOutlineSections, reindexOutlineTags } from './indexer.js';
import { updateMediaRefsForArticle } from './media.js';
import { hasPendingOutlineOps } from './outbox.js';
import { markGlobalTagsIndexStale } from './tags.js';
import { revertLog, docJsonHash } from '../debug/revertLog.js';

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
  let existingArticle = null;
  try {
    existingArticle = existing?.articleJsonStr ? JSON.parse(existing.articleJsonStr) : null;
  } catch {
    existingArticle = null;
  }
  const existingLocalDraft = Boolean(existingArticle && existingArticle.localDraft);
  const incomingOutlineStructureRev =
    article && Object.prototype.hasOwnProperty.call(article, 'outlineStructureRev') ? Number(article.outlineStructureRev) : null;
  try {
    const existingUpdatedAt = String(existing?.updatedAt || '').trim();
    const nextUpdatedAt = String(updatedAt || '').trim();
    if (existingUpdatedAt && nextUpdatedAt && nextUpdatedAt < existingUpdatedAt) {
      revertLog('cache.article.put.skip_older', {
        articleId: article.id,
        existingUpdatedAt,
        incomingUpdatedAt: nextUpdatedAt,
        incomingDocHash: docJsonHash(docJson),
      });
      await txDone(tx);
      return;
    }
    // Protect local-first outline edits: if we have a local draft and the server doesn't advance updatedAt,
    // do not overwrite cached docJson with the (stale) server copy.
    if (existingLocalDraft && existingUpdatedAt && nextUpdatedAt && existingUpdatedAt === nextUpdatedAt) {
      // If outbox has no pending ops for this article, localDraft is stale and MUST NOT block server refresh.
      // This prevents "resurrected" deleted blocks and old structures after Ctrl-F5.
      let hasPending = false;
      try {
        hasPending = await hasPendingOutlineOps(article.id);
      } catch {
        hasPending = false;
      }
      if (!hasPending) {
        try {
          revertLog('cache.article.put.clear_stale_localDraft', {
            articleId: article.id,
            updatedAt: existingUpdatedAt,
          });
        } catch {
          // ignore
        }
      } else {
      const existingDocHash = docJsonHash(existing?.docJsonStr ? JSON.parse(existing.docJsonStr) : null);
      const incomingDocHash = docJsonHash(docJson);
      if (existingDocHash && incomingDocHash && existingDocHash !== incomingDocHash) {
        const merged = existingArticle && typeof existingArticle === 'object' ? { ...existingArticle } : {};
        merged.id = article.id;
        merged.title = article.title || merged.title || '';
        merged.updatedAt = existingUpdatedAt;
        merged.parentId = article.parentId ?? merged.parentId ?? null;
        merged.position = typeof article.position === 'number' ? article.position : merged.position ?? 0;
        merged.publicSlug = article.publicSlug ?? merged.publicSlug ?? null;
        merged.encrypted = Boolean(article.encrypted);
        if (Object.prototype.hasOwnProperty.call(article, 'outlineStructureRev')) {
          merged.outlineStructureRev = Number(article.outlineStructureRev) || 0;
        }
        merged.localDraft = true;
        const nextProtected = {
          ...(existing || {}),
          id: article.id,
          title: article.title || '',
          updatedAt: existingUpdatedAt,
          parentId: article.parentId ?? null,
          position: typeof article.position === 'number' ? article.position : 0,
          publicSlug: article.publicSlug ?? null,
          encrypted: article.encrypted ? 1 : 0,
          deletedAt: null,
          outlineStructureRev:
            Number.isFinite(incomingOutlineStructureRev) ? incomingOutlineStructureRev : Number(existing?.outlineStructureRev),
          docJsonStr: existing?.docJsonStr ?? null,
          articleJsonStr: JSON.stringify(merged),
        };
        await reqToPromise(store.put(nextProtected));
        await txDone(tx);
        try {
          revertLog('cache.article.put.skip_localDraft', {
            articleId: article.id,
            updatedAt: existingUpdatedAt,
            existingDocHash,
            incomingDocHash,
          });
        } catch {
          // ignore
        }
        return;
      }
      }
    }
  } catch {
    // ignore
  }
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
    outlineStructureRev:
      Number.isFinite(incomingOutlineStructureRev) ? incomingOutlineStructureRev : Number(existing?.outlineStructureRev),
    docJsonStr: docJson ? JSON.stringify(docJson) : null,
    articleJsonStr: JSON.stringify(article),
  };
  await reqToPromise(store.put(next));
  await txDone(tx);
  try {
    revertLog('cache.article.put', {
      articleId: article.id,
      updatedAt,
      hasDocJson: Boolean(docJson),
      docHash: docJsonHash(docJson),
    });
  } catch {
    // ignore
  }
  if (docJson) {
    reindexOutlineSections(db, { articleId: article.id, docJson, updatedAt }).catch(() => {});
    reindexOutlineTags(db, { articleId: article.id, docJson, updatedAt }).then(markGlobalTagsIndexStale).catch(() => {});
    updateMediaRefsForArticle(article.id, docJson).catch(() => {});
  }
}

export async function cacheArticleUnderId(article, cacheId) {
  if (!article || !cacheId) return;
  const db = await getOfflineDbReady();
  const id = String(cacheId);
  const docJson = article.docJson && typeof article.docJson === 'object' ? article.docJson : null;
  const updatedAt = article.updatedAt || null;
  const tx = db.transaction(['articles'], 'readwrite');
  const store = tx.objectStore('articles');
  const existing = await reqToPromise(store.get(id)).catch(() => null);
  try {
    const existingUpdatedAt = String(existing?.updatedAt || '').trim();
    const nextUpdatedAt = String(updatedAt || '').trim();
    if (existingUpdatedAt && nextUpdatedAt && nextUpdatedAt < existingUpdatedAt) {
      revertLog('cache.articleUnderId.put.skip_older', {
        articleId: id,
        existingUpdatedAt,
        incomingUpdatedAt: nextUpdatedAt,
        incomingDocHash: docJsonHash(docJson),
      });
      await txDone(tx);
      return;
    }
  } catch {
    // ignore
  }
  const next = {
    ...(existing || {}),
    id,
    title: article.title || existing?.title || '',
    updatedAt: updatedAt || existing?.updatedAt || null,
    parentId: article.parentId ?? existing?.parentId ?? null,
    position: typeof article.position === 'number' ? article.position : existing?.position || 0,
    publicSlug: article.publicSlug ?? existing?.publicSlug ?? null,
    encrypted: article.encrypted ? 1 : existing?.encrypted ? 1 : 0,
    deletedAt: null,
    docJsonStr: docJson ? JSON.stringify(docJson) : existing?.docJsonStr ?? null,
    // Keep original article JSON (do not overwrite id inside it).
    articleJsonStr: JSON.stringify(article),
  };
  await reqToPromise(store.put(next));
  await txDone(tx);
  if (docJson) {
    reindexOutlineSections(db, { articleId: id, docJson, updatedAt }).catch(() => {});
    reindexOutlineTags(db, { articleId: id, docJson, updatedAt }).then(markGlobalTagsIndexStale).catch(() => {});
    updateMediaRefsForArticle(id, docJson).catch(() => {});
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
    // Fallback: articleJsonStr may be corrupted/partial; docJsonStr is the source of truth for offline.
    try {
      const docJson = row.docJsonStr ? JSON.parse(row.docJsonStr) : null;
      const fallback = {
        id: articleId,
        title: row.title || '',
        createdAt: row.createdAt || row.updatedAt || null,
        updatedAt: row.updatedAt || null,
        deletedAt: row.deletedAt || null,
        parentId: row.parentId ?? null,
        position: typeof row.position === 'number' ? row.position : 0,
        authorId: null,
        publicSlug: row.publicSlug ?? null,
        encrypted: !!row.encrypted,
        outlineStructureRev: Number.isFinite(Number(row.outlineStructureRev)) ? Number(row.outlineStructureRev) : undefined,
        docJson: docJson && typeof docJson === 'object' ? docJson : null,
        history: [],
        redoHistory: [],
        blockTrash: [],
      };
      try {
        revertLog('cache.article.get.fallback_docJsonStr', {
          articleId,
          updatedAt: fallback.updatedAt || null,
          docHash: docJsonHash(fallback.docJson),
        });
      } catch {
        // ignore
      }
      return fallback;
    } catch {
      return null;
    }
  }
}

export async function updateCachedDocJson(articleId, docJson, updatedAt) {
  if (!articleId) return;
  const db = await getOfflineDbReady();
  const tx = db.transaction(['articles'], 'readwrite');
  const store = tx.objectStore('articles');
  const existing = await reqToPromise(store.get(articleId)).catch(() => null);
  // Never clear updatedAt on local draft saves: otherwise offline-first will treat cache as "stale/unknown"
  // and may refetch from server, overwriting the locally edited docJson.
  const nextUpdatedAt = (updatedAt || (existing && existing.updatedAt) || null);

  // `getCachedArticle()` relies on `articleJsonStr`. If we only store `docJsonStr`, reads will return `null`,
  // which breaks offline-first flows (e.g., inbox quick notes queued offline).
  const minimalArticleJsonStr = () => {
    const titleFallback = String(articleId) === 'inbox' ? 'Быстрые заметки' : '';
    const title = (existing && typeof existing.title === 'string' ? existing.title : '') || titleFallback;
    const updated = nextUpdatedAt;
    const article = {
      id: articleId,
      title,
      createdAt: (existing && existing.createdAt) || updated || null,
      updatedAt: updated,
      deletedAt: (existing && existing.deletedAt) || null,
      parentId: (existing && existing.parentId) ?? null,
      position: typeof (existing && existing.position) === 'number' ? existing.position : 0,
      authorId: null,
      publicSlug: (existing && existing.publicSlug) ?? null,
      encrypted: !!(existing && existing.encrypted),
      docJson: null,
      history: [],
      blocks: [],
    };
    return JSON.stringify(article);
  };

  const updateArticleJsonStrWithDoc = () => {
    const baseStr = (existing && existing.articleJsonStr) || '';
    let article = null;
    try {
      article = baseStr ? JSON.parse(baseStr) : null;
    } catch {
      article = null;
    }
    if (!article || typeof article !== 'object') {
      try {
        article = JSON.parse(minimalArticleJsonStr());
      } catch {
        article = { id: articleId };
      }
    }
    // Keep id stable and overwrite docJson/updatedAt to reflect the cached draft.
    article.id = articleId;
    article.updatedAt = nextUpdatedAt || article.updatedAt || null;
    article.docJson = docJson && typeof docJson === 'object' ? docJson : null;
    if (docJson && typeof docJson === 'object') {
      article.localDraft = true;
    }
    // Normalize common fields to avoid undefined creeping in.
    if (!article.title && existing?.title) article.title = existing.title;
    if (article.deletedAt === undefined) article.deletedAt = null;
    if (article.parentId === undefined) article.parentId = existing?.parentId ?? null;
    if (article.position === undefined) article.position = typeof existing?.position === 'number' ? existing.position : 0;
    if (article.publicSlug === undefined) article.publicSlug = existing?.publicSlug ?? null;
    if (article.encrypted === undefined) article.encrypted = !!existing?.encrypted;
    if (article.history === undefined) article.history = [];
    if (article.blocks === undefined) article.blocks = [];
    return JSON.stringify(article);
  };
  const next = {
    ...(existing || { id: articleId }),
    id: articleId,
    outlineStructureRev: existing?.outlineStructureRev,
    docJsonStr: docJson ? JSON.stringify(docJson) : null,
    updatedAt: nextUpdatedAt,
    // Keep `articleJsonStr` in sync with `docJsonStr`, otherwise reads will use stale docJson/updatedAt.
    articleJsonStr: updateArticleJsonStrWithDoc(),
  };
  await reqToPromise(store.put(next));
  await txDone(tx);
  try {
    revertLog('cache.docJson.put', {
      articleId,
      updatedAt: nextUpdatedAt,
      docHash: docJsonHash(docJson),
    });
  } catch {
    // ignore
  }
  if (docJson && typeof docJson === 'object') {
    reindexOutlineSections(db, { articleId, docJson, updatedAt }).catch(() => {});
    reindexOutlineTags(db, { articleId, docJson, updatedAt }).then(markGlobalTagsIndexStale).catch(() => {});
    updateMediaRefsForArticle(articleId, docJson).catch(() => {});
  }
}

export async function markCachedArticleDeleted(articleId, deletedAt) {
  const id = String(articleId || '').trim();
  if (!id) return;
  const ts = String(deletedAt || new Date().toISOString()).trim();
  const db = await getOfflineDbReady();
  const tx = db.transaction(['articles'], 'readwrite');
  const store = tx.objectStore('articles');
  const existing = await reqToPromise(store.get(id)).catch(() => null);
  if (!existing) {
    await txDone(tx);
    return;
  }
  let article = null;
  try {
    article = existing.articleJsonStr ? JSON.parse(existing.articleJsonStr) : null;
  } catch {
    article = null;
  }
  if (!article || typeof article !== 'object') article = { id };
  article.id = id;
  article.deletedAt = ts;
  const next = {
    ...existing,
    deletedAt: ts,
    articleJsonStr: JSON.stringify(article),
  };
  await reqToPromise(store.put(next));
  await txDone(tx);
}

export async function clearCachedArticleLocalDraft(articleId) {
  const id = String(articleId || '').trim();
  if (!id) return;
  const db = await getOfflineDbReady();
  const tx = db.transaction(['articles'], 'readwrite');
  const store = tx.objectStore('articles');
  const existing = await reqToPromise(store.get(id)).catch(() => null);
  if (!existing) {
    await txDone(tx);
    return;
  }
  let article = null;
  try {
    article = existing.articleJsonStr ? JSON.parse(existing.articleJsonStr) : null;
  } catch {
    article = null;
  }
  if (!article || typeof article !== 'object') article = { id };
  article.id = id;
  delete article.localDraft;
  const next = {
    ...existing,
    articleJsonStr: JSON.stringify(article),
  };
  await reqToPromise(store.put(next));
  await txDone(tx);
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

export async function touchCachedArticleUpdatedAt(articleId, updatedAt) {
  const id = String(articleId || '').trim();
  const nextUpdatedAt = String(updatedAt || '').trim();
  if (!id || !nextUpdatedAt) return;
  const db = await getOfflineDbReady();
  const tx = db.transaction(['articles'], 'readwrite');
  const store = tx.objectStore('articles');
  const existing = await reqToPromise(store.get(id)).catch(() => null);
  if (!existing) {
    await txDone(tx);
    return;
  }

  let article = null;
  try {
    article = existing.articleJsonStr ? JSON.parse(existing.articleJsonStr) : null;
  } catch {
    article = null;
  }
  if (!article || typeof article !== 'object') article = { id };
  article.id = id;
  article.updatedAt = nextUpdatedAt;

  const next = {
    ...existing,
    updatedAt: nextUpdatedAt,
    articleJsonStr: JSON.stringify(article),
  };
  await reqToPromise(store.put(next));
  await txDone(tx);
}

export async function touchCachedArticleOutlineStructureRev(articleId, outlineStructureRev) {
  const id = String(articleId || '').trim();
  if (!id) return;
  const nextRev = Number(outlineStructureRev);
  if (!Number.isFinite(nextRev) || nextRev < 0) return;
  const db = await getOfflineDbReady();
  const tx = db.transaction(['articles'], 'readwrite');
  const store = tx.objectStore('articles');
  const existing = await reqToPromise(store.get(id)).catch(() => null);
  if (!existing) {
    await txDone(tx);
    return;
  }
  let article = null;
  try {
    article = existing.articleJsonStr ? JSON.parse(existing.articleJsonStr) : null;
  } catch {
    article = null;
  }
  if (!article || typeof article !== 'object') article = { id };
  article.id = id;
  article.outlineStructureRev = nextRev;
  const next = {
    ...existing,
    outlineStructureRev: nextRev,
    articleJsonStr: JSON.stringify(article),
  };
  await reqToPromise(store.put(next));
  await txDone(tx);
}
