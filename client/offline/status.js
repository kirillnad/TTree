import { getOfflineDbReady } from './index.js';
import { reqToPromise, txDone } from './idb.js';

export async function getOfflineCoverageSummary() {
  const db = await getOfflineDbReady();
  const tx = db.transaction(['articles', 'media_refs', 'media_assets'], 'readonly');
  const articles = tx.objectStore('articles');
  const refs = tx.objectStore('media_refs');
  const assets = tx.objectStore('media_assets');

  const articleRows = (await reqToPromise(articles.getAll()).catch(() => [])) || [];
  let articlesTotal = 0;
  let articlesWithDoc = 0;
  for (const a of articleRows) {
    if (!a || a.deletedAt) continue;
    if (Number(a.encrypted || 0) !== 0) continue;
    articlesTotal += 1;
    if (a.docJsonStr) articlesWithDoc += 1;
  }

  const refRows = (await reqToPromise(refs.getAll()).catch(() => [])) || [];
  const urls = new Set();
  for (const r of refRows) {
    const url = String(r?.url || '');
    if (url) urls.add(url);
  }

  let mediaOk = 0;
  let mediaError = 0;
  const mediaErrorKinds = { notFound: 0, noAccess: 0, network: 0, other: 0 };
  for (const url of urls) {
    const a = await reqToPromise(assets.get(url)).catch(() => null);
    if (a?.status === 'ok') mediaOk += 1;
    if (a?.status === 'error') {
      mediaError += 1;
      const msg = String(a?.lastError || '');
      if (/\bHTTP\s+404\b/.test(msg)) mediaErrorKinds.notFound += 1;
      else if (/\bHTTP\s+(401|403)\b/.test(msg)) mediaErrorKinds.noAccess += 1;
      else if (
        /Failed to fetch/i.test(msg) ||
        /Network/i.test(msg) ||
        /timeout/i.test(msg) ||
        /ERR_/i.test(msg)
      )
        mediaErrorKinds.network += 1;
      else mediaErrorKinds.other += 1;
    }
  }
  const mediaTotal = urls.size;
  await txDone(tx);

  return {
    articles: { total: articlesTotal, withDoc: articlesWithDoc },
    media: { total: mediaTotal, ok: mediaOk, error: mediaError, errorKinds: mediaErrorKinds },
  };
}
