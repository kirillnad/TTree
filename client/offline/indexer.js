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
  await db.query('BEGIN');
  try {
    await db.query('DELETE FROM outline_sections WHERE article_id = $1', [articleId]);
    for (const s of sections) {
      await db.query(
        'INSERT INTO outline_sections (section_id, article_id, title, text, updated_at) VALUES ($1, $2, $3, $4, $5) ' +
          'ON CONFLICT (section_id) DO UPDATE SET article_id = EXCLUDED.article_id, title = EXCLUDED.title, text = EXCLUDED.text, updated_at = EXCLUDED.updated_at',
        [s.sectionId, articleId, s.title || '', s.text || '', updatedAt || null],
      );
    }
    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}
