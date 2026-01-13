import { reqToPromise, txDone } from './idb.js';

function textFromNode(node) {
  if (!node) return '';
  if (node.type === 'text') return String(node.text || '');
  const content = Array.isArray(node.content) ? node.content : [];
  if (!content.length) return '';
  const parts = [];
  for (const child of content) {
    const text = textFromNode(child);
    if (text) parts.push(text);
    if (child && (child.type === 'paragraph' || child.type === 'hardBreak' || child.type === 'heading')) {
      parts.push('\n');
    }
  }
  return parts.join('');
}

function normalizePlainText(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractSectionsRecursive(nodes, acc = []) {
  for (const node of nodes || []) {
    if (!node || node.type !== 'outlineSection') continue;
    const sectionId = String(node.attrs?.id || '');
    const heading = node.content?.[0];
    const body = node.content?.[1];
    const children = node.content?.[2];
    const title = normalizePlainText(textFromNode(heading)) || '';
    const bodyText = normalizePlainText(textFromNode(body)) || '';
    const combined = `${title}\n${bodyText}`.trim();
    if (sectionId) {
      acc.push({
        sectionId,
        title,
        text: combined,
      });
    }
    // children is a wrapper node (outlineChildren)
    const childSections = children?.content || [];
    extractSectionsRecursive(childSections, acc);
  }
  return acc;
}

export function extractOutlineSections(docJson) {
  const content = Array.isArray(docJson?.content) ? docJson.content : [];
  return extractSectionsRecursive(content, []);
}

function normalizeTagKey(key) {
  return String(key || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9а-яё_-]/gi, '');
}

function extractTagsRecursive(nodes, acc) {
  for (const node of nodes || []) {
    if (!node) continue;
    if (node.type === 'tag') {
      const raw = node.attrs?.key || node.attrs?.label || '';
      const k = normalizeTagKey(raw);
      if (k) acc.add(k);
    }
    const content = Array.isArray(node.content) ? node.content : [];
    if (content.length) extractTagsRecursive(content, acc);
  }
}

export function extractOutlineTags(docJson) {
  const acc = new Set();
  const content = Array.isArray(docJson?.content) ? docJson.content : [];
  extractTagsRecursive(content, acc);
  return Array.from(acc);
}

export async function reindexOutlineTags(db, { articleId, docJson, updatedAt }) {
  if (!db || !articleId) return;
  if (!docJson || typeof docJson !== 'object') return;
  const id = String(articleId);
  const nextTags = extractOutlineTags(docJson);
  const now = Date.now();

  const tx = db.transaction(['tags_by_article', 'tags_global'], 'readwrite');
  const byArticle = tx.objectStore('tags_by_article');
  const global = tx.objectStore('tags_global');

  const prevRow = await reqToPromise(byArticle.get(id)).catch(() => null);
  const prevTags = new Set(Array.isArray(prevRow?.tags) ? prevRow.tags.map((t) => String(t || '').trim()).filter(Boolean) : []);
  const nextSet = new Set(nextTags);
  const removed = [];
  const added = [];
  for (const t of prevTags) if (!nextSet.has(t)) removed.push(t);
  for (const t of nextSet) if (!prevTags.has(t)) added.push(t);

  for (const key of removed) {
    const row = await reqToPromise(global.get(key)).catch(() => null);
    const count = Math.max(0, (Number(row?.count || 0) || 0) - 1);
    if (count <= 0) {
      await reqToPromise(global.delete(key)).catch(() => {});
    } else {
      await reqToPromise(global.put({ ...(row || {}), key, label: String(row?.label || key), count, lastSeenAtMs: Number(row?.lastSeenAtMs || 0) || 0 })).catch(() => {});
    }
  }

  for (const key of nextSet) {
    const row = await reqToPromise(global.get(key)).catch(() => null);
    const count = (Number(row?.count || 0) || 0) + (added.includes(key) ? 1 : 0);
    await reqToPromise(
      global.put({
        ...(row || {}),
        key,
        label: String(row?.label || key),
        count: Math.max(1, count),
        lastSeenAtMs: now,
      }),
    ).catch(() => {});
  }

  await reqToPromise(
    byArticle.put({
      articleId: id,
      tags: nextTags,
      updatedAt: updatedAt || null,
      indexedAtMs: now,
    }),
  );
  await txDone(tx);
}

export async function reindexOutlineSections(db, { articleId, docJson, updatedAt }) {
  if (!db || !articleId) return;
  if (!docJson || typeof docJson !== 'object') return;
  const sections = extractOutlineSections(docJson);
  const tx = db.transaction(['outline_sections'], 'readwrite');
  const store = tx.objectStore('outline_sections');
  const idx = store.index('byArticleId');
  const range = IDBKeyRange.only(String(articleId));

  // Delete old section rows for article.
  let cursor = await reqToPromise(idx.openCursor(range));
  while (cursor) {
    cursor.delete();
    cursor = await reqToPromise(cursor.continue());
  }

  // Insert new sections.
  for (const s of sections) {
    await reqToPromise(
      store.put({
        sectionId: s.sectionId,
        articleId: String(articleId),
        title: s.title || '',
        text: s.text || '',
        updatedAt: updatedAt || null,
      }),
    );
  }
  await txDone(tx);
}
