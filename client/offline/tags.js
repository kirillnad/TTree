import { getOfflineDbReady } from './index.js';
import { reqToPromise, txDone } from './idb.js';

let loaded = false;
let loadPromise = null;
let refreshTimer = null;

const globalTagsIndex = {
  counts: new Map(), // tagKey -> count
  labelByKey: new Map(), // tagKey -> label
};

function setFromRows(rows) {
  globalTagsIndex.counts = new Map();
  globalTagsIndex.labelByKey = new Map();
  for (const row of rows || []) {
    const key = String(row?.key || '').trim();
    if (!key) continue;
    const count = Number(row?.count || 0) || 0;
    const label = String(row?.label || key);
    globalTagsIndex.counts.set(key, count);
    globalTagsIndex.labelByKey.set(key, label);
  }
  loaded = true;
}

async function readAllTags(db) {
  const tx = db.transaction(['tags_global'], 'readonly');
  const store = tx.objectStore('tags_global');
  const rows = await reqToPromise(store.getAll()).catch(() => []);
  await txDone(tx);
  return Array.isArray(rows) ? rows : [];
}

export function getGlobalTagsIndexSnapshot() {
  return globalTagsIndex;
}

export function ensureGlobalTagsIndexLoaded() {
  if (loaded) return;
  if (loadPromise) return;
  loadPromise = (async () => {
    try {
      const db = await getOfflineDbReady();
      const rows = await readAllTags(db);
      setFromRows(rows);
    } catch {
      // ignore
    } finally {
      loadPromise = null;
    }
  })();
}

export function markGlobalTagsIndexStale() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refreshGlobalTagsIndex().catch(() => {});
  }, 800);
}

export async function refreshGlobalTagsIndex() {
  try {
    const db = await getOfflineDbReady();
    const rows = await readAllTags(db);
    setFromRows(rows);
  } catch {
    // ignore
  }
}

