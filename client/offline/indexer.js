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
