import { enqueueOp } from '../offline/outbox.js';
import { updateCachedDocJson } from '../offline/cache.js';

const PENDING_KEY = 'ttree_pending_quick_notes_v1';
const OUTLINE_SECTION_SEQ_KEY = 'ttree_outline_section_seq_v1';

function uuid() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function nowIso() {
  return new Date().toISOString();
}

export function readPendingQuickNotes() {
  try {
    const raw = window?.localStorage?.getItem?.(PENDING_KEY) || '';
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
}

function writePendingQuickNotes(items) {
  try {
    window?.localStorage?.setItem?.(PENDING_KEY, JSON.stringify(Array.isArray(items) ? items : []));
  } catch {
    // ignore
  }
}

export function addPendingQuickNote(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  const sectionId = uuid();
  const note = { id: sectionId, sectionId, createdAt: nowIso(), text: trimmed };
  const items = readPendingQuickNotes();
  items.unshift(note); // newest first
  writePendingQuickNotes(items);
  return note;
}

export function removePendingQuickNoteBySectionId(sectionId) {
  const sid = String(sectionId || '').trim();
  if (!sid) return false;
  const items = readPendingQuickNotes();
  const next = items.filter((n) => String(n?.sectionId || n?.id || '') !== sid);
  if (next.length === items.length) return false;
  writePendingQuickNotes(next);
  return true;
}

function buildParagraphContentFromPlainText(text) {
  const t = String(text || '').trim();
  const lines = t.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line) out.push({ type: 'text', text: line });
    if (i !== lines.length - 1) out.push({ type: 'hardBreak' });
  }
  return out.length ? out : null;
}

export function buildOutlineSectionFromPlainText({ sectionId, text } = {}) {
  const sid = String(sectionId || '').trim();
  if (!sid) return null;
  const content = buildParagraphContentFromPlainText(text);
  return {
    type: 'outlineSection',
    attrs: { id: sid, collapsed: false },
    content: [
      { type: 'outlineHeading', content: [] },
      { type: 'outlineBody', content: [content ? { type: 'paragraph', content } : { type: 'paragraph' }] },
      { type: 'outlineChildren', content: [] },
    ],
  };
}

export function overlayPendingQuickNotesIntoInboxDocJson(docJson, pendingNotes) {
  const base = docJson && typeof docJson === 'object' ? docJson : { type: 'doc', content: [] };
  const baseContent = Array.isArray(base.content) ? base.content : [];
  const existingIds = new Set(
    baseContent
      .filter((n) => n && n.type === 'outlineSection' && n.attrs && n.attrs.id)
      .map((n) => String(n.attrs.id)),
  );

  const pending = Array.isArray(pendingNotes) ? pendingNotes : [];
  if (!pending.length) return { docJson: base, added: 0 };

  const toAdd = [];
  for (const n of pending) {
    const sid = String(n?.sectionId || n?.id || '').trim();
    if (!sid) continue;
    if (existingIds.has(sid)) continue;
    const sec = buildOutlineSectionFromPlainText({ sectionId: sid, text: n?.text || '' });
    if (sec) toAdd.push(sec);
  }

  if (!toAdd.length) return { docJson: base, added: 0 };
  return {
    docJson: { ...base, type: base.type || 'doc', content: [...toAdd, ...baseContent] },
    added: toAdd.length,
  };
}

function getNextSectionSeq(articleId, sectionId) {
  try {
    const aid = String(articleId || '').trim();
    const sid = String(sectionId || '').trim();
    if (!aid || !sid) return 1;
    const raw = window.localStorage.getItem(OUTLINE_SECTION_SEQ_KEY) || '';
    const parsed = raw ? JSON.parse(raw) : {};
    const byArticle = parsed && typeof parsed === 'object' ? parsed : {};
    const row = (byArticle[aid] && typeof byArticle[aid] === 'object' ? byArticle[aid] : {}) || {};
    const current = Number(row[sid] || 0) || 0;
    const next = current + 1;
    row[sid] = next;
    byArticle[aid] = row;
    window.localStorage.setItem(OUTLINE_SECTION_SEQ_KEY, JSON.stringify(byArticle));
    return next;
  } catch {
    return Date.now();
  }
}

export async function enqueuePendingQuickNotesForSync() {
  const pending = readPendingQuickNotes();
  if (!pending.length) return { status: 'empty' };

  // Server inserts missing inbox sections at the top; flush oldest→newest so newest ends up first.
  const ordered = pending
    .slice()
    .sort((a, b) => Date.parse(String(a?.createdAt || '')) - Date.parse(String(b?.createdAt || '')));

  let enqueued = 0;
  for (const n of ordered) {
    const sid = String(n?.sectionId || n?.id || '').trim();
    const text = String(n?.text || '').trim();
    if (!sid || !text) continue;
    const section = buildOutlineSectionFromPlainText({ sectionId: sid, text });
    if (!section) continue;
    const headingJson = section.content?.[0] || { type: 'outlineHeading', content: [] };
    const bodyJson = section.content?.[1] || { type: 'outlineBody', content: [{ type: 'paragraph' }] };
    const seq = getNextSectionSeq('inbox', sid);
    await enqueueOp('section_upsert_content', {
      articleId: 'inbox',
      payload: { sectionId: sid, headingJson, bodyJson, seq, opId: sid },
      coalesceKey: `content:inbox:${sid}`,
    });
    enqueued += 1;
  }

  return { status: 'enqueued', count: enqueued };
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
