import { fetchArticle, saveArticleDocJson } from '../api.js?v=11';
import { updateCachedDocJson } from '../offline/cache.js';

const OUTLINE_QUEUE_KEY = 'ttree_outline_autosave_queue_docjson_v1';
const DEBUG_KEY = 'ttree_debug_quick_notes_v1';

function debugEnabled() {
  try {
    return window?.localStorage?.getItem?.(DEBUG_KEY) === '1';
  } catch {
    return false;
  }
}
function dlog(...args) {
  try {
    if (!debugEnabled()) return;
    // eslint-disable-next-line no-console
    console.log('[quick-notes][queued]', ...args);
  } catch {
    // ignore
  }
}

function readQueue() {
  try {
    const raw = window.localStorage.getItem(OUTLINE_QUEUE_KEY) || '';
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeQueue(queue) {
  try {
    window.localStorage.setItem(OUTLINE_QUEUE_KEY, JSON.stringify(queue || {}));
  } catch {
    // ignore
  }
}

export function readQueuedInboxDocJson() {
  const queue = readQueue();
  const entry = queue && typeof queue === 'object' ? queue.inbox : null;
  if (!entry || !entry.docJson || typeof entry.docJson !== 'object') return null;
  return { docJson: entry.docJson, queuedAt: Number(entry.queuedAt || 0) || 0 };
}

export function clearQueuedInboxDocJson() {
  const queue = readQueue();
  if (!queue || typeof queue !== 'object') return;
  if (!Object.prototype.hasOwnProperty.call(queue, 'inbox')) return;
  delete queue.inbox;
  writeQueue(queue);
}

export async function syncQueuedInboxToServer() {
  const queued = readQueuedInboxDocJson();
  if (!queued || !queued.docJson) return { status: 'empty' };
  if (typeof navigator !== 'undefined' && navigator && navigator.onLine === false) return { status: 'offline' };

  // Make sure inbox exists on server and pick freshest base for conflict safety.
  const inbox = await fetchArticle('inbox', { metaTimeoutMs: 600, cacheTimeoutMs: 200 });
  const serverUpdatedAtMs = Date.parse(inbox?.updatedAt || '') || 0;
  if (queued.queuedAt && serverUpdatedAtMs && queued.queuedAt < serverUpdatedAtMs) {
    // Queued draft is older than server; do not override. Just clear it.
    clearQueuedInboxDocJson();
    dlog('skip.stale', { queuedAt: queued.queuedAt, serverUpdatedAtMs });
    return { status: 'stale_cleared' };
  }

  const nowIso = new Date().toISOString();
  const saveRes = await saveArticleDocJson('inbox', queued.docJson, { createVersionIfStaleHours: 12 });
  try {
    await updateCachedDocJson('inbox', queued.docJson, nowIso);
  } catch {
    // ignore
  }
  if (saveRes && saveRes.status === 'queued') {
    dlog('queued', saveRes);
    return { status: 'queued' };
  }

  clearQueuedInboxDocJson();
  dlog('synced', { updatedAt: nowIso });
  return { status: 'synced' };
}

