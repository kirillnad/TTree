import { fetchArticle, saveArticleDocJson } from '../api.js?v=12';
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

function extractOutlineSections(docJson) {
  try {
    const content = Array.isArray(docJson?.content) ? docJson.content : [];
    return content.filter((n) => n && n.type === 'outlineSection' && n.attrs && n.attrs.id);
  } catch {
    return [];
  }
}

function mergeQueuedIntoServerDocJson(serverDocJson, queuedDocJson) {
  const server = serverDocJson && typeof serverDocJson === 'object' ? serverDocJson : { type: 'doc', content: [] };
  const queued = queuedDocJson && typeof queuedDocJson === 'object' ? queuedDocJson : { type: 'doc', content: [] };

  const serverSections = extractOutlineSections(server);
  const queuedSections = extractOutlineSections(queued);
  const serverIds = new Set(serverSections.map((s) => String(s.attrs.id)));

  const toAdd = [];
  for (const s of queuedSections) {
    const id = String(s?.attrs?.id || '');
    if (!id) continue;
    if (serverIds.has(id)) continue;
    toAdd.push(s);
  }

  if (!toAdd.length) return { docJson: server, added: 0 };
  const next = {
    ...server,
    type: server.type || 'doc',
    content: [...toAdd, ...(Array.isArray(server.content) ? server.content : [])],
  };
  return { docJson: next, added: toAdd.length };
}

async function fetchInboxFromServerDirect() {
  const resp = await fetch('/api/articles/inbox?include_history=0', { method: 'GET', credentials: 'include' });
  if (resp.status === 401 || resp.status === 403) {
    const err = new Error('auth');
    err.status = resp.status;
    throw err;
  }
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}`);
  }
  return resp.json();
}

export async function refreshInboxCacheFromServer() {
  if (typeof navigator !== 'undefined' && navigator && navigator.onLine === false) return { status: 'offline' };
  const inbox = await fetchInboxFromServerDirect();
  const nowIso = new Date().toISOString();
  try {
    if (inbox?.docJson && typeof inbox.docJson === 'object') {
      await updateCachedDocJson('inbox', inbox.docJson, nowIso);
    }
  } catch {
    // ignore
  }
  return { status: 'refreshed', updatedAt: inbox?.updatedAt || null, docJson: inbox?.docJson || null };
}

export async function syncQueuedInboxToServer() {
  const queued = readQueuedInboxDocJson();
  if (!queued || !queued.docJson) return { status: 'empty' };
  if (typeof navigator !== 'undefined' && navigator && navigator.onLine === false) return { status: 'offline' };

  // Always merge into the freshest server state (never overwrite the whole inbox).
  // This prevents losing notes when multiple devices create quick notes.
  const inbox = await fetchInboxFromServerDirect().catch(async (err) => {
    // Fallback: use offline-first fetch if direct fetch fails for some reason.
    dlog('server.fetch.failed', { message: err?.message || String(err || 'error') });
    return await fetchArticle('inbox', { metaTimeoutMs: 2000, cacheTimeoutMs: 400 });
  });

  const serverDocJson = inbox?.docJson && typeof inbox.docJson === 'object' ? inbox.docJson : { type: 'doc', content: [] };
  const merged = mergeQueuedIntoServerDocJson(serverDocJson, queued.docJson);
  if (!merged.added) {
    clearQueuedInboxDocJson();
    dlog('skip.noChanges', null);
    return { status: 'no_changes_cleared' };
  }

  const nowIso = new Date().toISOString();
  const saveRes = await saveArticleDocJson('inbox', merged.docJson, { createVersionIfStaleHours: 12 });
  try {
    await updateCachedDocJson('inbox', merged.docJson, nowIso);
  } catch {
    // ignore
  }
  if (saveRes && saveRes.status === 'queued') {
    dlog('queued', saveRes);
    return { status: 'queued', added: merged.added };
  }

  clearQueuedInboxDocJson();
  dlog('synced', { updatedAt: nowIso, added: merged.added });
  return { status: 'synced', added: merged.added };
}
