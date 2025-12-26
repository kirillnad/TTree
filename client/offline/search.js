import { getOfflineDbReady } from './index.js';
import { reqToPromise, txDone } from './idb.js';

function normalizeQuery(q) {
  return String(q || '').trim();
}

export async function localClassicSearch(query, { blockLimit = 30, articleLimit = 15 } = {}) {
  const q = normalizeQuery(query);
  if (!q) return [];
  const db = await getOfflineDbReady();
  const needle = q.toLowerCase();

  const tx = db.transaction(['articles', 'outline_sections'], 'readonly');
  const articlesStore = tx.objectStore('articles');
  const sectionsStore = tx.objectStore('outline_sections');

  const allArticles = (await reqToPromise(articlesStore.getAll()).catch(() => [])) || [];
  const articleResults = allArticles
    .filter((a) => a && !a.deletedAt)
    .filter((a) => String(a.title || '').toLowerCase().includes(needle))
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    .slice(0, Math.max(0, Number(articleLimit) || 0))
    .map((a) => ({
      type: 'article',
      articleId: a.id,
      articleTitle: a.title || '',
      snippet: a.title || '',
    }));

  // If we haven't pulled doc_json yet, sections table may be empty.
  try {
    const c = Number(await reqToPromise(sectionsStore.count()).catch(() => 0));
    if (!c) {
      await txDone(tx);
      return navigator.onLine ? null : articleResults;
    }
  } catch {
    // ignore
  }

  const allSections = (await reqToPromise(sectionsStore.getAll()).catch(() => [])) || [];
  const titleById = new Map(allArticles.map((a) => [a.id, a.title || '']));
  const limit = Math.max(0, Number(blockLimit) || 0);
  const blockRows = allSections
    .filter((s) => String(s?.text || '').toLowerCase().includes(needle))
    .sort((a, b) => String(b?.updatedAt || '').localeCompare(String(a?.updatedAt || '')))
    .slice(0, limit)
    .map((s) => ({
      blockId: s.sectionId,
      articleId: s.articleId,
      articleTitle: titleById.get(s.articleId) || '',
      blockText: s.text || '',
    }));

  const blockResults = [];
  for (const row of blockRows) {
    const articleTitle = row.articleTitle || '';
    const blockText = row.blockText || '';
    blockResults.push({
      type: 'block',
      articleId: row.articleId,
      articleTitle,
      blockId: row.blockId,
      snippet: blockText.slice(0, 160),
      blockText,
    });
  }

  await txDone(tx);
  return [...articleResults, ...blockResults];
}
