import { state } from '../state.js';
import { refs } from '../refs.js';
import { showToast, showPersistentToast, hideToast } from '../toast.js';
import { extractBlockSections } from '../block.js';
import { showImagePreview } from '../modal.js';
import {
  replaceArticleBlocksTree,
  updateArticleDocJson,
  saveArticleDocJson,
  generateOutlineTitle,
  proofreadOutlineHtml,
  fetchArticlesIndex,
  uploadImageFile,
  uploadFileToYandexDisk,
} from '../api.js';
import { encryptBlockTree } from '../encryption.js';
import { hydrateUndoRedoFromArticle } from '../undo.js';
import { updateCachedDocJson } from '../offline/cache.js';
import { enqueueOp } from '../offline/outbox.js';
import { putPendingUpload, deletePendingUpload, listPendingUploads, markPendingUploadError } from '../offline/uploads.js';
import { navigate, routing } from '../routing.js';
import { OUTLINE_ALLOWED_LINK_PROTOCOLS } from './linkProtocols.js';
import { parseMarkdownOutlineSections, buildOutlineSectionTree } from './structuredPaste.js';

let mounted = false;
let tiptap = null;
let outlineEditorInstance = null;
let mountPromise = null;
let autosaveTimer = null;
let autosaveInFlight = false;
let outlineLastSavedAt = null;
let lastActiveSectionId = null;
const pendingUploadObjectUrls = new Map(); // token -> objectUrl
const committedSectionIndexText = new Map();
const dirtySectionIds = new Set();
let docDirty = false;
let onlineHandlerAttached = false;
let outlineParseHtmlToNodes = null;
let outlineGenerateHTML = null;
let outlineHtmlExtensions = null;
let outlineTableApi = {
  TableMap: null,
  CellSelection: null,
  moveTableColumn: null,
  moveTableRow: null,
  addRowBefore: null,
  addRowAfter: null,
  deleteRow: null,
  addColumnBefore: null,
  addColumnAfter: null,
  deleteColumn: null,
  toggleHeaderRow: null,
  toggleHeaderColumn: null,
};
let tableResizeActive = false;
const titleGenState = new Map(); // sectionId -> { bodyHash: string, inFlight: boolean }
const PROOFREAD_RETRY_COOLDOWN_MS = 30 * 1000;
const proofreadState = new Map(); // sectionId -> { htmlHash: string, inFlight: boolean, status: 'ok'|'error', lastAttemptAtMs: number }
let outlineToolbarCleanup = null;
let outlineEditModeKey = null;
let dropGuardCleanup = null;
let outlineArticleId = null;
let outlineActiveTagKey = null;
let outlineSetActiveTagKey = null;
let outlineTagsIndex = {
  counts: new Map(), // tagKey -> count
  labelByKey: new Map(), // tagKey -> display label
  sectionIdsByKey: new Map(), // tagKey -> Set(sectionId)
  sectionPosById: new Map(), // sectionId -> pos
};
let outlineSelectionMode = false;
let outlineSelectedSectionIds = new Set();
const OUTLINE_STRUCTURE_SNAPSHOT_DEBOUNCE_MS = 650;
let lastActiveSnapshotMemo = { articleId: null, sectionId: null, collapsed: null };

const OUTLINE_SECTION_CLIPBOARD_KEY = 'ttree_outline_section_clipboard_v1';
const OUTLINE_TABLE_COLUMN_CLIPBOARD_KEY = 'ttree_outline_table_column_clipboard_v1';
const PENDING_UPLOAD_IMG_PREFIX = 'pending-attachment:';

function findImagePosByUploadToken(doc, token) {
  let found = null;
  const t = String(token || '').trim();
  if (!doc || !t) return null;
  doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node?.type?.name !== 'image') return;
    if (String(node.attrs?.uploadToken || '') !== t) return;
    found = pos;
  });
  return found;
}

function revokePendingUploadObjectUrl(token) {
  const t = String(token || '').trim();
  if (!t) return;
  const url = pendingUploadObjectUrls.get(t) || null;
  if (!url) return;
  pendingUploadObjectUrls.delete(t);
  try {
    URL.revokeObjectURL(url);
  } catch {
    // ignore
  }
}

function normalizeDocJsonForSave(docJson) {
  try {
    if (!docJson || typeof docJson !== 'object') return docJson;
    const root =
      typeof structuredClone === 'function' ? structuredClone(docJson) : JSON.parse(JSON.stringify(docJson));
    const visit = (node) => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'image' && node.attrs && typeof node.attrs === 'object') {
        const token = String(node.attrs.uploadToken || '').trim();
        const src = String(node.attrs.src || '');
        if (token && src.startsWith('blob:')) {
          node.attrs = { ...node.attrs, src: `${PENDING_UPLOAD_IMG_PREFIX}${token}` };
        }
      }
      const content = node.content;
      if (Array.isArray(content)) content.forEach(visit);
    };
    visit(root);
    return root;
  } catch {
    return docJson;
  }
}

async function hydratePendingImagesFromIdbForArticle(articleId) {
  try {
    if (!outlineEditorInstance || outlineEditorInstance.isDestroyed) return;
    const aid = String(articleId || '').trim();
    if (!aid) return;
    const pending = await listPendingUploads({ articleId: aid, limit: 200 }).catch(() => []);
    if (!pending.length) return;
    const byToken = new Map();
    for (const row of pending) {
      const t = String(row?.token || '').trim();
      if (!t) continue;
      if (row?.kind && String(row.kind) !== 'image') continue;
      if (row?.blob) byToken.set(t, row.blob);
    }
    if (!byToken.size) return;

    const { state: pmState, view } = outlineEditorInstance;
    let tr = pmState.tr;
    let changed = false;

    pmState.doc.descendants((node, pos) => {
      if (node?.type?.name !== 'image') return;
      const token = String(node.attrs?.uploadToken || '').trim();
      const src = String(node.attrs?.src || '');
      const tokenFromSrc =
        src.startsWith(PENDING_UPLOAD_IMG_PREFIX) ? src.slice(PENDING_UPLOAD_IMG_PREFIX.length).trim() : '';
      const t = token || tokenFromSrc;
      if (!t) return;
      const blob = byToken.get(t);
      if (!blob) return;
      // Note: blob: URLs do not survive reload. If we have a token+blob in IDB, always re-hydrate.
      let url = pendingUploadObjectUrls.get(t) || null;
      if (!url) {
        try {
          url = URL.createObjectURL(blob);
          pendingUploadObjectUrls.set(t, url);
        } catch {
          url = null;
        }
      }
      if (!url) return;
      const nextAttrs = { ...node.attrs, src: url, uploadToken: t };
      tr = tr.setNodeMarkup(pos, undefined, nextAttrs);
      changed = true;
    });

    if (changed) {
      tr = tr.setMeta(OUTLINE_ALLOW_META, true);
      view.dispatch(tr);
    }
  } catch {
    // ignore
  }
}

async function flushPendingImageUploadsForArticle(articleId) {
  try {
    if (!navigator.onLine) return false;
    if (!outlineEditorInstance || outlineEditorInstance.isDestroyed) return false;
    const aid = String(articleId || '').trim();
    if (!aid) return false;
    const pending = await listPendingUploads({ articleId: aid, limit: 50 }).catch(() => []);
    if (!pending.length) return false;
    let didAny = false;
    for (const row of pending) {
      const token = String(row?.token || '').trim();
      if (!token) continue;
      if (row?.kind && String(row.kind) !== 'image') continue;
      const blob = row?.blob || null;
      if (!blob) continue;
      try {
        const file =
          blob instanceof File
            ? blob
            : new File([blob], row?.fileName || 'image', { type: row?.mime || blob.type || 'application/octet-stream' });
        const res = await uploadImageFile(file);
        const url = String(res?.url || '').trim();
        if (!url) throw new Error('Upload failed');

        // Update editor doc: replace the image src wherever this token exists.
        try {
          const { state: pmState, view } = outlineEditorInstance;
          const pos = findImagePosByUploadToken(pmState.doc, token);
          if (typeof pos === 'number') {
            const node = pmState.doc.nodeAt(pos);
            if (node?.type?.name === 'image') {
              const nextAttrs = {
                ...node.attrs,
                src: url,
                uploadToken: null,
                title: String(node.attrs?.title || '').replace(/\s*\(ошибка загрузки\)\s*$/i, '').trim(),
              };
              let tr = pmState.tr.setNodeMarkup(pos, undefined, nextAttrs);
              tr = tr.setMeta(OUTLINE_ALLOW_META, true);
              view.dispatch(tr);
            }
          }
        } catch {
          // ignore
        }

        revokePendingUploadObjectUrl(token);
        await deletePendingUpload(token).catch(() => {});
        didAny = true;
      } catch (err) {
        const msg = err?.message || String(err || 'error');
        await markPendingUploadError(token, msg).catch(() => {});
      }
    }
    if (didAny) {
      // Queue a doc save so server gets the final URLs.
      try {
        scheduleAutosave({ delayMs: 350 });
      } catch {
        // ignore
      }
    }
    return didAny;
  } catch {
    return false;
  }
}

function readOutlineSectionClipboard() {
  try {
    const raw = window?.localStorage?.getItem?.(OUTLINE_SECTION_CLIPBOARD_KEY) || '';
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (!Array.isArray(parsed.sections)) return null;
    const mode = parsed.mode === 'cut' ? 'cut' : 'copy';
    return {
      mode,
      sourceArticleId: typeof parsed.sourceArticleId === 'string' ? parsed.sourceArticleId : null,
      createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : null,
      sections: parsed.sections,
    };
  } catch {
    return null;
  }
}

function writeOutlineSectionClipboard(payload) {
  try {
    if (!payload) {
      window?.localStorage?.removeItem?.(OUTLINE_SECTION_CLIPBOARD_KEY);
      return;
    }
    window?.localStorage?.setItem?.(OUTLINE_SECTION_CLIPBOARD_KEY, JSON.stringify(payload));
  } catch {
    // ignore
  }
}

function setOutlineSelectionMode(enabled) {
  outlineSelectionMode = Boolean(enabled);
  if (!outlineSelectionMode) outlineSelectedSectionIds = new Set();
  try {
    if (refs?.outlineEditor) refs.outlineEditor.classList.toggle('outline-select-mode', outlineSelectionMode);
  } catch {
    // ignore
  }
  try {
    refreshOutlineSectionSelectionUi();
  } catch {
    // ignore
  }
}

function toggleOutlineSelectedSectionId(sectionId) {
  const sid = String(sectionId || '').trim();
  if (!sid) return;
  if (outlineSelectedSectionIds.has(sid)) outlineSelectedSectionIds.delete(sid);
  else outlineSelectedSectionIds.add(sid);
  try {
    refreshOutlineSectionSelectionUi();
  } catch {
    // ignore
  }
}

function refreshOutlineSectionSelectionUi() {
  if (!refs?.outlineEditor) return;
  const btns = refs.outlineEditor.querySelectorAll('.outline-heading[data-section-id] .outline-heading__select');
  btns.forEach((btn) => {
    const heading = btn.closest('.outline-heading');
    const sid = heading?.getAttribute?.('data-section-id') || '';
    const checked = sid && outlineSelectedSectionIds.has(sid);
    btn.setAttribute('aria-checked', checked ? 'true' : 'false');
    btn.style.display = outlineSelectionMode ? 'inline-flex' : 'none';
  });
}

function collectSelectedRootSections(pmDoc, selectedIds) {
  const selected = selectedIds instanceof Set ? selectedIds : new Set();
  const roots = [];
  if (!pmDoc || !selected.size) return roots;

  const visitSection = (sectionNode, parentSelected) => {
    const sid = String(sectionNode?.attrs?.id || '').trim();
    const isSel = sid && selected.has(sid);
    if (isSel && !parentSelected) {
      roots.push({ id: sid, node: sectionNode });
      return;
    }
    const childrenNode = sectionNode?.childCount >= 3 ? sectionNode.child(2) : null;
    if (!childrenNode) return;
    try {
      childrenNode.forEach((child) => {
        if (child?.type?.name !== 'outlineSection') return;
        visitSection(child, parentSelected || isSel);
      });
    } catch {
      // ignore
    }
  };

  try {
    pmDoc.forEach((child) => {
      if (child?.type?.name !== 'outlineSection') return;
      visitSection(child, false);
    });
  } catch {
    // ignore
  }
  return roots;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function remapOutlineSectionIds(sectionJson, makeId) {
  const next = cloneJson(sectionJson);
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'outlineSection') {
      const newId = makeId();
      if (node.attrs && typeof node.attrs === 'object') node.attrs.id = newId;
      else node.attrs = { id: newId, collapsed: Boolean(node.attrs?.collapsed) };
    }
    const content = Array.isArray(node.content) ? node.content : [];
    for (const c of content) visit(c);
  };
  visit(next);
  return next;
}

async function writeTextToSystemClipboard(text) {
  const value = String(text || '');
  if (!value) return;
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
  } catch {
    // ignore → fallback
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.setAttribute('readonly', 'true');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  } catch {
    // ignore
  }
}

function buildMarkdownFromOutlineSectionNode(sectionNode, { baseLevel = 2, depth = 0 } = {}) {
  const node = sectionNode;
  if (!node || node.type?.name !== 'outlineSection') return '';
  let heading = '';
  let body = '';
  try {
    const headingNode = node.child(0);
    heading = String(headingNode?.textContent || '').trim();
  } catch {
    heading = '';
  }
  try {
    const bodyNode = node.child(1);
    body = bodyNode ? String(bodyNode.textBetween(0, bodyNode.content.size, '\n')).trimEnd() : '';
  } catch {
    body = '';
  }

  const level = Math.min(6, Math.max(1, Number(baseLevel) + Number(depth || 0)));
  const lines = [];
  if (heading) lines.push(`${'#'.repeat(level)} ${heading}`);
  if (body) lines.push(body);

  try {
    const children = node.child(2);
    if (children) {
      const childParts = [];
      children.forEach((child) => {
        if (child?.type?.name !== 'outlineSection') return;
        const t = buildMarkdownFromOutlineSectionNode(child, { baseLevel, depth: depth + 1 });
        if (t) childParts.push(t);
      });
      if (childParts.length) lines.push(childParts.join('\n\n'));
    }
  } catch {
    // ignore
  }

  return lines.filter(Boolean).join('\n\n').trim();
}

const OUTLINE_SECTION_SEQ_KEY = 'ttree_outline_section_seq_v1';

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

let structureDirty = false;
let lastStructureHash = '';
let structureSnapshotTimer = null;
let explicitlyDeletedSectionIds = new Set();

function markExplicitSectionDeletion(sectionId) {
  try {
    const sid = String(sectionId || '').trim();
    if (!sid) return;
    explicitlyDeletedSectionIds.add(sid);
  } catch {
    // ignore
  }
}

function computeOutlineStructureNodesFromDoc(pmDoc) {
  const out = [];

  const findOutlineChildrenNode = (sectionNode) => {
    try {
      if (!sectionNode || sectionNode.type?.name !== 'outlineSection') return null;
      for (let i = 0; i < sectionNode.childCount; i += 1) {
        const c = sectionNode.child(i);
        if (c?.type?.name === 'outlineChildren') return c;
      }
      return null;
    } catch {
      return null;
    }
  };

  const walkSectionList = (listNode, parentId) => {
    try {
      if (!listNode) return;
      let idx = 0;
      listNode.forEach((child) => {
        if (!child || child.type?.name !== 'outlineSection') return;
        const sid = String(child.attrs?.id || '').trim();
        if (!sid) return;
        out.push({
          sectionId: sid,
          parentId: parentId || null,
          position: idx,
          collapsed: Boolean(child.attrs?.collapsed),
        });
        idx += 1;
        const children = findOutlineChildrenNode(child);
        if (children) walkSectionList(children, sid);
      });
    } catch {
      // ignore
    }
  };

  try {
    if (!pmDoc) return [];
    walkSectionList(pmDoc, null);
  } catch {
    return [];
  }
  return out;
}

function computeOutlineStructureHash(pmDoc) {
  try {
    const nodes = computeOutlineStructureNodesFromDoc(pmDoc);
    // Deterministic signature: parentId|pos|id|collapsed joined.
    return nodes.map((n) => `${n.parentId || ''}|${n.position}|${n.sectionId}|${n.collapsed ? 1 : 0}`).join('\n');
  } catch {
    return '';
  }
}

function collectAllOutlineSectionPositions(pmDoc) {
  const out = [];
  try {
    if (!pmDoc) return out;
    pmDoc.descendants((node, pos) => {
      if (node?.type?.name !== 'outlineSection') return;
      out.push(pos);
    });
  } catch {
    // ignore
  }
  return out;
}

function toggleAllOutlineSectionsCollapsed(editor, collapsed) {
  try {
    if (!editor || editor.isDestroyed) return false;
    const next = Boolean(collapsed);
    return editor.commands.command(({ state: pmState, dispatch }) => {
      const positions = collectAllOutlineSectionPositions(pmState.doc);
      if (!positions.length) return false;

      let tr = pmState.tr;
      for (const pos of positions) {
        const node = tr.doc.nodeAt(pos);
        if (!node || node.type?.name !== 'outlineSection') continue;
        if (Boolean(node.attrs?.collapsed) === next) continue;
        tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, collapsed: next });
      }

      tr = tr.setMeta(OUTLINE_ALLOW_META, true);
      try {
        if (next && outlineEditModeKey) {
          const st = outlineEditModeKey.getState(pmState) || {};
          if (st.editingSectionId) {
            tr = tr.setMeta(outlineEditModeKey, { type: 'exit' });
          }
        }
      } catch {
        // ignore
      }

      // When collapsing everything, ensure selection is not inside a now-hidden body.
      try {
        if (next && TextSelection) {
          const sectionPos = findOutlineSectionPosAtSelection(pmState.doc, pmState.selection.$from);
          const focusPos = typeof sectionPos === 'number' ? sectionPos : positions[0];
          const focusNode = tr.doc.nodeAt(focusPos);
          if (focusNode?.type?.name === 'outlineSection') {
            const heading = focusNode.child(0);
            const headingStart = focusPos + 1;
            const headingEnd = headingStart + heading.nodeSize - 1;
            tr = tr.setSelection(TextSelection.near(tr.doc.resolve(headingEnd), -1));
          }
        }
      } catch {
        // ignore
      }

      dispatch(tr.scrollIntoView());
      return true;
    });
  } catch {
    return false;
  }
}

function scheduleStructureSnapshot({ articleId, editor } = {}) {
  try {
    const aid = String(articleId || '').trim();
    if (!aid) return;
    if (!editor) return;
    structureDirty = true;
    if (structureSnapshotTimer) clearTimeout(structureSnapshotTimer);
    structureSnapshotTimer = setTimeout(() => {
      structureSnapshotTimer = null;
      try {
        if (!structureDirty) return;
        const pmDoc = editor.state?.doc;
        const nodes = computeOutlineStructureNodesFromDoc(pmDoc);
        if (!nodes.length) return;
        void enqueueOp('structure_snapshot', {
          articleId: aid,
          payload: { nodes },
          coalesceKey: `structure:${aid}`,
        });
        structureDirty = false;
      } catch {
        // ignore
      }
    }, OUTLINE_STRUCTURE_SNAPSHOT_DEBOUNCE_MS);
  } catch {
    // ignore
  }
}
const OUTLINE_ALLOW_META = 'outlineAllowMutation';
let lastReadOnlyToastAt = 0;

const OUTLINE_MD_TABLE_DEBUG_KEY = 'ttree_outline_debug_md_table';
function mdTableDebugEnabled() {
  try {
    return window?.localStorage?.getItem?.(OUTLINE_MD_TABLE_DEBUG_KEY) === '1';
  } catch {
    return false;
  }
}
function mdTableDebug(...args) {
  try {
    if (!mdTableDebugEnabled()) return;
    // eslint-disable-next-line no-console
    console.log('[outline][md-table]', ...args);
  } catch {
    // ignore
  }
}

const PERF_KEY = 'ttree_profile_v1';
function perfEnabled() {
  try {
    return window?.localStorage?.getItem?.(PERF_KEY) === '1';
  } catch {
    return false;
  }
}
function perfLog(label, data = {}) {
  try {
    if (!perfEnabled()) return;
    // eslint-disable-next-line no-console
    console.log('[perf][outline]', label, data);
  } catch {
    // ignore
  }
}

const OUTLINE_PROOFREAD_DEBUG_KEY = 'ttree_outline_debug_proofread_v1';
function proofreadDebugEnabled() {
  try {
    return window?.localStorage?.getItem?.(OUTLINE_PROOFREAD_DEBUG_KEY) === '1';
  } catch {
    return false;
  }
}
function proofreadDebug(label, data = {}) {
  try {
    if (!proofreadDebugEnabled()) return;
    // eslint-disable-next-line no-console
    console.log('[outline][proofread]', label, data);
  } catch {
    // ignore
  }
}

function normalizeTagLabel(raw) {
  const label = String(raw || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!label) return null;
  if (label.length > 60) return label.slice(0, 60);
  return label;
}

function normalizeTagKey(label) {
  return String(label || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function computeOutlineTagsIndex(pmDoc, tagNodeTypeName = 'tag') {
  const counts = new Map();
  const labelByKey = new Map();
  const sectionIdsByKey = new Map();
  const sectionPosById = new Map();

  if (!pmDoc) {
    return { counts, labelByKey, sectionIdsByKey, sectionPosById };
  }

  pmDoc.descendants((node, pos) => {
    if (node?.type?.name !== 'outlineSection') return;
    const sectionId = String(node.attrs?.id || '');
    if (sectionId) sectionPosById.set(sectionId, pos);

    const localKeys = new Set();
    const scan = (root) => {
      root?.descendants?.((n) => {
        if (n?.type?.name !== tagNodeTypeName) return;
        const label = normalizeTagLabel(n.attrs?.label || n.textContent || '');
        if (!label) return;
        const key = normalizeTagKey(n.attrs?.key || label);
        if (!key) return;
        counts.set(key, (counts.get(key) || 0) + 1);
        labelByKey.set(key, key);
        localKeys.add(key);
      });
    };
    try {
      scan(node.child(0)); // heading
      scan(node.child(1)); // body
    } catch {
      // ignore
    }
    if (sectionId) {
      for (const key of localKeys) {
        if (!sectionIdsByKey.has(key)) sectionIdsByKey.set(key, new Set());
        sectionIdsByKey.get(key).add(sectionId);
      }
    }
    return false;
  });

  return { counts, labelByKey, sectionIdsByKey, sectionPosById };
}

function renderOutlineTagsBar() {
  const el = refs?.outlineTagsBar;
  if (!el) return;
  const entries = Array.from(outlineTagsIndex.counts.entries())
    .map(([key, count]) => ({ key, label: outlineTagsIndex.labelByKey.get(key) || key, count }))
    .filter((x) => x.key && x.count > 0)
    .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.label.localeCompare(b.label)));

  if (!entries.length) {
    el.innerHTML = '';
    el.classList.add('hidden');
    return;
  }

  el.classList.remove('hidden');
  el.innerHTML = entries
    .map((t) => {
      const pressed = outlineActiveTagKey && outlineActiveTagKey === t.key ? 'true' : 'false';
      const safeLabel = escapeHtml(t.label);
      return `<button type="button" class="outline-tag-pill" data-tag-key="${escapeHtml(t.key)}" aria-pressed="${pressed}">${safeLabel} <span class="outline-tag-pill__count">(${t.count})</span></button>`;
    })
    .join('');
}

function refreshOutlineTagsFromEditor() {
  if (!outlineEditorInstance) return;
  outlineTagsIndex = computeOutlineTagsIndex(outlineEditorInstance.state.doc, 'tag');
  if (outlineActiveTagKey && !outlineTagsIndex.counts.has(outlineActiveTagKey)) {
    outlineActiveTagKey = null;
    try {
      outlineSetActiveTagKey?.(null);
    } catch {
      // ignore
    }
  }
  renderOutlineTagsBar();
}

function expandSectionsForTagKey(tagKey) {
  const key = String(tagKey || '');
  if (!key || !outlineEditorInstance) return;
  const ids = outlineTagsIndex.sectionIdsByKey.get(key);
  if (!ids || !ids.size) return;

  const positions = new Set();
  for (const sectionId of ids) {
    const pos = outlineTagsIndex.sectionPosById.get(sectionId);
    if (typeof pos !== 'number') continue;
    positions.add(pos);
    try {
      const $inside = outlineEditorInstance.state.doc.resolve(Math.min(outlineEditorInstance.state.doc.content.size, pos + 1));
      for (let d = $inside.depth; d > 0; d -= 1) {
        if ($inside.node(d)?.type?.name !== 'outlineSection') continue;
        positions.add($inside.before(d));
      }
    } catch {
      // ignore
    }
  }

  let tr = outlineEditorInstance.state.tr;
  let changed = false;
  for (const pos of positions) {
    const node = tr.doc.nodeAt(pos);
    if (!node || node.type?.name !== 'outlineSection') continue;
    if (!Boolean(node.attrs?.collapsed)) continue;
    tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, collapsed: false });
    changed = true;
  }
  if (changed) {
    tr = tr.setMeta(OUTLINE_ALLOW_META, true);
    outlineEditorInstance.view.dispatch(tr);
  }
}

function attachOutlineTagsBarHandlers({ setActiveTagKey }) {
  const el = refs?.outlineTagsBar;
  if (!el) return () => {};
  const onClick = (e) => {
    const btn = e.target?.closest?.('[data-tag-key]');
    if (!btn) return;
    const key = String(btn.getAttribute('data-tag-key') || '');
    if (!key) return;
    const next = outlineActiveTagKey === key ? null : key;
    outlineActiveTagKey = next;
    try {
      setActiveTagKey(next);
    } catch {
      // ignore
    }
    if (next) {
      expandSectionsForTagKey(next);
    }
    renderOutlineTagsBar();
  };
  el.addEventListener('click', onClick);
  return () => el.removeEventListener('click', onClick);
}

function splitMarkdownRow(line) {
  const raw = String(line || '').trim();
  if (!raw.includes('|')) return null;
  // Markdown tables often allow omitting leading/trailing pipes.
  let core = raw;
  if (core.startsWith('|')) core = core.slice(1);
  if (core.endsWith('|')) core = core.slice(0, -1);
  const parts = core.split('|').map((s) => s.trim());
  if (parts.length < 2) return null;
  // Disallow rows that are effectively not a table row (e.g. a single pipe in text)
  if (parts.every((p) => !p)) return null;
  return parts;
}

function isMarkdownSeparatorCell(cell) {
  const s = String(cell || '').trim();
  if (!s) return false;
  // allow :---:, ---:, :---, ----
  return /^:?-{3,}:?$/.test(s);
}

function parseMarkdownTableLines(lines) {
  const normalized = (Array.isArray(lines) ? lines : [])
    .map((l) => String(l || '').replace(/\r/g, '').trimEnd())
    .filter((l) => l.length > 0);
  if (normalized.length < 2) return null;

  const header = splitMarkdownRow(normalized[0]);
  const sep = splitMarkdownRow(normalized[1]);
  if (!header || !sep) return null;
  if (header.length !== sep.length) return null;
  if (!sep.every(isMarkdownSeparatorCell)) return null;

  const rows = [];
  for (let i = 2; i < normalized.length; i += 1) {
    const row = splitMarkdownRow(normalized[i]);
    if (!row) return null;
    if (row.length !== header.length) return null;
    rows.push(row);
  }

  return { header, rows };
}

function parseMarkdownTableRowsOnly(lines) {
  const normalized = (Array.isArray(lines) ? lines : [])
    .map((l) => String(l || '').replace(/\r/g, '').trimEnd())
    .filter((l) => l.length > 0);
  if (normalized.length < 1) return null;
  const first = splitMarkdownRow(normalized[0]);
  if (!first) return null;
  const cols = first.length;
  if (cols < 2) return null;
  const rows = [first];
  for (let i = 1; i < normalized.length; i += 1) {
    const row = splitMarkdownRow(normalized[i]);
    if (!row) break;
    if (row.length !== cols) break;
    // If second line is a separator, this is actually a proper header table, let strict parser handle it.
    if (i === 1 && row.every(isMarkdownSeparatorCell)) return null;
    rows.push(row);
  }
  // Heuristic: avoid converting random text with one pipe.
  const nonEmptyCells = rows.flat().filter((c) => String(c || '').trim().length > 0).length;
  if (nonEmptyCells < 2) return null;
  return { rows };
}

function normalizeLinesForMarkdownTable(text) {
  const lines = String(text || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => String(l || '').trimEnd());
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines;
}

function buildTableNodeFromMarkdown(schema, table) {
  if (!schema || !table) return null;
  const { header, rows, withHeader } = table;
  const tableType = schema.nodes.table;
  const rowType = schema.nodes.tableRow;
  const cellType = schema.nodes.tableCell;
  const headerType = schema.nodes.tableHeader;
  const paragraphType = schema.nodes.paragraph;
  // Важно: schema.text использует `this`, поэтому нельзя выдёргивать его в переменную без bind.
  if (!tableType || !rowType || !cellType || !headerType || !paragraphType || typeof schema.text !== 'function') return null;

  const cellPara = (text) => paragraphType.create({}, text ? [schema.text(String(text))] : []);
  const mkRowCells = (row, useHeader) =>
    row.map((cell) => (useHeader ? headerType : cellType).create({}, [cellPara(cell)]));
  const mkRow = (row, useHeader) => rowType.create({}, mkRowCells(row, useHeader));

  const allRows = [];
  if (withHeader && Array.isArray(header) && header.length) {
    allRows.push(mkRow(header, true));
  }
  (Array.isArray(rows) ? rows : []).forEach((row) => allRows.push(mkRow(row, false)));
  if (!allRows.length) return null;
  return tableType.create({}, allRows);
}

function tryMergeWithPreviousTableOnBackspace(pmState, dispatch) {
  try {
    const sel = pmState?.selection;
    const $from = sel?.$from;
    if (!sel?.empty || !$from) {
      outlineDebug('table.merge.skip', { reason: 'no-cursor' });
      return false;
    }

    // Must be at the start of a paragraph inside the first cell of a table.
    if ($from.parent?.type?.name !== 'paragraph') return false;
    if ($from.parentOffset !== 0) {
      outlineDebug('table.merge.skip', { reason: 'not-at-paragraph-start' });
      return false;
    }

    let tableDepth = null;
    let rowDepth = null;
    let cellDepth = null;
    for (let d = $from.depth; d > 0; d -= 1) {
      const name = $from.node(d)?.type?.name;
      if (!cellDepth && (name === 'tableCell' || name === 'tableHeader')) cellDepth = d;
      else if (!rowDepth && name === 'tableRow') rowDepth = d;
      else if (!tableDepth && name === 'table') tableDepth = d;
      if (tableDepth && rowDepth && cellDepth) break;
    }
    if (tableDepth == null || rowDepth == null || cellDepth == null) {
      outlineDebug('table.merge.skip', { reason: 'not-in-table' });
      return false;
    }
    const isDirectParagraphInCell = $from.depth === cellDepth + 1;
    const rowIndex = $from.index(tableDepth);
    const colIndex = $from.index(rowDepth);
    const childIndexInCell = $from.index(cellDepth);
    outlineDebug('table.merge.check', {
      parent: $from.parent?.type?.name || null,
      parentOffset: $from.parentOffset,
      tableDepth,
      rowDepth,
      cellDepth,
      isDirectParagraphInCell,
      rowIndex,
      colIndex,
      childIndexInCell,
    });
    if (!isDirectParagraphInCell) {
      outlineDebug('table.merge.skip', { reason: 'paragraph-not-direct-child-of-cell' });
      return false;
    }
    if (rowIndex !== 0 || colIndex !== 0 || childIndexInCell !== 0) {
      outlineDebug('table.merge.skip', {
        reason: 'not-in-first-cell',
        rowIndex,
        colIndex,
        childIndexInCell,
      });
      return false;
    }

    const tablePos = $from.before(tableDepth);
    const tableNode = pmState.doc.nodeAt(tablePos);
    if (!tableNode || tableNode.type?.name !== 'table') {
      outlineDebug('table.merge.skip', { reason: 'no-current-table', tablePos });
      return false;
    }

    const $table = pmState.doc.resolve(tablePos);
    const idx = $table.index();
    const parent = $table.parent;
    if (!parent || idx <= 0) {
      outlineDebug('table.merge.skip', { reason: 'no-prev-sibling', idx, parent: parent?.type?.name || null });
      return false;
    }

    // Find previous meaningful sibling: allow skipping empty paragraphs between tables.
    let prevNode = null;
    let prevIdx = idx - 1;
    while (prevIdx >= 0) {
      const cand = parent.child(prevIdx);
      if (cand?.type?.name === 'paragraph' && !String(cand.textContent || '').trim()) {
        prevIdx -= 1;
        continue;
      }
      prevNode = cand;
      break;
    }
    if (!prevNode || prevNode.type?.name !== 'table') {
      outlineDebug('table.merge.skip', { reason: 'no-prev-table' });
      return false;
    }

    // Only merge tables with identical row schemas (same number of cells in each row).
    const prevFirstRow = prevNode.childCount ? prevNode.child(0) : null;
    const curFirstRow = tableNode.childCount ? tableNode.child(0) : null;
    if (!prevFirstRow || !curFirstRow) {
      outlineDebug('table.merge.skip', { reason: 'missing-rows' });
      return false;
    }
    if (prevFirstRow.childCount !== curFirstRow.childCount) {
      outlineDebug('table.merge.skip', {
        reason: 'different-columns',
        prevCols: prevFirstRow.childCount,
        curCols: curFirstRow.childCount,
      });
      return false;
    }
    const cols = prevFirstRow.childCount;
    const rowHasCols = (row, expected) => {
      try {
        return row?.type?.name === 'tableRow' && row.childCount === expected;
      } catch {
        return false;
      }
    };
    for (let r = 0; r < prevNode.childCount; r += 1) {
      const row = prevNode.child(r);
      if (!rowHasCols(row, cols)) {
        outlineDebug('table.merge.skip', { reason: 'prev-row-mismatch', rowIndex: r, colsExpected: cols, colsGot: row?.childCount ?? null });
        return false;
      }
    }
    for (let r = 0; r < tableNode.childCount; r += 1) {
      const row = tableNode.child(r);
      if (!rowHasCols(row, cols)) {
        outlineDebug('table.merge.skip', { reason: 'cur-row-mismatch', rowIndex: r, colsExpected: cols, colsGot: row?.childCount ?? null });
        return false;
      }
    }

    // When we skipped nodes, compute prevStart by subtracting the intervening nodeSizes too.
    let prevStart = tablePos;
    for (let i = idx - 1; i >= prevIdx; i -= 1) {
      prevStart -= parent.child(i).nodeSize;
    }
    const prevRowCount = prevNode.childCount;
    const schema = pmState.doc.type.schema;

    // Delete empty paragraphs between tables (if any), then delete current table.
    const prevEnd = prevStart + prevNode.nodeSize;
    let tr = pmState.tr;
    if (tablePos > prevEnd) tr = tr.delete(prevEnd, tablePos);
    const tablePos2 = prevEnd; // after deletion, current table shifts to directly after prev table
    tr = tr.delete(tablePos2, tablePos2 + tableNode.nodeSize);
    const prevAfter = tr.doc.nodeAt(prevStart);
    if (!prevAfter || prevAfter.type?.name !== 'table') {
      outlineDebug('table.merge.skip', { reason: 'prev-after-missing', prevStart, prevAfterType: prevAfter?.type?.name || null });
      return false;
    }

    outlineDebug('table.merge.plan', {
      idx,
      prevIdx,
      prevStart,
      prevEnd,
      tablePos,
      tablePos2,
      cols,
      prevRowCount,
      curRowCount: tableNode.childCount,
    });

    try {
      const mergedRows = prevAfter.content.append(tableNode.content);
      const mergedTable = schema.nodes.table.create(prevAfter.attrs, mergedRows, prevAfter.marks);
      tr = tr.replaceWith(prevStart, prevStart + prevAfter.nodeSize, mergedTable);
    } catch (err) {
      outlineDebug('table.merge.error', { message: String(err?.message || err || ''), stack: String(err?.stack || '') });
      return false;
    }

    // Keep cursor in the same cell (first cell of the second table), now shifted by prevRowCount.
    const mergedAfter = tr.doc.nodeAt(prevStart);
    outlineDebug('table.merge.afterReplace', {
      mergedType: mergedAfter?.type?.name || null,
      mergedRows: mergedAfter?.type?.name === 'table' ? mergedAfter.childCount : null,
    });
    try {
      const TextSelection = tiptap?.pmStateMod?.TextSelection || tiptap?.pm?.state?.TextSelection || null;
      if (mergedAfter && mergedAfter.type?.name === 'table') {
        const rowIndex = Math.min(prevRowCount, Math.max(0, mergedAfter.childCount - 1));
        const row = mergedAfter.child(rowIndex);
        if (row?.childCount) {
          const cellStart = (() => {
            let pos = prevStart + 1; // start of table content
            for (let r = 0; r < rowIndex; r += 1) pos += mergedAfter.child(r).nodeSize;
            pos += 1; // start of row content
            // first cell in row => no extra offset
            return pos;
          })();
          const posInCell = Math.min(tr.doc.content.size, cellStart + 2);
          if (TextSelection) tr = tr.setSelection(TextSelection.near(tr.doc.resolve(posInCell), 1));
        }
      }
    } catch (err) {
      outlineDebug('table.merge.selection.error', { message: String(err?.message || err || ''), stack: String(err?.stack || '') });
      // If selection failed, still try to apply merge.
    }

    tr = tr.setMeta(OUTLINE_ALLOW_META, true);
    try {
      dispatch(tr.scrollIntoView());
    } catch (err) {
      outlineDebug('table.merge.dispatch.error', { message: String(err?.message || err || ''), stack: String(err?.stack || '') });
      return false;
    }
    return true;
  } catch (err) {
    try {
      outlineDebug('table.merge.exception', { message: String(err?.message || err || ''), stack: String(err?.stack || '') });
    } catch {
      // ignore
    }
    return false;
  }
}

function tryPromoteBodyFirstLineToHeadingOnBackspace(pmState, dispatch, sectionId, TextSelection) {
  try {
    const dbg = (reason, extra = {}) => {
      try {
        if (window?.localStorage?.getItem?.('ttree_debug_outline_keys_v1') !== '1') return;
        // eslint-disable-next-line no-console
        console.log('[outline][keys]', 'bodyToHeading.skip', { reason, sectionId: sectionId || null, ...extra });
      } catch {
        // ignore
      }
    };
    const dbgStart = (extra = {}) => {
      try {
        if (window?.localStorage?.getItem?.('ttree_debug_outline_keys_v1') !== '1') return;
        // eslint-disable-next-line no-console
        console.log('[outline][keys]', 'bodyToHeading.check', { sectionId: sectionId || null, ...extra });
      } catch {
        // ignore
      }
    };
    if (!sectionId) return false;
    if (!TextSelection) {
      dbg('no-TextSelection');
      return false;
    }
    const sel = pmState?.selection;
    if (!sel?.empty) {
      dbg('selection-not-empty');
      return false;
    }
    const $from = sel.$from || null;
    if (!$from) {
      dbg('no-$from');
      return false;
    }
    dbgStart({
      from: sel.from,
      parent: $from.parent?.type?.name || null,
      parentOffset: $from.parentOffset ?? null,
    });

    const sectionPos = findSectionPosById(pmState.doc, sectionId);
    if (typeof sectionPos !== 'number') {
      dbg('section-not-found');
      return false;
    }
    const sectionNode = pmState.doc.nodeAt(sectionPos);
    if (!sectionNode || sectionNode.type?.name !== 'outlineSection') {
      dbg('not-outlineSection', { found: sectionNode?.type?.name || null });
      return false;
    }

    const headingNode = sectionNode.child(0);
    const bodyNode = sectionNode.child(1);
    if (!headingNode || headingNode.type?.name !== 'outlineHeading') {
      dbg('missing-heading', { found: headingNode?.type?.name || null });
      return false;
    }
    if (!bodyNode || bodyNode.type?.name !== 'outlineBody') {
      dbg('missing-body', { found: bodyNode?.type?.name || null });
      return false;
    }

    const headingTextRaw = String(headingNode.textContent || '').replace(/\u00a0/g, ' ');
    const headingHasText = Boolean(headingTextRaw.trim());
    const headingEndsWithSpace = /\s$/.test(headingTextRaw);

    // Must be at the very start of the FIRST block inside body.
    let bodyDepth = null;
    for (let d = $from.depth; d >= 0; d -= 1) {
      if ($from.node(d)?.type?.name === 'outlineBody') {
        bodyDepth = d;
        break;
      }
    }
    if (bodyDepth == null) {
      dbg('not-in-outlineBody', { parent: $from.parent?.type?.name || null });
      return false;
    }
    if ($from.index(bodyDepth) !== 0) {
      dbg('not-first-body-child', { index: $from.index(bodyDepth) });
      return false;
    }
    if ($from.parent?.type?.name !== 'paragraph') {
      dbg('parent-not-paragraph', { parent: $from.parent?.type?.name || null });
      return false;
    }
    if (($from.parentOffset ?? null) !== 0) {
      dbg('not-at-paragraph-start', { parentOffset: $from.parentOffset ?? null });
      return false;
    }

    const headingPos = sectionPos + 1;
    const paragraphTextStart = sel.from;
    const paragraphNode = $from.parent;

    // Find first hardBreak inside the first paragraph to define "first line".
    let offset = 0;
    let breakOffset = null;
    for (let i = 0; i < paragraphNode.childCount; i += 1) {
      const node = paragraphNode.child(i);
      if (node.type?.name === 'hardBreak') {
        breakOffset = offset;
        break;
      }
      offset += node.nodeSize;
    }

    const sliceTo = paragraphTextStart + (breakOffset == null ? paragraphNode.content.size : breakOffset);
    if (sliceTo <= paragraphTextStart) {
      dbg('empty-first-line');
      return false;
    }

    const slice = pmState.doc.slice(paragraphTextStart, sliceTo);
    if (!slice?.content || slice.content.size <= 0) {
      dbg('empty-slice');
      return false;
    }

    const deleteTo = breakOffset == null ? sliceTo : sliceTo + 1; // remove hardBreak too
    const headingContentFrom = headingPos + 1;
    const headingContentTo = headingPos + headingNode.nodeSize - 1;

    let tr = pmState.tr;
    // If heading already has content, add a separating space (unless it already ends with whitespace).
    if (headingHasText && !headingEndsWithSpace) {
      tr = tr.insertText(' ', headingContentTo);
      tr = tr.setMeta(OUTLINE_ALLOW_META, true);
    }

    const insertAt = tr.mapping.map(headingContentTo, 1);
    const caretAnchorBeforeInsert = insertAt;
    tr = tr.insert(insertAt, slice.content);

    const delFromMapped = tr.mapping.map(paragraphTextStart, 1);
    const delToMapped = tr.mapping.map(deleteTo, -1);
    tr = tr.delete(delFromMapped, delToMapped);

    // Place caret at the start of the moved text (not at the end of heading).
    try {
      tr = tr.setSelection(TextSelection.create(tr.doc, caretAnchorBeforeInsert));
    } catch {
      // ignore
    }

    tr = tr.setMeta(OUTLINE_ALLOW_META, true);
    dispatch(tr.scrollIntoView());
    return true;
  } catch (err) {
    try {
      if (window?.localStorage?.getItem?.('ttree_debug_outline_keys_v1') === '1') {
        // eslint-disable-next-line no-console
        console.log('[outline][keys]', 'bodyToHeading.error', {
          sectionId: sectionId || null,
          message: String(err?.message || err || ''),
          stack: String(err?.stack || ''),
        });
      }
    } catch {
      // ignore
    }
    return false;
  }
}

function convertMarkdownTablesInSection(pmState, sectionId) {
  try {
    if (!pmState?.doc || !sectionId) return null;
    const sectionPos = findSectionPosById(pmState.doc, sectionId);
    if (typeof sectionPos !== 'number') return null;
    const sectionNode = pmState.doc.nodeAt(sectionPos);
    if (!sectionNode) return null;

    const headingNode = sectionNode.child(0);
    const bodyNode = sectionNode.child(1);
    if (!bodyNode || bodyNode.type?.name !== 'outlineBody') return null;

    const bodyPos = sectionPos + 1 + headingNode.nodeSize;
    const bodyContentStart = bodyPos + 1;

    const replacements = [];
    let offset = 0;
    let i = 0;
    while (i < bodyNode.childCount) {
      const first = bodyNode.child(i);
      const firstPos = bodyContentStart + offset;
      if (first.type?.name !== 'paragraph') {
        offset += first.nodeSize;
        i += 1;
        continue;
      }

      const line0 = extractTextWithHardBreaks(first).trim();
      // Case 1: whole table pasted into a single paragraph with hardBreaks.
      if (line0.includes('\n') && line0.includes('|')) {
        const lines = normalizeLinesForMarkdownTable(line0);
        const parsed = parseMarkdownTableLines(lines);
        const parsedRowsOnly = !parsed ? parseMarkdownTableRowsOnly(lines) : null;
        const tableSpec = parsed
          ? { header: parsed.header, rows: parsed.rows, withHeader: true }
          : parsedRowsOnly
            ? { header: null, rows: parsedRowsOnly.rows, withHeader: false }
            : null;
        let tableNode = null;
        if (tableSpec) {
          try {
            tableNode = buildTableNodeFromMarkdown(pmState.schema, tableSpec);
          } catch (err) {
            mdTableDebug('convert: buildTableNode error (single)', {
              message: String(err?.message || err || ''),
              stack: String(err?.stack || ''),
              schemaNodes: Object.keys(pmState.schema?.nodes || {}),
            });
            tableNode = null;
          }
        }
        if (tableNode) {
          const from = firstPos;
          const to = firstPos + first.nodeSize;
          replacements.push({ from, to, tableNode });
          mdTableDebug('convert: single-paragraph table', { sectionId, from, to, lines });
          offset += first.nodeSize;
          i += 1;
          continue;
        }
      }

      const header = splitMarkdownRow(line0);
      if (!header || i + 1 >= bodyNode.childCount) {
        // Case 2: rows-only table pasted as 1+ paragraphs without separator line.
        if (header) {
          const lines = [line0];
          let runOffsetEnd = offset + first.nodeSize;
          let j = i + 1;
          while (j < bodyNode.childCount) {
            const rowNode = bodyNode.child(j);
            if (rowNode.type?.name !== 'paragraph') break;
            const t = extractTextWithHardBreaks(rowNode).trim();
            if (!t) break;
            const row = splitMarkdownRow(t);
            if (!row || row.length !== header.length) break;
            lines.push(t);
            runOffsetEnd += rowNode.nodeSize;
            j += 1;
          }
          const parsedRowsOnly = parseMarkdownTableRowsOnly(lines);
          const tableSpec = parsedRowsOnly ? { header: null, rows: parsedRowsOnly.rows, withHeader: false } : null;
          let tableNode = null;
          if (tableSpec) {
            try {
              tableNode = buildTableNodeFromMarkdown(pmState.schema, tableSpec);
            } catch (err) {
              mdTableDebug('convert: buildTableNode error (rows-only)', {
                message: String(err?.message || err || ''),
                stack: String(err?.stack || ''),
                schemaNodes: Object.keys(pmState.schema?.nodes || {}),
              });
              tableNode = null;
            }
          }
          if (tableNode) {
            replacements.push({ from: firstPos, to: bodyContentStart + runOffsetEnd, tableNode });
            mdTableDebug('convert: rows-only table', { sectionId, from: firstPos, to: bodyContentStart + runOffsetEnd, lines });
            offset = runOffsetEnd;
            i = j;
            continue;
          }
        }
        offset += first.nodeSize;
        i += 1;
        continue;
      }

      const sepNode = bodyNode.child(i + 1);
      if (sepNode.type?.name !== 'paragraph') {
        offset += first.nodeSize;
        i += 1;
        continue;
      }

      const line1 = extractTextWithHardBreaks(sepNode).trim();
      const sep = splitMarkdownRow(line1);
      if (!sep || sep.length !== header.length || !sep.every(isMarkdownSeparatorCell)) {
        offset += first.nodeSize;
        i += 1;
        continue;
      }

      const lines = [line0, line1];
      let runOffsetEnd = offset + first.nodeSize + sepNode.nodeSize;
      let j = i + 2;
      while (j < bodyNode.childCount) {
        const rowNode = bodyNode.child(j);
        if (rowNode.type?.name !== 'paragraph') break;
        const t = extractTextWithHardBreaks(rowNode).trim();
        if (!t) break;
        const row = splitMarkdownRow(t);
        if (!row || row.length !== header.length) break;
        lines.push(t);
        runOffsetEnd += rowNode.nodeSize;
        j += 1;
      }

      const parsed = parseMarkdownTableLines(lines);
      const parsedRowsOnly = !parsed ? parseMarkdownTableRowsOnly(lines) : null;
      const tableSpec = parsed
        ? { header: parsed.header, rows: parsed.rows, withHeader: true }
        : parsedRowsOnly
          ? { header: null, rows: parsedRowsOnly.rows, withHeader: false }
          : null;
      let tableNode = null;
      if (tableSpec) {
        try {
          tableNode = buildTableNodeFromMarkdown(pmState.schema, tableSpec);
        } catch (err) {
          mdTableDebug('convert: buildTableNode error (multi)', {
            message: String(err?.message || err || ''),
            stack: String(err?.stack || ''),
            schemaNodes: Object.keys(pmState.schema?.nodes || {}),
          });
          tableNode = null;
        }
      }
      if (!tableNode) {
        offset += first.nodeSize;
        i += 1;
        continue;
      }

      replacements.push({ from: firstPos, to: bodyContentStart + runOffsetEnd, tableNode });
      mdTableDebug('convert: multi-paragraph table', { sectionId, from: firstPos, to: bodyContentStart + runOffsetEnd, lines });
      offset = runOffsetEnd;
      i = j;
    }

    if (!replacements.length) return null;
    replacements.sort((a, b) => b.from - a.from);
    let tr = pmState.tr;
    for (const rep of replacements) {
      tr = tr.replaceRangeWith(rep.from, rep.to, rep.tableNode);
    }
    tr = tr.setMeta(OUTLINE_ALLOW_META, true);
    return tr;
  } catch {
    return null;
  }
}

function extractTextWithHardBreaks(node) {
  if (!node) return '';
  let out = '';
  node.descendants((child) => {
    if (child.isText) out += child.text || '';
    else if (child.type?.name === 'hardBreak') out += '\n';
  });
  return out;
}

function extractParagraphTextFromJson(node) {
  try {
    if (!node || node.type !== 'paragraph') return '';
    const parts = [];
    const walk = (n) => {
      if (!n) return;
      if (n.type === 'text') {
        parts.push(String(n.text || ''));
        return;
      }
      if (n.type === 'hardBreak') {
        parts.push('\n');
        return;
      }
      const children = Array.isArray(n.content) ? n.content : [];
      for (const child of children) walk(child);
    };
    walk(node);
    return parts.join('');
  } catch {
    return '';
  }
}

function buildTableJsonFromMarkdown(table) {
  if (!table) return null;
  const { header, rows } = table;
  if (!Array.isArray(header) || header.length === 0) return null;
  const cellPara = (text) => ({
    type: 'paragraph',
    content: String(text || '').length ? [{ type: 'text', text: String(text || '') }] : [],
  });
  const headerRow = {
    type: 'tableRow',
    content: header.map((cell) => ({ type: 'tableHeader', content: [cellPara(cell)] })),
  };
  const bodyRows = (Array.isArray(rows) ? rows : []).map((row) => ({
    type: 'tableRow',
    content: row.map((cell) => ({ type: 'tableCell', content: [cellPara(cell)] })),
  }));
  return { type: 'table', content: [headerRow, ...bodyRows] };
}

function convertMarkdownTablesInOutlineDoc(editor) {
  if (!editor) return false;
  try {
    const { doc, schema } = editor.state;
    const replacements = [];

    doc.descendants((node, pos) => {
      if (node.type?.name !== 'outlineBody') return;
      const bodyStart = pos + 1;
      let offset = 0;
      let i = 0;
      while (i < node.childCount) {
        const first = node.child(i);
        const firstPos = bodyStart + offset;
        if (first.type?.name !== 'paragraph') {
          offset += first.nodeSize;
          i += 1;
          continue;
        }
        const line0 = extractTextWithHardBreaks(first).trim();

        // Case A: whole table inside one paragraph (with hardBreaks).
        if (line0.includes('\n') && line0.includes('|')) {
          const lines = normalizeLinesForMarkdownTable(line0);
          const parsed = parseMarkdownTableLines(lines);
          const parsedRowsOnly = !parsed ? parseMarkdownTableRowsOnly(lines) : null;
          const tableSpec = parsed
            ? { header: parsed.header, rows: parsed.rows, withHeader: true }
            : parsedRowsOnly
              ? { header: null, rows: parsedRowsOnly.rows, withHeader: false }
              : null;
          const tableNode = tableSpec ? buildTableNodeFromMarkdown(schema, tableSpec) : null;
          if (tableNode) {
            replacements.push({ from: firstPos, to: firstPos + first.nodeSize, tableNode });
            offset += first.nodeSize;
            i += 1;
            continue;
          }
        }

        const header = splitMarkdownRow(line0);
        if (!header) {
          offset += first.nodeSize;
          i += 1;
          continue;
        }

        // Case B: rows-only table spread across paragraphs (no separator).
        if (i + 1 >= node.childCount) {
          const parsedRowsOnly = parseMarkdownTableRowsOnly([line0]);
          const tableSpec = parsedRowsOnly ? { header: null, rows: parsedRowsOnly.rows, withHeader: false } : null;
          const tableNode = tableSpec ? buildTableNodeFromMarkdown(schema, tableSpec) : null;
          if (tableNode) {
            replacements.push({ from: firstPos, to: firstPos + first.nodeSize, tableNode });
          }
          offset += first.nodeSize;
          i += 1;
          continue;
        }

        const nextNode = node.child(i + 1);
        if (nextNode.type?.name !== 'paragraph') {
          offset += first.nodeSize;
          i += 1;
          continue;
        }
        const line1 = extractTextWithHardBreaks(nextNode).trim();
        const maybeSep = splitMarkdownRow(line1);
        if (!maybeSep || maybeSep.length !== header.length || !maybeSep.every(isMarkdownSeparatorCell)) {
          const lines = [line0];
          let runOffsetEnd = offset + first.nodeSize;
          let j = i + 1;
          while (j < node.childCount) {
            const rowNode = node.child(j);
            if (rowNode.type?.name !== 'paragraph') break;
            const t = extractTextWithHardBreaks(rowNode).trim();
            if (!t) break;
            const row = splitMarkdownRow(t);
            if (!row || row.length !== header.length) break;
            lines.push(t);
            runOffsetEnd += rowNode.nodeSize;
            j += 1;
          }
          const parsedRowsOnly = parseMarkdownTableRowsOnly(lines);
          const tableSpec = parsedRowsOnly ? { header: null, rows: parsedRowsOnly.rows, withHeader: false } : null;
          const tableNode = tableSpec ? buildTableNodeFromMarkdown(schema, tableSpec) : null;
          if (tableNode) {
            replacements.push({ from: firstPos, to: bodyStart + runOffsetEnd, tableNode });
            offset = runOffsetEnd;
            i = j;
            continue;
          }
          offset += first.nodeSize;
          i += 1;
          continue;
        }

        const lines = [line0, line1];
        let runOffsetEnd = offset + first.nodeSize + nextNode.nodeSize;
        let j = i + 2;
        while (j < node.childCount) {
          const rowNode = node.child(j);
          if (rowNode.type?.name !== 'paragraph') break;
          const t = extractTextWithHardBreaks(rowNode).trim();
          if (!t) break;
          const row = splitMarkdownRow(t);
          if (!row || row.length !== header.length) break;
          lines.push(t);
          runOffsetEnd += rowNode.nodeSize;
          j += 1;
        }

        const parsed = parseMarkdownTableLines(lines);
        const tableSpec = parsed ? { header: parsed.header, rows: parsed.rows, withHeader: true } : null;
        const tableNode = tableSpec ? buildTableNodeFromMarkdown(schema, tableSpec) : null;
        if (!tableNode) {
          offset += first.nodeSize;
          i += 1;
          continue;
        }

        replacements.push({ from: firstPos, to: bodyStart + runOffsetEnd, tableNode });
        offset = runOffsetEnd;
        i = j;
      }
    });

    if (!replacements.length) return false;
    replacements.sort((a, b) => b.from - a.from);
    let tr = editor.state.tr;
    for (const rep of replacements) {
      tr = tr.replaceRangeWith(rep.from, rep.to, rep.tableNode);
    }
    tr = tr.setMeta(OUTLINE_ALLOW_META, true);
    editor.view.dispatch(tr);
    return true;
  } catch {
    return false;
  }
}

function notifyReadOnlyGlobal() {
  const now = Date.now();
  if (now - lastReadOnlyToastAt < 900) return;
  lastReadOnlyToastAt = now;
  try {
    showToast('Для редактирования нажмите Enter или двойной клик мышкой. Esc для выхода.');
  } catch {
    // ignore
  }
}

function readAutosaveQueue() {
  try {
    return {};
  } catch {
    return {};
  }
}

function writeAutosaveQueue(queue) {
  try {
    void queue;
  } catch {
    // ignore
  }
}

function setQueuedDocJson(articleId, docJson, queuedAtMs = null) {
  void articleId;
  void docJson;
  void queuedAtMs;
  return null;
}

function getQueuedDocJson(articleId) {
  void articleId;
  return null;
}

function clearQueuedDocJson(articleId) {
  void articleId;
}

function stripHtml(html = '') {
  const tmp = document.createElement('div');
  tmp.innerHTML = html || '';
  return (tmp.textContent || '').replace(/\u00a0/g, ' ').trim();
}

function normalizeWhitespace(text = '') {
  return String(text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function hashTextForTitle(text = '') {
  const s = String(text || '');
  let h = 0;
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return String(h);
}

function hashTextForProofread(text = '') {
  return hashTextForTitle(String(text || '').slice(0, 12000));
}

function safeUuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `sec-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function renderOutlineShell({ loading = false } = {}) {
  if (!refs.outlineEditor) return;
  refs.outlineEditor.innerHTML = `
    <div class="outline-editor__body">
      <div class="outline-editor__content" id="outlineEditorContent"></div>
      <div class="outline-editor__loading ${loading ? '' : 'hidden'}">Загружаем редактор…</div>
    </div>
  `;
  if (!mounted) {
    mounted = true;
    // no buttons: autosave only
  }
}

function readOutlineTableColumnClipboard() {
  try {
    const raw = window?.localStorage?.getItem?.(OUTLINE_TABLE_COLUMN_CLIPBOARD_KEY) || '';
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (!Array.isArray(parsed.rows)) return null;
    return {
      v: Number(parsed.v || 1),
      rows: parsed.rows,
      copiedAt: typeof parsed.copiedAt === 'string' ? parsed.copiedAt : null,
    };
  } catch {
    return null;
  }
}

function writeOutlineTableColumnClipboard(rows) {
  try {
    const safeRows = Array.isArray(rows) ? rows : [];
    window?.localStorage?.setItem?.(
      OUTLINE_TABLE_COLUMN_CLIPBOARD_KEY,
      JSON.stringify({ v: 1, copiedAt: new Date().toISOString(), rows: safeRows }),
    );
    return true;
  } catch {
    return false;
  }
}

function parsePct(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  const m = s.match(/(-?\d+(?:\.\d+)?)%/);
  if (!m) return null;
  const num = Number.parseFloat(m[1]);
  return Number.isFinite(num) ? num : null;
}

function clampPct(pct) {
  const n = Number(pct);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function getColPct(colEl) {
  try {
    const ds = colEl?.dataset?.ttPct || '';
    const fromDs = Number.parseFloat(String(ds || ''));
    if (Number.isFinite(fromDs) && fromDs > 0) return fromDs;
    const fromStyle = parsePct(colEl?.style?.width || '');
    if (fromStyle != null && fromStyle > 0) return fromStyle;
    return null;
  } catch {
    return null;
  }
}

function setColPct(colEl, pct) {
  try {
    const p = clampPct(pct);
    colEl.dataset.ttPct = p.toFixed(4);
    colEl.style.width = `${p.toFixed(4)}%`;
    colEl.style.minWidth = '';
    return true;
  } catch {
    return false;
  }
}

function rebalanceTableColumnPercentsAfterInsert(editor, { insertIndex, newColPct = 10 } = {}) {
  try {
    const view = editor?.view;
    if (!view) return false;
    const idx = Number(insertIndex);
    if (!Number.isFinite(idx) || idx < 0) return false;

    const domAt = view.domAtPos(view.state.selection.from);
    const base = (domAt?.node && domAt.node.nodeType === 1 ? domAt.node : domAt?.node?.parentElement) || null;
    const tableEl = base?.closest?.('table') || null;
    if (!tableEl) return false;
    const colgroup = tableEl.querySelector('colgroup');
    if (!colgroup) return false;
    const cols = Array.from(colgroup.querySelectorAll('col'));
    if (!cols.length) return false;
    if (idx >= cols.length) return false;

    const fallback = 100 / cols.length;
    const current = cols.map((c) => getColPct(c) ?? fallback);

    const newPct = clampPct(newColPct);
    current[idx] = newPct;

    const leftEnd = idx - 1;
    const sumLeft = leftEnd >= 0 ? current.slice(0, leftEnd + 1).reduce((a, b) => a + b, 0) : 0;
    const rightStart = idx + 1;
    const rightCount = Math.max(0, cols.length - rightStart);
    const sumRightOrig =
      rightCount > 0 ? current.slice(rightStart).reduce((a, b) => a + b, 0) : 0;

    let remaining = 100 - sumLeft - newPct;
    if (remaining < 0) {
      // Edge case (insert at end / too little room): take from the immediate left column if possible.
      const takeFromIdx = Math.max(0, idx - 1);
      const canTake = Math.max(0, current[takeFromIdx] - 1);
      const need = Math.abs(remaining);
      const taken = Math.min(canTake, need);
      current[takeFromIdx] = Math.max(1, current[takeFromIdx] - taken);
      remaining = 100 - (current.slice(0, leftEnd + 1).reduce((a, b) => a + b, 0)) - newPct;
      remaining = Math.max(0, remaining);
    }

    if (rightCount > 0) {
      if (sumRightOrig > 0) {
        const factor = remaining / sumRightOrig;
        for (let i = rightStart; i < cols.length; i += 1) current[i] *= factor;
      } else {
        const each = remaining / rightCount;
        for (let i = rightStart; i < cols.length; i += 1) current[i] = each;
      }
    }

    // Apply and normalize tiny floating drift on the last column.
    let sum = current.reduce((a, b) => a + b, 0);
    if (sum > 0 && Math.abs(sum - 100) > 0.01) {
      const delta = 100 - sum;
      const lastIdx = cols.length - 1;
      current[lastIdx] = clampPct(current[lastIdx] + delta);
      sum = current.reduce((a, b) => a + b, 0);
    }

    for (let i = 0; i < cols.length; i += 1) setColPct(cols[i], current[i]);
    try {
      tableEl.style.width = '100%';
      tableEl.style.maxWidth = '100%';
      tableEl.style.tableLayout = 'fixed';
    } catch {
      // ignore
    }
    return true;
  } catch {
    return false;
  }
}

function captureTableColumnPercentsFromDom(tableEl) {
  try {
    if (!tableEl) return false;
    const colgroup = tableEl.querySelector('colgroup');
    if (!colgroup) return false;
    const cols = Array.from(colgroup.querySelectorAll('col'));
    if (!cols.length) return false;

    const tableRect = tableEl.getBoundingClientRect();
    if (!Number.isFinite(tableRect.width) || tableRect.width <= 0) return false;

    const firstRow = tableEl.querySelector('tbody tr');
    if (!firstRow) return false;
    const cells = Array.from(firstRow.children || []).filter((el) => el && el.nodeType === 1);
    if (!cells.length) return false;

    const widthsPx = [];
    for (let i = 0; i < cols.length; i += 1) {
      const cellEl = cells[i] || null;
      if (!cellEl) {
        widthsPx.push(0);
        continue;
      }
      const rect = cellEl.getBoundingClientRect();
      widthsPx.push(Number.isFinite(rect.width) ? rect.width : 0);
    }
    const total = widthsPx.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
    if (!(total > 0)) return false;

    for (let i = 0; i < cols.length; i += 1) {
      const pct = clampPct((widthsPx[i] / total) * 100);
      setColPct(cols[i], pct);
    }
    return true;
  } catch {
    return false;
  }
}

function getActiveTableDom(view) {
  try {
    if (!view?.state?.selection) return null;
    const sel = view.state.selection;

    // Prefer CellSelection anchor/head cell DOM (more reliable than `selection.from`).
    try {
      const anchorCellPos = sel?.$anchorCell?.pos;
      const headCellPos = sel?.$headCell?.pos;
      const pos = Number.isFinite(anchorCellPos) ? anchorCellPos : Number.isFinite(headCellPos) ? headCellPos : null;
      if (pos != null) {
        const dom = view.nodeDOM?.(pos) || null;
        if (dom && dom.nodeType === 1) return dom.closest?.('table') || null;
      }
    } catch {
      // ignore
    }

    const domAt = view.domAtPos(sel.from);
    const base = (domAt?.node && domAt.node.nodeType === 1 ? domAt.node : domAt?.node?.parentElement) || null;
    return base?.closest?.('table') || null;
  } catch {
    return null;
  }
}

function getActiveTableCellDom(view) {
  try {
    const sel = view?.state?.selection || null;
    const $from = sel?.$from || null;
    if (!$from) return null;

    // For CellSelection, anchor/head positions point at actual cells.
    try {
      const anchorCellPos = sel?.$anchorCell?.pos;
      const headCellPos = sel?.$headCell?.pos;
      const pos = Number.isFinite(anchorCellPos) ? anchorCellPos : Number.isFinite(headCellPos) ? headCellPos : null;
      if (pos != null) {
        const dom = view.nodeDOM?.(pos) || null;
        if (dom && dom.nodeType === 1) return dom;
      }
    } catch {
      // ignore
    }

    let cellDepth = null;
    for (let d = $from.depth; d >= 0; d -= 1) {
      const name = $from.node(d)?.type?.name;
      if (name === 'tableCell' || name === 'tableHeader') {
        cellDepth = d;
        break;
      }
    }

    if (cellDepth != null) {
      const cellPos = $from.before(cellDepth);
      const dom = view.nodeDOM?.(cellPos) || null;
      if (dom && dom.nodeType === 1) return dom;
    }

    const domAt = view.domAtPos(sel.from);
    const base = (domAt?.node && domAt.node.nodeType === 1 ? domAt.node : domAt?.node?.parentElement) || null;
    return base?.closest?.('td,th') || null;
  } catch {
    return null;
  }
}

function readTableColPercentsFromDom(tableEl) {
  try {
    if (!tableEl) return null;
    const colgroup = tableEl.querySelector('colgroup');
    if (!colgroup) return null;
    const cols = Array.from(colgroup.querySelectorAll('col'));
    if (!cols.length) return null;
    const fromAttrs = cols.map((c) => getColPct(c));
    const hasAny = fromAttrs.some((v) => typeof v === 'number' && Number.isFinite(v) && v > 0);
    if (hasAny) {
      const fallback = 100 / cols.length;
      return fromAttrs.map((v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback));
    }

    // No saved % widths found: derive percents from the current rendered DOM widths.
    const firstRow = tableEl.querySelector('tbody tr');
    if (!firstRow) return null;
    const cells = Array.from(firstRow.children || []).filter((el) => el && el.nodeType === 1);
    if (cells.length < cols.length) return null;
    const widthsPx = [];
    for (let i = 0; i < cols.length; i += 1) {
      const rect = cells[i].getBoundingClientRect();
      widthsPx.push(Number.isFinite(rect.width) ? rect.width : 0);
    }
    const total = widthsPx.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
    if (!(total > 0)) return null;
    return widthsPx.map((w) => clampPct((w / total) * 100));
  } catch {
    return null;
  }
}

function applyTableColPercentsToDom(tableEl, percents) {
  try {
    if (!tableEl) return false;
    const colgroup = tableEl.querySelector('colgroup');
    if (!colgroup) return false;
    const cols = Array.from(colgroup.querySelectorAll('col'));
    if (!cols.length) return false;
    if (!Array.isArray(percents) || percents.length !== cols.length) return false;
    for (let i = 0; i < cols.length; i += 1) setColPct(cols[i], percents[i]);
    try {
      tableEl.style.width = '100%';
      tableEl.style.maxWidth = '100%';
      tableEl.style.tableLayout = 'fixed';
    } catch {
      // ignore
    }
    return true;
  } catch {
    return false;
  }
}

function rebalanceTableColumnPercentsAfterDeleteFromSnapshot(widthsBefore, deletedIndex) {
  try {
    const w = Array.isArray(widthsBefore) ? widthsBefore.map((x) => Number(x) || 0) : null;
    const k = Number(deletedIndex);
    if (!w || !Number.isFinite(k) || k < 0 || k >= w.length) return null;
    if (w.length <= 1) return null;
    const deletedPct = Math.max(0, w[k] || 0);
    const left = w.slice(0, k);
    const right = w.slice(k + 1);
    const sumRight = right.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
    let newRight = right;
    if (right.length) {
      if (sumRight > 0) {
        const factor = (sumRight + deletedPct) / sumRight;
        newRight = right.map((x) => (Number.isFinite(x) ? x * factor : 0));
      } else {
        const each = (deletedPct || 0) / right.length;
        newRight = right.map(() => each);
      }
    } else if (left.length) {
      // Deleting the last column: give space to the new last column.
      left[left.length - 1] = Math.max(1, (left[left.length - 1] || 0) + deletedPct);
    }
    const next = [...left, ...newRight].map((x) => clampPct(x));
    // Normalize float drift on last column.
    const sum = next.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
    if (sum > 0 && Math.abs(sum - 100) > 0.01) {
      next[next.length - 1] = clampPct(next[next.length - 1] + (100 - sum));
    }
    return next;
  } catch {
    return null;
  }
}

function getActiveTableContext(pmState) {
  try {
    const TableMap = outlineTableApi?.TableMap || null;
    const sel = pmState?.selection || null;
    const $from = sel?.$from || null;
    const $anchorCell = sel?.$anchorCell || null;
    const $base = $anchorCell || $from || null;
    if (!$base) return null;
    let tableDepth = null;
    for (let d = $base.depth; d >= 0; d -= 1) {
      if ($base.node(d)?.type?.name === 'table') {
        tableDepth = d;
        break;
      }
    }
    if (tableDepth == null) return null;
    const tablePos = $base.before(tableDepth);
    const tableNode = pmState.doc.nodeAt(tablePos);
    if (!tableNode || tableNode.type?.name !== 'table') return null;

    let cellDepth = null;
    for (let d = tableDepth + 1; d <= $base.depth; d += 1) {
      const name = $base.node(d)?.type?.name;
      if (name === 'tableCell' || name === 'tableHeader') {
        cellDepth = d;
        break;
      }
    }
    if (cellDepth == null) return null;
    const cellPos = $base.before(cellDepth);

    const map = TableMap?.get ? TableMap.get(tableNode) : null;
    if (!map) return null;
    const rel = cellPos - tablePos - 1;
    const rect = map.findCell(rel);
    const colIndex = Number(rect?.left ?? 0);
    const rowIndex = Number(rect?.top ?? 0);
    return { tablePos, tableNode, map, colIndex, rowIndex };
  } catch {
    return null;
  }
}

function getSelectedTableCellsFromState(pmState) {
  try {
    const out = [];
    const sel = pmState?.selection;
    const doc = pmState?.doc;
    if (!sel || !doc) return out;

    // Prefer collecting cell nodes via nodesBetween (works for CellSelection).
    try {
      doc.nodesBetween(sel.from, sel.to, (node, pos) => {
        const name = node?.type?.name;
        if (name === 'tableCell' || name === 'tableHeader') out.push({ node, pos });
      });
    } catch {
      // ignore
    }

    // Cursor inside a single cell: nodesBetween won't include the cell node.
    if (!out.length) {
      try {
        const $from = sel.$from || null;
        if ($from) {
          for (let d = $from.depth; d >= 0; d -= 1) {
            const name = $from.node(d)?.type?.name;
            if (name === 'tableCell' || name === 'tableHeader') {
              const pos = $from.before(d);
              const node = doc.nodeAt(pos);
              if (node) out.push({ node, pos });
              break;
            }
          }
        }
      } catch {
        // ignore
      }
    }

    // Deduplicate and apply stable order by position.
    const byPos = new Map();
    for (const row of out) {
      const p = Number(row?.pos);
      if (!Number.isFinite(p)) continue;
      if (!byPos.has(p)) byPos.set(p, row);
    }
    return Array.from(byPos.values()).sort((a, b) => Number(a.pos) - Number(b.pos));
  } catch {
    return [];
  }
}

function selectOutlineTableRow(editor, rowIndex) {
  try {
    const CellSelection = outlineTableApi?.CellSelection || null;
    const TableMap = outlineTableApi?.TableMap || null;
    if (!CellSelection || !TableMap) return false;
    return editor.commands.command(({ state: pmState, dispatch }) => {
      const ctx = getActiveTableContext(pmState);
      if (!ctx) return false;
      const { tablePos, tableNode, map } = ctx;
      const r = Number(rowIndex);
      if (!Number.isFinite(r) || r < 0 || r >= map.height) return false;
      const aRel = map.positionAt(r, 0, tableNode);
      const bRel = map.positionAt(r, map.width - 1, tableNode);
      const aAbs = tablePos + 1 + aRel;
      const bAbs = tablePos + 1 + bRel;
      let sel = null;
      try {
        if (typeof CellSelection.create === 'function') {
          sel = CellSelection.create(pmState.doc, aAbs, bAbs);
        }
      } catch {
        sel = null;
      }
      if (!sel) return false;
      let tr = pmState.tr.setSelection(sel);
      tr = tr.setMeta(OUTLINE_ALLOW_META, true);
      dispatch(tr.scrollIntoView());
      return true;
    });
  } catch {
    return false;
  }
}

function selectOutlineTableRowAt(editor, tablePos, rowIndex) {
  try {
    const CellSelection = outlineTableApi?.CellSelection || null;
    const TableMap = outlineTableApi?.TableMap || null;
    if (!CellSelection || !TableMap) return false;
    const tp = Number(tablePos);
    const r = Number(rowIndex);
    if (!Number.isFinite(tp) || tp < 0 || !Number.isFinite(r) || r < 0) return false;
    return editor.commands.command(({ state: pmState, dispatch }) => {
      const tableNode = pmState?.doc?.nodeAt?.(tp) || null;
      if (!tableNode || tableNode.type?.name !== 'table') return false;
      const map = TableMap?.get ? TableMap.get(tableNode) : null;
      if (!map) return false;
      if (r >= map.height) return false;
      const aRel = map.positionAt(r, 0, tableNode);
      const bRel = map.positionAt(r, map.width - 1, tableNode);
      const aAbs = tp + 1 + aRel;
      const bAbs = tp + 1 + bRel;
      let sel = null;
      try {
        if (typeof CellSelection.create === 'function') {
          sel = CellSelection.create(pmState.doc, aAbs, bAbs);
        }
      } catch {
        sel = null;
      }
      if (!sel) return false;
      let tr = pmState.tr.setSelection(sel);
      tr = tr.setMeta(OUTLINE_ALLOW_META, true);
      dispatch(tr.scrollIntoView());
      return true;
    });
  } catch {
    return false;
  }
}

function selectOutlineTableColumn(editor, colIndex) {
  try {
    const CellSelection = outlineTableApi?.CellSelection || null;
    const TableMap = outlineTableApi?.TableMap || null;
    if (!CellSelection || !TableMap) return false;
    return editor.commands.command(({ state: pmState, dispatch }) => {
      const ctx = getActiveTableContext(pmState);
      if (!ctx) return false;
      const { tablePos, tableNode, map } = ctx;
      const col = Number(colIndex);
      if (!Number.isFinite(col) || col < 0 || col >= map.width) return false;
      const aRel = map.positionAt(0, col, tableNode);
      const bRel = map.positionAt(map.height - 1, col, tableNode);
      const aAbs = tablePos + 1 + aRel;
      const bAbs = tablePos + 1 + bRel;
      let sel = null;
      try {
        if (typeof CellSelection.create === 'function') {
          sel = CellSelection.create(pmState.doc, aAbs, bAbs);
        }
      } catch {
        sel = null;
      }
      if (!sel) return false;
      let tr = pmState.tr.setSelection(sel);
      tr = tr.setMeta(OUTLINE_ALLOW_META, true);
      dispatch(tr.scrollIntoView());
      return true;
    });
  } catch {
    return false;
  }
}

function selectOutlineTableColumnAt(editor, tablePos, colIndex) {
  try {
    const CellSelection = outlineTableApi?.CellSelection || null;
    const TableMap = outlineTableApi?.TableMap || null;
    if (!CellSelection || !TableMap) return false;
    const tp = Number(tablePos);
    const col = Number(colIndex);
    if (!Number.isFinite(tp) || tp < 0 || !Number.isFinite(col) || col < 0) return false;
    return editor.commands.command(({ state: pmState, dispatch }) => {
      const tableNode = pmState?.doc?.nodeAt?.(tp) || null;
      if (!tableNode || tableNode.type?.name !== 'table') return false;
      const map = TableMap?.get ? TableMap.get(tableNode) : null;
      if (!map) return false;
      if (col >= map.width) return false;
      const aRel = map.positionAt(0, col, tableNode);
      const bRel = map.positionAt(map.height - 1, col, tableNode);
      const aAbs = tp + 1 + aRel;
      const bAbs = tp + 1 + bRel;
      let sel = null;
      try {
        if (typeof CellSelection.create === 'function') {
          sel = CellSelection.create(pmState.doc, aAbs, bAbs);
        }
      } catch {
        sel = null;
      }
      if (!sel) return false;
      let tr = pmState.tr.setSelection(sel);
      tr = tr.setMeta(OUTLINE_ALLOW_META, true);
      dispatch(tr.scrollIntoView());
      return true;
    });
  } catch {
    return false;
  }
}

function applyAttrToTableRowAt({ pmState, dispatch }, { tablePos, rowIndex, attr, value }) {
  try {
    const CellSelection = outlineTableApi?.CellSelection || null;
    const TableMap = outlineTableApi?.TableMap || null;
    if (!TableMap) return false;
    const tp = Number(tablePos);
    const r = Number(rowIndex);
    if (!Number.isFinite(tp) || tp < 0 || !Number.isFinite(r) || r < 0) return false;
    const tableNode = pmState?.doc?.nodeAt?.(tp) || null;
    if (!tableNode || tableNode.type?.name !== 'table') return false;
    const map = TableMap?.get ? TableMap.get(tableNode) : null;
    if (!map) return false;
    if (r >= map.height) return false;

    let tr = pmState.tr;
    try {
      if (CellSelection?.create) {
        const aRel = map.positionAt(r, 0, tableNode);
        const bRel = map.positionAt(r, map.width - 1, tableNode);
        const aAbs = tp + 1 + aRel;
        const bAbs = tp + 1 + bRel;
        tr = tr.setSelection(CellSelection.create(tr.doc, aAbs, bAbs));
      }
    } catch {
      // ignore
    }

    const cellPositions = new Set();
    for (let c = 0; c < map.width; c += 1) {
      const rel = map.map[r * map.width + c];
      if (!Number.isFinite(rel)) continue;
      cellPositions.add(tp + 1 + rel);
    }
    if (!cellPositions.size) return false;

    let changed = false;
    for (const pos of cellPositions) {
      const node = tr.doc.nodeAt(pos);
      const name = node?.type?.name;
      if (name !== 'tableCell' && name !== 'tableHeader') continue;
      const next = { ...(node.attrs || {}) };
      if (value == null || value === '') delete next[attr];
      else next[attr] = value;
      tr = tr.setNodeMarkup(pos, undefined, next);
      changed = true;
    }
    if (!changed) return false;
    tr = tr.setMeta(OUTLINE_ALLOW_META, true);
    dispatch(tr);
    return true;
  } catch {
    return false;
  }
}

function applyAttrToTableColumnAt({ pmState, dispatch }, { tablePos, colIndex, attr, value }) {
  try {
    const CellSelection = outlineTableApi?.CellSelection || null;
    const TableMap = outlineTableApi?.TableMap || null;
    if (!TableMap) return false;
    const tp = Number(tablePos);
    const col = Number(colIndex);
    if (!Number.isFinite(tp) || tp < 0 || !Number.isFinite(col) || col < 0) return false;
    const tableNode = pmState?.doc?.nodeAt?.(tp) || null;
    if (!tableNode || tableNode.type?.name !== 'table') return false;
    const map = TableMap?.get ? TableMap.get(tableNode) : null;
    if (!map) return false;
    if (col >= map.width) return false;

    let tr = pmState.tr;
    try {
      if (CellSelection?.create) {
        const aRel = map.positionAt(0, col, tableNode);
        const bRel = map.positionAt(map.height - 1, col, tableNode);
        const aAbs = tp + 1 + aRel;
        const bAbs = tp + 1 + bRel;
        tr = tr.setSelection(CellSelection.create(tr.doc, aAbs, bAbs));
      }
    } catch {
      // ignore
    }

    const cellPositions = new Set();
    for (let r = 0; r < map.height; r += 1) {
      const rel = map.map[r * map.width + col];
      if (!Number.isFinite(rel)) continue;
      cellPositions.add(tp + 1 + rel);
    }
    if (!cellPositions.size) return false;

    let changed = false;
    for (const pos of cellPositions) {
      const node = tr.doc.nodeAt(pos);
      const name = node?.type?.name;
      if (name !== 'tableCell' && name !== 'tableHeader') continue;
      const next = { ...(node.attrs || {}) };
      if (value == null || value === '') delete next[attr];
      else next[attr] = value;
      tr = tr.setNodeMarkup(pos, undefined, next);
      changed = true;
    }
    if (!changed) return false;
    tr = tr.setMeta(OUTLINE_ALLOW_META, true);
    dispatch(tr);
    return true;
  } catch {
    return false;
  }
}

function canMoveTableWithoutSpans(tableNode, kindLabel = 'таблицы') {
  try {
    let hasSpans = false;
    tableNode.descendants((n) => {
      if (hasSpans) return false;
      const name = n?.type?.name;
      if (name === 'tableCell' || name === 'tableHeader') {
        const cs = Number(n.attrs?.colspan || 1);
        const rs = Number(n.attrs?.rowspan || 1);
        if (cs !== 1 || rs !== 1) {
          hasSpans = true;
          return false;
        }
      }
      return true;
    });
    if (hasSpans) {
      showToast(`Перемещение ${kindLabel} пока не поддерживается для объединённых ячеек`);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function intersectsTableSpansAtColumnOrRow(ctx, { kind, fromIndex, toIndex }) {
  try {
    if (!ctx) return true;
    const TableMap = outlineTableApi?.TableMap || null;
    if (!TableMap) return true;
    const map = ctx.map || null;
    const tableNode = ctx.tableNode || null;
    if (!map || !tableNode) return true;

    const from = Number(fromIndex);
    const to = Number(toIndex);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return true;

    const fromClamped = kind === 'row' ? Math.max(0, Math.min(map.height - 1, from)) : Math.max(0, Math.min(map.width - 1, from));
    const toClamped = kind === 'row' ? Math.max(0, Math.min(map.height - 1, to)) : Math.max(0, Math.min(map.width - 1, to));

    const seen = new Set();
    for (const relPos of map.map) {
      const p = Number(relPos);
      if (!Number.isFinite(p) || p < 0) continue;
      if (seen.has(p)) continue;
      seen.add(p);
      let rect = null;
      try {
        rect = map.findCell(p);
      } catch {
        rect = null;
      }
      if (!rect) continue;
      const w = Number(rect.right) - Number(rect.left);
      const h = Number(rect.bottom) - Number(rect.top);
      if (!(w > 1 || h > 1)) continue;

      if (kind === 'col') {
        const left = Number(rect.left);
        const right = Number(rect.right);
        if ((left <= fromClamped && fromClamped < right) || (left <= toClamped && toClamped < right)) return true;
      } else {
        const top = Number(rect.top);
        const bottom = Number(rect.bottom);
        if ((top <= fromClamped && fromClamped < bottom) || (top <= toClamped && toClamped < bottom)) return true;
      }
    }
    return false;
  } catch {
    return true;
  }
}

function moveTableColumnBy(editor, dir) {
  try {
    if (!editor?.view) return false;
    const ctx = getActiveTableContext(editor.state);
    if (!ctx) return false;
    const { colIndex } = ctx;
    const cols = ctx.map?.width || 0;
    if (!(cols > 0)) return false;
    const d = dir < 0 ? -1 : 1;
    const targetCol = colIndex + d;
    if (!(targetCol >= 0 && targetCol < cols)) return false;
    return moveTableColumnToIndex(editor, colIndex, targetCol);
  } catch {
    return false;
  }
}

function moveTableRowBy(editor, dir) {
  try {
    if (!editor?.view) return false;
    const ctx = getActiveTableContext(editor.state);
    if (!ctx) return false;
    const { rowIndex } = ctx;
    const rows = ctx.map?.height || 0;
    if (!(rows > 0)) return false;
    const d = dir < 0 ? -1 : 1;
    const targetRow = rowIndex + d;
    if (!(targetRow >= 0 && targetRow < rows)) return false;
    return moveTableRowToIndex(editor, rowIndex, targetRow);
  } catch {
    return false;
  }
}

function moveTableColumnToIndex(editor, fromIndex, toIndex) {
  try {
    if (!editor?.view) return false;
    const pmState = editor.state;
    const ctx = getActiveTableContext(pmState);
    if (!ctx) return false;
    const { tableNode } = ctx;
    const cols = ctx.map?.width || 0;
    if (!(cols > 0)) return false;

    const from = Number(fromIndex);
    const to = Number(toIndex);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return false;
    if (from < 0 || from >= cols) return false;
    if (to < 0 || to >= cols) return false;
    if (from === to) return true;
    if (intersectsTableSpansAtColumnOrRow(ctx, { kind: 'col', fromIndex: from, toIndex: to })) {
      showToast('Нельзя переместить столбец: исходная или целевая колонка пересекается с объединёнными ячейками');
      return false;
    }

    const tableElBefore = getActiveTableDom(editor.view);
    const widthsBefore = readTableColPercentsFromDom(tableElBefore);
    const widthsAfter =
      Array.isArray(widthsBefore) && widthsBefore.length === cols
        ? (() => {
            const next = widthsBefore.slice();
            const moved = next.splice(from, 1)[0];
            next.splice(to, 0, moved);
            return next;
          })()
        : null;

    const moveTableColumn = outlineTableApi?.moveTableColumn || null;
    if (typeof moveTableColumn !== 'function') return false;
    const cmd = moveTableColumn({ from, to, select: true });
    const ok = editor.commands.command(({ state, dispatch }) => {
      const wrappedDispatch =
        typeof dispatch === 'function'
          ? (tr) => {
              try {
                tr = tr.setMeta(OUTLINE_ALLOW_META, true);
              } catch {
                // ignore
              }
              dispatch(tr);
            }
          : undefined;
      return cmd(state, wrappedDispatch);
    });
    if (!ok) return false;

    if (widthsAfter) {
      window.requestAnimationFrame(() => {
        const tableEl = getActiveTableDom(editor.view);
        applyTableColPercentsToDom(tableEl, widthsAfter);
        try {
          const wrapper = tableEl?.closest?.('.tableWrapper') || null;
          wrapper?.dispatchEvent?.(new Event('scroll'));
        } catch {
          // ignore
        }
      });
    }
    return true;
  } catch {
    return false;
  }
}

function moveTableRowToIndex(editor, fromIndex, toIndex) {
  try {
    if (!editor?.view) return false;
    const pmState = editor.state;
    const ctx = getActiveTableContext(pmState);
    if (!ctx) return false;
    const rows = ctx.map?.height || 0;
    const cols = ctx.map?.width || 0;
    if (!(cols > 0 && rows > 0)) return false;

    const from = Number(fromIndex);
    const to = Number(toIndex);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return false;
    if (from < 0 || from >= rows) return false;
    if (to < 0 || to >= rows) return false;
    if (from === to) return true;
    if (intersectsTableSpansAtColumnOrRow(ctx, { kind: 'row', fromIndex: from, toIndex: to })) {
      showToast('Нельзя переместить строку: исходная или целевая строка пересекается с объединёнными ячейками');
      return false;
    }

    // Preserve column widths (DOM-only).
    const tableElBefore = getActiveTableDom(editor.view);
    const widthsBefore = readTableColPercentsFromDom(tableElBefore); // DOM-only

    const moveTableRow = outlineTableApi?.moveTableRow || null;
    if (typeof moveTableRow !== 'function') return false;
    const cmd = moveTableRow({ from, to, select: true });
    const ok = editor.commands.command(({ state, dispatch }) => {
      const wrappedDispatch =
        typeof dispatch === 'function'
          ? (tr) => {
              try {
                tr = tr.setMeta(OUTLINE_ALLOW_META, true);
              } catch {
                // ignore
              }
              dispatch(tr);
            }
          : undefined;
      return cmd(state, wrappedDispatch);
    });
    if (!ok) return false;

    if (Array.isArray(widthsBefore) && widthsBefore.length === cols) {
      window.requestAnimationFrame(() => {
        const tableEl = getActiveTableDom(editor.view);
        applyTableColPercentsToDom(tableEl, widthsBefore);
      });
    }
    return true;
  } catch {
    return false;
  }
}

function extractCellPlainText(cellNode) {
  try {
    if (!cellNode) return '';
    const raw = cellNode.textContent || '';
    return String(raw).replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
}

function isHeaderRowNode(rowNode) {
  try {
    if (!rowNode) return false;
    for (let i = 0; i < rowNode.childCount; i += 1) {
      if (rowNode.child(i)?.type?.name === 'tableHeader') return true;
    }
    return false;
  } catch {
    return false;
  }
}

function sortOutlineTableRowsByColumn(editor, { direction = 'asc' } = {}) {
  try {
    if (!editor?.view) return false;
    const pmState = editor.state;
    const ctx = getActiveTableContext(pmState);
    if (!ctx) return false;
    const { tablePos, tableNode, colIndex } = ctx;
    const cols = tableNode.child(0)?.childCount || 0;
    const rows = tableNode.childCount || 0;
    if (!(cols > 0 && rows > 1)) return false;
    if (!(colIndex >= 0 && colIndex < cols)) return false;
    if (!canMoveTableWithoutSpans(tableNode, 'таблицы')) return false;

    const header = isHeaderRowNode(tableNode.child(0)) ? tableNode.child(0) : null;
    const startRow = header ? 1 : 0;
    const items = [];
    for (let r = startRow; r < rows; r += 1) {
      const rowNode = tableNode.child(r);
      const cellNode = rowNode.child(colIndex);
      items.push({ rowIndex: r, rowNode, key: extractCellPlainText(cellNode) });
    }
    const factor = direction === 'desc' ? -1 : 1;
    items.sort((a, b) => factor * a.key.localeCompare(b.key, undefined, { sensitivity: 'base', numeric: true }));

    const newRows = [];
    if (header) newRows.push(header);
    for (const it of items) newRows.push(it.rowNode);
    const newTable = tableNode.type.create(tableNode.attrs, newRows);

    let tr = pmState.tr.replaceWith(tablePos, tablePos + tableNode.nodeSize, newTable);
    tr = tr.setMeta(OUTLINE_ALLOW_META, true);
    editor.view.dispatch(tr.scrollIntoView());
    return true;
  } catch {
    return false;
  }
}

function sortOutlineTableColumnsByRow(editor, { direction = 'asc' } = {}) {
  try {
    if (!editor?.view) return false;
    const pmState = editor.state;
    const ctx = getActiveTableContext(pmState);
    if (!ctx) return false;
    const { tablePos, tableNode, rowIndex } = ctx;
    const cols = tableNode.child(0)?.childCount || 0;
    const rows = tableNode.childCount || 0;
    if (!(cols > 1 && rows > 0)) return false;
    if (!(rowIndex >= 0 && rowIndex < rows)) return false;
    if (!canMoveTableWithoutSpans(tableNode, 'таблицы')) return false;

    const rowNode = tableNode.child(rowIndex);
    const keys = [];
    for (let c = 0; c < cols; c += 1) {
      keys.push({ colIndex: c, key: extractCellPlainText(rowNode.child(c)) });
    }
    const factor = direction === 'desc' ? -1 : 1;
    keys.sort((a, b) => factor * a.key.localeCompare(b.key, undefined, { sensitivity: 'base', numeric: true }));
    const order = keys.map((k) => k.colIndex);

    // Preserve column widths by permuting saved percents.
    const tableElBefore = getActiveTableDom(editor.view);
    const widthsBefore = readTableColPercentsFromDom(tableElBefore);
    const widthsAfter =
      Array.isArray(widthsBefore) && widthsBefore.length === cols ? order.map((i) => widthsBefore[i]) : null;

    const newRows = [];
    for (let r = 0; r < rows; r += 1) {
      const oldRow = tableNode.child(r);
      const nextCells = order.map((i) => oldRow.child(i));
      newRows.push(oldRow.type.create(oldRow.attrs, nextCells));
    }
    const newTable = tableNode.type.create(tableNode.attrs, newRows);
    let tr = pmState.tr.replaceWith(tablePos, tablePos + tableNode.nodeSize, newTable);
    tr = tr.setMeta(OUTLINE_ALLOW_META, true);
    editor.view.dispatch(tr.scrollIntoView());
    if (widthsAfter) {
      window.requestAnimationFrame(() => {
        const tableEl = getActiveTableDom(editor.view);
        applyTableColPercentsToDom(tableEl, widthsAfter);
      });
    }
    return true;
  } catch {
    return false;
  }
}

function duplicateOutlineTableRow(editor) {
  try {
    if (!editor?.view) return false;
    const pmState = editor.state;
    const ctx = getActiveTableContext(pmState);
    if (!ctx) return false;
    const { tablePos, tableNode, rowIndex, colIndex } = ctx;
    const cols = tableNode.child(0)?.childCount || 0;
    const rows = tableNode.childCount || 0;
    if (!(cols > 0 && rows > 0)) return false;
    if (!(rowIndex >= 0 && rowIndex < rows)) return false;
    if (!canMoveTableWithoutSpans(tableNode, 'строк')) return false;

    const copyRow = tableNode.child(rowIndex);
    const newRows = [];
    for (let r = 0; r < rows; r += 1) {
      newRows.push(tableNode.child(r));
      if (r === rowIndex) newRows.push(copyRow.type.create(copyRow.attrs, copyRow.content, copyRow.marks));
    }
    const newTable = tableNode.type.create(tableNode.attrs, newRows);
    let tr = pmState.tr.replaceWith(tablePos, tablePos + tableNode.nodeSize, newTable);
    tr = tr.setMeta(OUTLINE_ALLOW_META, true);

    // Place selection in the duplicated row, same column.
    try {
      const TextSelection = tiptap?.pmStateMod?.TextSelection;
      if (TextSelection) {
        const targetRowIndex = Math.min(newTable.childCount - 1, rowIndex + 1);
        const targetColIndex = Math.min(cols - 1, Math.max(0, colIndex));
        const targetRowNode = newTable.child(targetRowIndex);
        const targetCell = targetRowNode.child(targetColIndex);
        let pos = tablePos + 1;
        for (let r = 0; r < targetRowIndex; r += 1) pos += newTable.child(r).nodeSize;
        pos += 1;
        for (let c = 0; c < targetColIndex; c += 1) pos += targetRowNode.child(c).nodeSize;
        const cellPos = pos;
        const cellFrom = cellPos + 1;
        const cellTo = cellPos + targetCell.nodeSize - 1;
        tr = tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(cellTo, cellFrom + 1)), 1));
      }
    } catch {
      // ignore
    }

    editor.view.dispatch(tr.scrollIntoView());
    return true;
  } catch {
    return false;
  }
}

function duplicateOutlineTableColumn(editor) {
  try {
    if (!editor?.view) return false;
    const pmState = editor.state;
    const ctx = getActiveTableContext(pmState);
    if (!ctx) return false;
    const { tablePos, tableNode, rowIndex, colIndex } = ctx;
    const cols = tableNode.child(0)?.childCount || 0;
    const rows = tableNode.childCount || 0;
    if (!(cols > 0 && rows > 0)) return false;
    if (!(colIndex >= 0 && colIndex < cols)) return false;
    if (!canMoveTableWithoutSpans(tableNode, 'столбцов')) return false;

    // Preserve column widths by splitting the duplicated column pct in half.
    const tableElBefore = getActiveTableDom(editor.view);
    const widthsBefore = readTableColPercentsFromDom(tableElBefore);
    let widthsAfter = null;
    if (Array.isArray(widthsBefore) && widthsBefore.length === cols) {
      const next = [...widthsBefore];
      const src = Math.max(0, Number(next[colIndex] || 0));
      const half = clampPct(src / 2);
      next[colIndex] = half;
      next.splice(colIndex + 1, 0, half);
      // Normalize drift on last column.
      const sum = next.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
      if (sum > 0 && Math.abs(sum - 100) > 0.01) {
        next[next.length - 1] = clampPct(next[next.length - 1] + (100 - sum));
      }
      widthsAfter = next;
    }

    const newRows = [];
    for (let r = 0; r < rows; r += 1) {
      const oldRow = tableNode.child(r);
      const nextCells = [];
      for (let c = 0; c < cols; c += 1) {
        const cell = oldRow.child(c);
        nextCells.push(cell);
        if (c === colIndex) nextCells.push(cell.type.create(cell.attrs, cell.content, cell.marks));
      }
      newRows.push(oldRow.type.create(oldRow.attrs, nextCells));
    }
    const newTable = tableNode.type.create(tableNode.attrs, newRows);
    let tr = pmState.tr.replaceWith(tablePos, tablePos + tableNode.nodeSize, newTable);
    tr = tr.setMeta(OUTLINE_ALLOW_META, true);

    try {
      const TextSelection = tiptap?.pmStateMod?.TextSelection;
      if (TextSelection) {
        const targetRowIndex = Math.min(newTable.childCount - 1, Math.max(0, rowIndex));
        const targetColIndex = Math.min(cols, Math.max(0, colIndex + 1));
        const targetRowNode = newTable.child(targetRowIndex);
        const targetCell = targetRowNode.child(targetColIndex);
        let pos = tablePos + 1;
        for (let r = 0; r < targetRowIndex; r += 1) pos += newTable.child(r).nodeSize;
        pos += 1;
        for (let c = 0; c < targetColIndex; c += 1) pos += targetRowNode.child(c).nodeSize;
        const cellPos = pos;
        const cellFrom = cellPos + 1;
        const cellTo = cellPos + targetCell.nodeSize - 1;
        tr = tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(cellTo, cellFrom + 1)), 1));
      }
    } catch {
      // ignore
    }

    editor.view.dispatch(tr.scrollIntoView());
    if (Array.isArray(widthsAfter) && widthsAfter.length === cols + 1) {
      window.requestAnimationFrame(() => {
        const tableEl = getActiveTableDom(editor.view);
        applyTableColPercentsToDom(tableEl, widthsAfter);
      });
    } else {
      window.requestAnimationFrame(() => {
        const tableEl = getActiveTableDom(editor.view);
        captureTableColumnPercentsFromDom(tableEl);
      });
    }
    return true;
  } catch {
    return false;
  }
}

function moveOutlineBodyParagraphBy(editor, dir) {
  try {
    if (!editor?.view) return false;
    const { state: pmState, view } = editor;
    const { selection } = pmState;
    const $from = selection?.$from || null;
    if (!$from) return false;

    // Only within outlineBody (not inside tables/lists/etc).
    let paraDepth = null;
    for (let d = $from.depth; d > 0; d -= 1) {
      if ($from.node(d)?.type?.name === 'paragraph') {
        if ($from.node(d - 1)?.type?.name === 'outlineBody') paraDepth = d;
        break;
      }
    }
    if (paraDepth == null) return false;

    const bodyDepth = paraDepth - 1;
    const bodyNode = $from.node(bodyDepth);
    const idx = $from.index(bodyDepth);
    if (!bodyNode || bodyNode.type?.name !== 'outlineBody') return false;

    const ddir = dir < 0 ? -1 : 1;
    const targetIdx = idx + ddir;
    if (!(targetIdx >= 0 && targetIdx < bodyNode.childCount)) return false;

    const currNode = bodyNode.child(idx);
    const otherNode = bodyNode.child(targetIdx);
    if (currNode?.type?.name !== 'paragraph') return false;
    if (otherNode?.type?.name !== 'paragraph') return false;

    const currPos = $from.before(paraDepth);
    const currSize = currNode.nodeSize;
    const otherPos = ddir < 0 ? currPos - otherNode.nodeSize : currPos + currSize;
    const otherSize = otherNode.nodeSize;

    const offsetInPara = Math.max(0, selection.from - $from.start(paraDepth));

    let tr = pmState.tr;
    if (ddir < 0) {
      // Move current paragraph up (swap with previous).
      tr = tr.delete(currPos, currPos + currSize);
      tr = tr.insert(otherPos, currNode);
      const newPos = otherPos;
      const from = newPos + 1;
      const to = newPos + currNode.nodeSize - 1;
      const desired = from + offsetInPara;
      const anchor = Math.min(Math.max(desired, from), to);
      try {
        const TextSelection = tiptap?.pmStateMod?.TextSelection;
        if (TextSelection) tr = tr.setSelection(TextSelection.near(tr.doc.resolve(anchor), 1));
      } catch {
        // ignore
      }
    } else {
      // Move current paragraph down (swap with next).
      tr = tr.delete(currPos, currPos + currSize);
      const insertPos = currPos + otherSize;
      tr = tr.insert(insertPos, currNode);
      const newPos = insertPos;
      const from = newPos + 1;
      const to = newPos + currNode.nodeSize - 1;
      const desired = from + offsetInPara;
      const anchor = Math.min(Math.max(desired, from), to);
      try {
        const TextSelection = tiptap?.pmStateMod?.TextSelection;
        if (TextSelection) tr = tr.setSelection(TextSelection.near(tr.doc.resolve(anchor), 1));
      } catch {
        // ignore
      }
    }
    tr = tr.setMeta(OUTLINE_ALLOW_META, true);
    view.dispatch(tr.scrollIntoView());
    return true;
  } catch {
    return false;
  }
}

function moveParagraphWithinParentBy(editor, dir, allowedParentTypeNames) {
  try {
    if (!editor?.view) return false;
    const { state: pmState, view } = editor;
    const { selection } = pmState;
    const $from = selection?.$from || null;
    if (!$from) return false;

    const allowed =
      allowedParentTypeNames instanceof Set ? allowedParentTypeNames : new Set(Array.from(allowedParentTypeNames || []));

    let paraDepth = null;
    for (let d = $from.depth; d > 0; d -= 1) {
      if ($from.node(d)?.type?.name === 'paragraph') {
        const parentName = $from.node(d - 1)?.type?.name || '';
        if (allowed.has(parentName)) paraDepth = d;
        break;
      }
    }
    if (paraDepth == null) return false;

    const parentDepth = paraDepth - 1;
    const parentNode = $from.node(parentDepth);
    const idx = $from.index(parentDepth);
    if (!parentNode) return false;

    const ddir = dir < 0 ? -1 : 1;
    const targetIdx = idx + ddir;
    if (!(targetIdx >= 0 && targetIdx < parentNode.childCount)) return false;

    const currNode = parentNode.child(idx);
    const otherNode = parentNode.child(targetIdx);
    if (currNode?.type?.name !== 'paragraph') return false;
    if (otherNode?.type?.name !== 'paragraph') return false;

    const currPos = $from.before(paraDepth);
    const currSize = currNode.nodeSize;
    const otherPos = ddir < 0 ? currPos - otherNode.nodeSize : currPos + currSize;
    const otherSize = otherNode.nodeSize;

    const offsetInPara = Math.max(0, selection.from - $from.start(paraDepth));

    let tr = pmState.tr;
    if (ddir < 0) {
      tr = tr.delete(currPos, currPos + currSize);
      tr = tr.insert(otherPos, currNode);
      const newPos = otherPos;
      const from = newPos + 1;
      const to = newPos + currNode.nodeSize - 1;
      const desired = from + offsetInPara;
      const anchor = Math.min(Math.max(desired, from), to);
      try {
        const TextSelection = tiptap?.pmStateMod?.TextSelection;
        if (TextSelection) tr = tr.setSelection(TextSelection.near(tr.doc.resolve(anchor), 1));
      } catch {
        // ignore
      }
    } else {
      tr = tr.delete(currPos, currPos + currSize);
      const insertPos = currPos + otherSize;
      tr = tr.insert(insertPos, currNode);
      const newPos = insertPos;
      const from = newPos + 1;
      const to = newPos + currNode.nodeSize - 1;
      const desired = from + offsetInPara;
      const anchor = Math.min(Math.max(desired, from), to);
      try {
        const TextSelection = tiptap?.pmStateMod?.TextSelection;
        if (TextSelection) tr = tr.setSelection(TextSelection.near(tr.doc.resolve(anchor), 1));
      } catch {
        // ignore
      }
    }
    tr = tr.setMeta(OUTLINE_ALLOW_META, true);
    view.dispatch(tr.scrollIntoView());
    return true;
  } catch {
    return false;
  }
}

function moveOutlineTextParagraphBy(editor, dir) {
  return moveParagraphWithinParentBy(editor, dir, new Set(['outlineBody', 'tableCell', 'tableHeader']));
}

function moveOutlineListItemBy(editor, dir) {
  try {
    if (!editor?.view) return false;
    const { state: pmState, view } = editor;
    const { selection } = pmState;
    const $from = selection?.$from || null;
    if (!$from) return false;

    let listItemDepth = null;
    for (let d = $from.depth; d > 0; d -= 1) {
      if ($from.node(d)?.type?.name === 'listItem') {
        listItemDepth = d;
        break;
      }
    }
    if (listItemDepth == null) return false;

    const listDepth = listItemDepth - 1;
    const listNode = $from.node(listDepth);
    const listName = listNode?.type?.name || '';
    if (listName !== 'bulletList' && listName !== 'orderedList') return false;

    const idx = $from.index(listDepth);
    const ddir = dir < 0 ? -1 : 1;
    const targetIdx = idx + ddir;
    if (!(targetIdx >= 0 && targetIdx < listNode.childCount)) return false;

    const currNode = listNode.child(idx);
    const otherNode = listNode.child(targetIdx);
    if (currNode?.type?.name !== 'listItem') return false;
    if (otherNode?.type?.name !== 'listItem') return false;

    const currPos = $from.before(listItemDepth);
    const currSize = currNode.nodeSize;
    const otherSize = otherNode.nodeSize;

    const offsetInItem = Math.max(0, selection.from - $from.start(listItemDepth));

    let tr = pmState.tr;
    if (ddir < 0) {
      const insertPos = currPos - otherSize;
      tr = tr.delete(currPos, currPos + currSize);
      tr = tr.insert(insertPos, currNode);
      const newPos = insertPos;
      const from = newPos + 1;
      const to = newPos + currNode.nodeSize - 1;
      const desired = from + offsetInItem;
      const anchor = Math.min(Math.max(desired, from), to);
      try {
        const TextSelection = tiptap?.pmStateMod?.TextSelection;
        if (TextSelection) tr = tr.setSelection(TextSelection.near(tr.doc.resolve(anchor), 1));
      } catch {
        // ignore
      }
    } else {
      tr = tr.delete(currPos, currPos + currSize);
      const insertPos = currPos + otherSize;
      tr = tr.insert(insertPos, currNode);
      const newPos = insertPos;
      const from = newPos + 1;
      const to = newPos + currNode.nodeSize - 1;
      const desired = from + offsetInItem;
      const anchor = Math.min(Math.max(desired, from), to);
      try {
        const TextSelection = tiptap?.pmStateMod?.TextSelection;
        if (TextSelection) tr = tr.setSelection(TextSelection.near(tr.doc.resolve(anchor), 1));
      } catch {
        // ignore
      }
    }

    tr = tr.setMeta(OUTLINE_ALLOW_META, true);
    view.dispatch(tr.scrollIntoView());
    return true;
  } catch {
    return false;
  }
}

function copyOutlineTableColumn(editor) {
  try {
    const pmState = editor?.state;
    if (!pmState) return false;
    const ctx = getActiveTableContext(pmState);
    if (!ctx) return false;
    const { tablePos, tableNode, map, colIndex } = ctx;
    const rows = [];
    for (let r = 0; r < map.height; r += 1) {
      const rel = map.positionAt(r, colIndex, tableNode);
      const abs = tablePos + 1 + rel;
      const cell = pmState.doc.nodeAt(abs);
      const json = cell?.content?.toJSON?.() || [];
      rows.push(Array.isArray(json) ? json : []);
    }
    if (!rows.length) return false;
    writeOutlineTableColumnClipboard(rows);
    showToast(`Скопирован столбец (${rows.length} ячеек)`);
    return true;
  } catch {
    return false;
  }
}

function pasteOutlineTableColumnAfter(editor) {
  try {
    const clip = readOutlineTableColumnClipboard();
    if (!clip?.rows?.length) {
      showToast('Буфер столбца пуст');
      return false;
    }
    const beforeState = editor?.state;
    if (!beforeState) return false;
    const beforeCtx = getActiveTableContext(beforeState);
    if (!beforeCtx) return false;
    const colIndex = beforeCtx.colIndex;
    // Make sure the target column is the selection anchor for addColumnAfter().
    selectOutlineTableColumn(editor, colIndex);
    const ok = editor.chain().focus().addColumnAfter().run();
    if (!ok) return false;
    rebalanceTableColumnPercentsAfterInsert(editor, { insertIndex: colIndex + 1, newColPct: 10 });

    const pmState = editor.state;
    const ctx = getActiveTableContext(pmState);
    if (!ctx) return false;
    const { tablePos, tableNode, map } = ctx;
    const newCol = Math.min(map.width - 1, colIndex + 1);

    const schema = pmState.schema;
    let tr = pmState.tr;
    for (let r = map.height - 1; r >= 0; r -= 1) {
      const rel = map.positionAt(r, newCol, tableNode);
      const abs = tablePos + 1 + rel;
      const cell = tr.doc.nodeAt(abs);
      if (!cell) continue;

      const rowContentJson = clip.rows[r] ?? null;
      const contentJson = Array.isArray(rowContentJson) ? rowContentJson : [];
      const safeJson = contentJson.length ? contentJson : [{ type: 'paragraph', content: [] }];
      const contentNodes = [];
      for (const nodeJson of safeJson) {
        try {
          contentNodes.push(schema.nodeFromJSON(nodeJson));
        } catch {
          // ignore invalid node
        }
      }
      if (!contentNodes.length) continue;
      const nextCell = cell.type.create(cell.attrs, contentNodes);
      tr = tr.replaceWith(abs, abs + cell.nodeSize, nextCell);
    }
    tr = tr.setMeta(OUTLINE_ALLOW_META, true);
    editor.view.dispatch(tr);
    showToast('Столбец вставлен');
    return true;
  } catch {
    return false;
  }
}

function mountOutlineToolbar(editor) {
  if (!refs.outlineToolbar) return;
  if (!editor) return;

  const root = refs.outlineToolbar;
	  const btns = {
	    undo: refs.outlineUndoBtn,
	    redo: refs.outlineRedoBtn,
	    deleteBtn: refs.outlineDeleteBtn,
	    moveUpBtn: refs.outlineMoveUpBtn,
	    moveDownBtn: refs.outlineMoveDownBtn,
	    outdentBtn: refs.outlineOutdentBtn,
	    indentBtn: refs.outlineIndentBtn,
	    newBelowBtn: refs.outlineNewBelowBtn,
	    blocksMenuBtn: root.querySelector('#outlineBlocksMenuBtn'),
	    textMenuBtn: root.querySelector('#outlineTextMenuBtn'),
	    listsMenuBtn: root.querySelector('#outlineListsMenuBtn'),
	    tableMenuBtn: root.querySelector('#outlineTableMenuBtn'),
	  };
  const dropdownBtns = Array.from(root.querySelectorAll('.outline-toolbar__dropdown-btn'));
  const menus = Array.from(root.querySelectorAll('.outline-toolbar__menu'));
	  const actionButtons = Array.from(root.querySelectorAll('[data-outline-action]'));
	  const clipboardButtons = Array.from(root.querySelectorAll('[data-outline-clipboard-action]'));

  const click = (el, handler) => {
    if (!el) return () => {};
    const onClick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      handler();
    };
    el.addEventListener('click', onClick);
    return () => el.removeEventListener('click', onClick);
  };

	  const tap = (el, handler) => {
	    if (!el) return () => {};
	    let lastTapAt = 0;
	    const invoke = (e) => {
	      lastTapAt = Date.now();
	      e.preventDefault();
	      e.stopPropagation();
	      handler();
	    };
	    const onPointerDown = (e) => invoke(e);
	    const onTouchStart = (e) => invoke(e);
	    const onClick = (e) => {
	      // Avoid double-trigger after pointerdown/touchstart.
	      if (Date.now() - lastTapAt < 450) {
	        e.preventDefault();
	        e.stopPropagation();
	        return;
	      }
	      invoke(e);
	    };

	    try {
	      el.addEventListener('pointerdown', onPointerDown);
	    } catch {
	      // ignore
	    }
	    try {
	      el.addEventListener('touchstart', onTouchStart, { passive: false });
	    } catch {
	      // Some older browsers don't support the options object.
	      try {
	        el.addEventListener('touchstart', onTouchStart);
	      } catch {
	        // ignore
	      }
	    }
	    el.addEventListener('click', onClick);
	    return () => {
	      try {
	        el.removeEventListener('pointerdown', onPointerDown);
	      } catch {
	        // ignore
	      }
	      el.removeEventListener('touchstart', onTouchStart);
	      el.removeEventListener('click', onClick);
	    };
	  };

  const markActive = (el, active) => {
    if (!el) return;
    el.classList.toggle('is-active', Boolean(active));
    el.setAttribute('aria-pressed', active ? 'true' : 'false');
  };

	  const closeAllMenus = () => {
	    for (const menu of menus) menu.classList.add('hidden');
	    for (const btn of dropdownBtns) btn.setAttribute('aria-expanded', 'false');
	  };

	  const syncClipboardMenuState = () => {
	    const clip = readOutlineSectionClipboard();
	    const canPaste = Boolean(clip && Array.isArray(clip.sections) && clip.sections.length);
	    for (const item of clipboardButtons) {
	      if (item?.getAttribute?.('data-outline-clipboard-action') === 'paste') {
	        item.toggleAttribute('disabled', !canPaste);
	      }
	    }
	  };

	  const toggleMenu = (btn) => {
	    if (!btn) return;
	    const menuId = btn.getAttribute('aria-controls');
	    const menu = menuId ? root.querySelector(`#${menuId}`) : null;
	    if (!menu) return;
	    const isOpen = !menu.classList.contains('hidden');
	    closeAllMenus();
	    if (!isOpen) {
	      if (menuId === 'outlineBlocksMenu') {
	        syncClipboardMenuState();
	      }
	      menu.classList.remove('hidden');
	      btn.setAttribute('aria-expanded', 'true');
	    }
	  };

	  const canRun = (build) => {
	    try {
	      const chain = editor.can().chain();
	      if (isEditing()) {
	        chain.command(({ tr }) => {
	          tr.setMeta(OUTLINE_ALLOW_META, true);
	          return true;
	        });
	      }
	      build(chain);
	      return chain.run();
	    } catch {
	      return false;
	    }
	  };

		  const runAction = (action) => {
		    if (!action) return false;
		    try {
		      const chain = editor.chain().focus();
		      if (isEditing()) {
		        chain.command(({ tr }) => {
		          tr.setMeta(OUTLINE_ALLOW_META, true);
		          return true;
		        });
		      }
		      if (action === 'collapseAllBlocks') return toggleAllOutlineSectionsCollapsed(editor, true);
		      if (action === 'expandAllBlocks') return toggleAllOutlineSectionsCollapsed(editor, false);
		      if (action === 'toggleBold') return chain.toggleBold().run();
		      if (action === 'toggleItalic') return chain.toggleItalic().run();
		      if (action === 'toggleStrike') return chain.toggleStrike().run();
		      if (action === 'toggleCodeBlock') {
		        // TipTap default `toggleCodeBlock()` converts each selected paragraph independently.
		        // UX: if selection spans multiple blocks, merge into one codeBlock.
		        return editor.commands.command(({ state: pmState, dispatch }) => {
		          const codeBlockType = pmState.schema.nodes?.codeBlock || null;
		          if (!codeBlockType) return false;
		          const selection = pmState.selection;
		          const { from, to } = selection;
		          if (from === to) {
		            const tr0 = pmState.tr.setMeta(OUTLINE_ALLOW_META, true);
		            dispatch(tr0);
		            return editor.commands.toggleCodeBlock();
		          }

		          const range = selection.$from?.blockRange?.(selection.$to) || null;
		          if (!range) {
		            const tr0 = pmState.tr.setMeta(OUTLINE_ALLOW_META, true);
		            dispatch(tr0);
		            return editor.commands.toggleCodeBlock();
		          }

		          if (!range.parent?.canReplaceWith?.(range.startIndex, range.endIndex, codeBlockType)) {
		            const tr0 = pmState.tr.setMeta(OUTLINE_ALLOW_META, true);
		            dispatch(tr0);
		            return editor.commands.toggleCodeBlock();
		          }

		          const raw = pmState.doc.textBetween(range.start, range.end, '\n', '\n');
		          const text = String(raw || '').replace(/\n+$/g, '').trimEnd();
		          if (!text) return false;
		          const node = codeBlockType.create(null, pmState.schema.text(text));
		          let tr = pmState.tr.replaceRangeWith(range.start, range.end, node);
		          tr = tr.setMeta(OUTLINE_ALLOW_META, true);
		          if (TextSelection) {
		            tr = tr.setSelection(TextSelection.near(tr.doc.resolve(range.start + 2), 1));
		          }
		          dispatch(tr.scrollIntoView());
		          return true;
		        });
		      }
		      if (action === 'toggleBlockquote') return chain.toggleBlockquote().run();
		      if (action === 'unsetLink') return chain.unsetLink().run();
		      if (action === 'toggleBulletList') {
	        // UX: allow switching ordered -> bullet in one click.
	        if (editor.isActive('orderedList')) {
	          return chain.toggleOrderedList().toggleBulletList().run();
	        }
        return chain.toggleBulletList().run();
      }
      if (action === 'toggleOrderedList') {
        // UX: allow switching bullet -> ordered in one click.
        if (editor.isActive('bulletList')) {
          return chain.toggleBulletList().toggleOrderedList().run();
        }
        return chain.toggleOrderedList().run();
      }
      if (action === 'unsetList') {
        if (editor.isActive('bulletList')) return chain.toggleBulletList().run();
        if (editor.isActive('orderedList')) return chain.toggleOrderedList().run();
        return chain.liftListItem('listItem').run();
      }
      if (action === 'insertTable') return chain.insertTable({ rows: 2, cols: 2, withHeaderRow: false }).run();
      if (action === 'toggleHeaderRow') return chain.toggleHeaderRow().run();
      if (action === 'toggleHeaderColumn') return chain.toggleHeaderColumn().run();
      if (action === 'addRowBefore') return chain.addRowBefore().run();
      if (action === 'addRowAfter') return chain.addRowAfter().run();
      if (action === 'deleteRow') return chain.deleteRow().run();
		      if (action === 'addColumnBefore') {
		        const ctx = getActiveTableContext(editor.state);
		        const insertIndex = ctx ? Math.max(0, Number(ctx.colIndex || 0)) : 0;
		        const ok = chain.addColumnBefore().run();
		        if (ok) {
		          // New column is inserted at `insertIndex`.
		          rebalanceTableColumnPercentsAfterInsert(editor, { insertIndex, newColPct: 10 });
		        }
		        return ok;
		      }
		      if (action === 'addColumnAfter') {
		        const ctx = getActiveTableContext(editor.state);
		        const insertIndex = ctx ? Math.max(0, Number(ctx.colIndex || 0) + 1) : 1;
		        const ok = chain.addColumnAfter().run();
		        if (ok) {
		          // New column is inserted at `insertIndex`.
		          rebalanceTableColumnPercentsAfterInsert(editor, { insertIndex, newColPct: 10 });
		        }
		        return ok;
		      }
		      if (action === 'deleteColumn') {
		        const tableElBefore = getActiveTableDom(editor.view);
		        const widthsBefore = readTableColPercentsFromDom(tableElBefore);
		        const ctx = getActiveTableContext(editor.state);
		        const deletedIndex = ctx ? Number(ctx.colIndex || 0) : null;
		        const widthsAfter =
		          widthsBefore && deletedIndex != null
		            ? rebalanceTableColumnPercentsAfterDeleteFromSnapshot(widthsBefore, deletedIndex)
		            : null;
		        const ok = chain.deleteColumn().run();
		        if (ok && Array.isArray(widthsAfter)) {
		          window.requestAnimationFrame(() => {
		            const tableEl = getActiveTableDom(editor.view);
		            applyTableColPercentsToDom(tableEl, widthsAfter);
		          });
		        }
		        return ok;
			      }
			      if (action === 'mergeCells') return chain.mergeCells().run();
			      if (action === 'splitCell') return chain.splitCell().run();
			      if (action === 'copyColumn') return false;
			      if (action === 'pasteColumnAfter') return false;
			      if (action === 'moveColumnRight') return false;
			      if (action === 'cancelTable') return cancelTableToText();
			      if (action === 'deleteTable') return chain.deleteTable().run();
			      return false;
			    } catch {
			      return false;
		    }
		  };

		  const isEditing = () => {
		    try {
		      const st = outlineEditModeKey?.getState?.(editor.state) || null;
		      return Boolean(st?.editingSectionId);
	    } catch {
	      return false;
	    }
	  };

  const requireEditing = () => {
    if (isEditing()) return true;
    notifyReadOnlyGlobal();
    return false;
  };

			  const cancelTableToText = () => {
			    if (!requireEditing()) return false;
			    try {
			      const { state: pmState, view } = editor;
			      const { schema, selection } = pmState;
			      const $from = selection?.$from;
			      if (!$from) return false;

			      // Unwrap ONLY the outermost table that contains the current selection.
			      // (Nested tables should remain as-is.)
			      let tableDepth = null;
			      for (let d = $from.depth; d >= 0; d -= 1) {
			        const node = $from.node(d);
			        if (node?.type?.name === 'table') tableDepth = d;
			      }
			      if (tableDepth == null) return false;

			      // Find the row/cell belonging to that outermost table (shallowest tableRow/tableCell after tableDepth).
			      let rowDepth = null;
			      let cellDepth = null;
			      for (let d = tableDepth + 1; d <= $from.depth; d += 1) {
			        const node = $from.node(d);
			        const name = node?.type?.name;
			        if (rowDepth == null && name === 'tableRow') rowDepth = d;
			        if (cellDepth == null && (name === 'tableCell' || name === 'tableHeader')) cellDepth = d;
			        if (rowDepth != null && cellDepth != null) break;
			      }

			      const tablePos = $from.before(tableDepth);
			      const tableNode = pmState.doc.nodeAt(tablePos);
			      if (!tableNode || tableNode.type?.name !== 'table') return false;

			      const targetRowIndex = rowDepth != null ? $from.index(tableDepth) : null;
			      const targetColIndex = rowDepth != null && cellDepth != null ? $from.index(rowDepth) : null;
			      let targetFlatIndex = null;
			      if (typeof targetRowIndex === 'number' && typeof targetColIndex === 'number') {
			        const cols = tableNode.childCount ? tableNode.child(0)?.childCount || 0 : 0;
			        if (cols > 0) targetFlatIndex = targetRowIndex * cols + targetColIndex;
			      }

			      // Build replacement blocks: each cell becomes its original block content (unchanged).
			      // Images (inline atoms) and nested tables remain intact because we keep nodes, not textContent.
			      const blocks = [];
			      let flatIndex = 0;
			      let selectionBlockIndex = 0;
			      for (let r = 0; r < tableNode.childCount; r += 1) {
			        const row = tableNode.child(r);
			        for (let c = 0; c < row.childCount; c += 1) {
			          const cell = row.child(c);
			          const cellBlocks = [];
			          try {
			            for (let i = 0; i < (cell?.content?.childCount || 0); i += 1) {
			              const child = cell.content.child(i);
			              if (child) cellBlocks.push(child);
			            }
			          } catch {
			            // ignore
			          }

			          if (!cellBlocks.length) {
			            // Keep an empty paragraph to represent an empty cell.
			            cellBlocks.push(schema.nodes.paragraph.create(null, []));
			          }

			          if (targetFlatIndex != null && flatIndex === targetFlatIndex) selectionBlockIndex = blocks.length;
			          blocks.push(...cellBlocks);
			          flatIndex += 1;
			        }
			      }
			      if (!blocks.length) return false;

			      const fragment = schema.nodes.outlineBody
			        ? schema.nodes.outlineBody.create({}, blocks).content
			        : schema.nodes.doc.create({}, blocks).content;

			      let tr = pmState.tr.replaceWith(tablePos, tablePos + tableNode.nodeSize, fragment);
			      tr = tr.setMeta(OUTLINE_ALLOW_META, true);

			      try {
			        const TextSelection = tiptap?.pmStateMod?.TextSelection;
			        if (TextSelection) {
			          let cursorPos = tablePos;
			          for (let i = 0; i < selectionBlockIndex; i += 1) cursorPos += blocks[i].nodeSize;
			          let found = null;
			          const from = Math.min(tr.doc.content.size, cursorPos);
			          const to = Math.min(tr.doc.content.size, cursorPos + 20000);
			          tr.doc.nodesBetween(from, to, (node, pos) => {
			            if (found != null) return false;
			            if (node?.isTextblock) {
			              found = pos + 1;
			              return false;
			            }
			            return true;
			          });
			          const anchor = found != null ? found : Math.min(tr.doc.content.size, cursorPos + 1);
			          tr = tr.setSelection(TextSelection.near(tr.doc.resolve(anchor), 1));
			        }
			      } catch {
			        // ignore
			      }

			      view.dispatch(tr.scrollIntoView());
			      view.focus?.();
			      return true;
			    } catch {
			      return false;
			    }
			  };

			  const moveTableColumnRight = () => {
			    if (!requireEditing()) return false;
			    try {
			      const { state: pmState, view } = editor;
			      const { selection } = pmState;
			      const $from = selection?.$from;
			      if (!$from) return false;

			      // Find the nearest table/cell context (current table when nested).
			      let tableDepth = null;
			      let rowDepth = null;
			      let cellDepth = null;
			      for (let d = $from.depth; d >= 0; d -= 1) {
			        const node = $from.node(d);
			        const name = node?.type?.name;
			        if (cellDepth == null && (name === 'tableCell' || name === 'tableHeader')) cellDepth = d;
			        if (rowDepth == null && name === 'tableRow') rowDepth = d;
			        if (name === 'table') {
			          tableDepth = d;
			          break;
			        }
			      }
			      if (tableDepth == null || rowDepth == null || cellDepth == null) return false;

			      const tablePos = $from.before(tableDepth);
			      const tableNode = pmState.doc.nodeAt(tablePos);
			      if (!tableNode || tableNode.type?.name !== 'table') return false;

			      const rowIndex = $from.index(tableDepth);
			      const colIndex = $from.index(rowDepth);
			      const cols = tableNode.child(0)?.childCount || 0;
			      if (!(cols > 0)) return false;
			      if (!(colIndex >= 0 && colIndex < cols - 1)) return false;

			      // Reject complex tables with rowspan/colspan.
			      let hasSpans = false;
			      tableNode.descendants((n) => {
			        if (hasSpans) return false;
			        const name = n?.type?.name;
			        if (name === 'tableCell' || name === 'tableHeader') {
			          const cs = Number(n.attrs?.colspan || 1);
			          const rs = Number(n.attrs?.rowspan || 1);
			          if (cs !== 1 || rs !== 1) {
			            hasSpans = true;
			            return false;
			          }
			        }
			        return true;
			      });
			      if (hasSpans) {
			        showToast('Перемещение столбцов пока не поддерживается для объединённых ячеек');
			        return false;
			      }

			      const offsetInCell = selection.from - $from.start(cellDepth);

			      const newRows = [];
			      for (let r = 0; r < tableNode.childCount; r += 1) {
			        const row = tableNode.child(r);
			        if (row.type?.name !== 'tableRow') return false;
			        if (row.childCount !== cols) return false;
			        const swapped = [];
			        for (let c = 0; c < cols; c += 1) {
			          if (c === colIndex) swapped.push(row.child(c + 1));
			          else if (c === colIndex + 1) swapped.push(row.child(c - 1));
			          else swapped.push(row.child(c));
			        }
			        newRows.push(row.type.create(row.attrs, swapped));
			      }

			      const newTable = tableNode.type.create(tableNode.attrs, newRows);
			      let tr = pmState.tr.replaceWith(tablePos, tablePos + tableNode.nodeSize, newTable);
			      tr = tr.setMeta(OUTLINE_ALLOW_META, true);

			      // Keep cursor in the moved column's cell (same row, shifted right).
			      try {
			        const TextSelection = tiptap?.pmStateMod?.TextSelection;
			        if (TextSelection) {
			          const targetRowIndex = Math.min(newTable.childCount - 1, Math.max(0, rowIndex));
			          const targetColIndex = colIndex + 1;
			          const targetRow = newTable.child(targetRowIndex);
			          const targetCell = targetRow.child(targetColIndex);

			          let pos = tablePos + 1; // inside table
			          for (let r = 0; r < targetRowIndex; r += 1) pos += newTable.child(r).nodeSize;
			          pos += 1; // inside row
			          for (let c = 0; c < targetColIndex; c += 1) pos += targetRow.child(c).nodeSize;
			          const cellPos = pos; // before cell node
			          const cellFrom = cellPos + 1;
			          const cellTo = cellPos + targetCell.nodeSize - 1;
			          const desired = cellFrom + Math.max(0, offsetInCell);
			          const anchor = Math.min(Math.max(desired, cellFrom), cellTo);
			          tr = tr.setSelection(TextSelection.near(tr.doc.resolve(anchor), 1));
			        }
			      } catch {
			        // ignore
			      }

			      view.dispatch(tr.scrollIntoView());
			      view.focus?.();
			      return true;
			    } catch {
			      return false;
			    }
			  };

			  const insertLinkMark = (href, label, attrs = {}) => {
			    const url = String(href || '').trim();
			    if (!url) return false;
			    const text = String(label || '').trim() || url;
		    const { from, to, empty } = editor.state.selection;
		    const linkAttrs = { href: url, ...attrs };
		    const chain = editor.chain().focus();
		    if (isEditing()) {
		      chain.command(({ tr }) => {
		        tr.setMeta(OUTLINE_ALLOW_META, true);
		        return true;
		      });
		    }
		    if (!empty && from !== to) {
		      return chain.setLink(linkAttrs).run();
		    }
		    return chain
	      .insertContent({
	        type: 'text',
	        text,
	        marks: [{ type: 'link', attrs: linkAttrs }],
	      })
	      .run();
	  };

	  const insertHttpLink = async () => {
	    if (!requireEditing()) return;
	    const { from, to, empty } = editor.state.selection;
	    const selectedText = !empty ? editor.state.doc.textBetween(from, to, ' ').trim() : '';
	    let url = '';
	    let label = selectedText;
	    try {
	      const mod = await import('../modal.js');
	      const res = await mod.showLinkPrompt({
	        title: 'Ссылка (URL)',
	        message: 'Введите ссылку (любой формат) и текст (можно пусто).',
	        confirmText: 'Вставить',
	        cancelText: 'Отмена',
	        textLabel: 'Текст ссылки (можно пусто)',
	        urlLabel: 'Ссылка',
	        defaultText: selectedText,
	        defaultUrl: '',
	        urlPlaceholder: '',
	      });
	      if (!res || typeof res !== 'object') return;
	      url = String(res.url || '');
	      label = String(res.text ?? selectedText);
	    } catch {
	      url = window.prompt('Введите ссылку') || '';
	      label = selectedText || (window.prompt('Текст ссылки (можно пусто)') || '');
	    }
	    url = (url || '').trim();
	    if (!url) return;
	    insertLinkMark(url, label, { target: '_blank', rel: 'noopener noreferrer' });
	  };

	  const insertArticleLink = async () => {
	    if (!requireEditing()) return;
	    let list = Array.isArray(state.articlesIndex) ? state.articlesIndex : [];
	    if (!list.length) {
	      list = (await fetchArticlesIndex().catch(() => [])) || [];
	      if (Array.isArray(list)) state.articlesIndex = list;
	    }
	    const suggestions = (Array.isArray(list) ? list : []).map((item) => ({
	      id: item.id,
	      title: item.title || 'Без названия',
	    }));
	    const { from, to, empty } = editor.state.selection;
	    const selectedText = !empty ? editor.state.doc.textBetween(from, to, ' ').trim() : '';
	    const lockTextValue = Boolean(selectedText);

	    let articleInput = '';
	    let selectedId = '';
	    let labelInput = selectedText;
	    try {
	      const mod = await import('../modal.js');
	      const result = await mod.showArticleLinkPrompt({
	        title: 'Ссылка на статью',
	        message: 'Выберите статью и задайте текст ссылки.',
	        confirmText: 'Вставить',
	        cancelText: 'Отмена',
	        suggestions,
	        defaultTextValue: selectedText,
	        lockTextValue,
	      });
	      if (result && typeof result === 'object') {
	        articleInput = result.articleValue || '';
	        selectedId = result.selectedId || '';
	        labelInput = result.textValue || '';
	      } else {
	        return;
	      }
	    } catch {
	      articleInput = window.prompt('Введите ID статьи') || '';
	      labelInput = selectedText || (window.prompt('Текст ссылки (можно пусто)') || '');
	    }
	    const term = (articleInput || '').trim().toLowerCase();
	    if (!term && !selectedId) return;
	    const match = (Array.isArray(list) ? list : []).find((item) => {
	      const titleLc = (item.title || '').toLowerCase();
	      return (
	        (selectedId && item.id === selectedId) ||
	        (item.id && item.id.toLowerCase() === term) ||
	        titleLc === term ||
	        titleLc.includes(term)
	      );
	    });
	    if (!match) {
	      showToast('Статья не найдена');
	      return;
	    }
	    const label = (labelInput || '').trim() || match.title || 'Без названия';
	    insertLinkMark(routing.article(match.id), label, { class: 'article-link' });
	  };

	  const sync = () => {
	    if (!state.isOutlineEditing) return;
	    if (!editor || editor.isDestroyed) return;

    const editing = isEditing();
    root.dataset.editing = editing ? 'true' : 'false';
    if (!editing) closeAllMenus();

	    if (btns.deleteBtn) btns.deleteBtn.hidden = editing;
	    if (btns.moveUpBtn) btns.moveUpBtn.hidden = editing;
	    if (btns.moveDownBtn) btns.moveDownBtn.hidden = editing;
	    if (btns.outdentBtn) btns.outdentBtn.hidden = editing;
	    if (btns.indentBtn) btns.indentBtn.hidden = editing;
	    if (btns.newBelowBtn) btns.newBelowBtn.hidden = editing;
	    if (btns.blocksMenuBtn) btns.blocksMenuBtn.hidden = editing;
	    if (editing && outlineSelectionMode) setOutlineSelectionMode(false);

    if (btns.undo) btns.undo.disabled = !canRun((c) => c.undo());
    if (btns.redo) btns.redo.disabled = !canRun((c) => c.redo());

    // Dropdown group buttons
	    if (btns.textMenuBtn) {
	      const active =
	        editor.isActive('bold') ||
	        editor.isActive('italic') ||
	        editor.isActive('strike') ||
	        editor.isActive('codeBlock') ||
	        editor.isActive('blockquote');
	      markActive(btns.textMenuBtn, active);
	      btns.textMenuBtn.hidden = !editing;
	    }
    if (btns.listsMenuBtn) {
      const active = editor.isActive('bulletList') || editor.isActive('orderedList');
      markActive(btns.listsMenuBtn, active);
      btns.listsMenuBtn.hidden = !editing;
    }
    if (btns.tableMenuBtn) {
      const active = editor.isActive('table');
      markActive(btns.tableMenuBtn, active);
      btns.tableMenuBtn.hidden = !editing;
    }

    // Menu items
    let collapseSummary = null;
    const getCollapseSummary = () => {
      if (collapseSummary) return collapseSummary;
      const s = { total: 0, collapsed: 0 };
      try {
        editor.state.doc.descendants((node) => {
          if (node?.type?.name !== 'outlineSection') return;
          s.total += 1;
          if (Boolean(node.attrs?.collapsed)) s.collapsed += 1;
        });
      } catch {
        // ignore
      }
      collapseSummary = s;
      return s;
    };
    for (const el of actionButtons) {
      const action = el.dataset.outlineAction || '';
      if (!action) continue;

      let isActive = false;
      let isDisabled = false;

      if (action === 'collapseAllBlocks') {
        const s = getCollapseSummary();
        isActive = false;
        isDisabled = s.total === 0 || s.collapsed >= s.total;
      } else if (action === 'expandAllBlocks') {
        const s = getCollapseSummary();
        isActive = false;
        isDisabled = s.total === 0 || s.collapsed <= 0;
      } else if (action === 'toggleBold') {
        isActive = editor.isActive('bold');
        isDisabled = !canRun((c) => c.toggleBold());
      } else if (action === 'toggleItalic') {
        isActive = editor.isActive('italic');
        isDisabled = !canRun((c) => c.toggleItalic());
	      } else if (action === 'toggleStrike') {
	        isActive = editor.isActive('strike');
	        isDisabled = !canRun((c) => c.toggleStrike());
	      } else if (action === 'toggleCodeBlock') {
	        isActive = editor.isActive('codeBlock');
	        // We use a custom command for merge-into-one behavior; `can()` doesn't know about it.
	        isDisabled = !isEditing();
		      } else if (action === 'toggleBlockquote') {
		        isActive = editor.isActive('blockquote');
		        isDisabled = !canRun((c) => c.toggleBlockquote());
	      } else if (action === 'insertHttpLink' || action === 'insertArticleLink') {
	        isActive = false;
	        isDisabled = !isEditing();
	      } else if (action === 'unsetLink') {
	        isActive = editor.isActive('link');
	        isDisabled = !canRun((c) => c.unsetLink());
	      } else if (action === 'toggleBulletList') {
	        isActive = editor.isActive('bulletList');
	        // UX: allow switching ordered -> bullet in one click.
	        if (editor.isActive('orderedList')) {
	          isDisabled = !(canRun((c) => c.toggleOrderedList()) && canRun((c) => c.toggleBulletList()));
        } else {
          isDisabled = !canRun((c) => c.toggleBulletList());
        }
      } else if (action === 'toggleOrderedList') {
        isActive = editor.isActive('orderedList');
        // UX: allow switching bullet -> ordered in one click.
        if (editor.isActive('bulletList')) {
          isDisabled = !(canRun((c) => c.toggleBulletList()) && canRun((c) => c.toggleOrderedList()));
        } else {
          isDisabled = !canRun((c) => c.toggleOrderedList());
        }
      } else if (action === 'unsetList') {
        isActive = false;
        if (editor.isActive('bulletList')) isDisabled = !canRun((c) => c.toggleBulletList());
        else if (editor.isActive('orderedList')) isDisabled = !canRun((c) => c.toggleOrderedList());
        else isDisabled = !canRun((c) => c.liftListItem('listItem'));
      } else if (action === 'insertTable') {
        isActive = false;
        isDisabled = !canRun((c) => c.insertTable({ rows: 2, cols: 2, withHeaderRow: false }));
      } else if (action === 'toggleHeaderRow') {
        isActive = editor.isActive('tableHeader');
        isDisabled = !canRun((c) => c.toggleHeaderRow());
      } else if (action === 'toggleHeaderColumn') {
        isActive = editor.isActive('tableHeader');
        isDisabled = !canRun((c) => c.toggleHeaderColumn());
      } else if (action === 'addRowBefore') {
        isActive = false;
        isDisabled = !canRun((c) => c.addRowBefore());
      } else if (action === 'addRowAfter') {
        isActive = false;
        isDisabled = !canRun((c) => c.addRowAfter());
      } else if (action === 'deleteRow') {
        isActive = false;
        isDisabled = !canRun((c) => c.deleteRow());
      } else if (action === 'addColumnBefore') {
        isActive = false;
        isDisabled = !canRun((c) => c.addColumnBefore());
      } else if (action === 'addColumnAfter') {
        isActive = false;
        isDisabled = !canRun((c) => c.addColumnAfter());
      } else if (action === 'deleteColumn') {
        isActive = false;
        isDisabled = !canRun((c) => c.deleteColumn());
      } else if (action === 'copyColumn' || action === 'pasteColumnAfter' || action === 'moveColumnRight') {
        isActive = false;
        isDisabled = true;
      } else if (action === 'mergeCells') {
        isActive = false;
        isDisabled = !canRun((c) => c.mergeCells());
      } else if (action === 'splitCell') {
        isActive = false;
        isDisabled = !canRun((c) => c.splitCell());
      } else if (action === 'cancelTable') {
        isActive = false;
        isDisabled = !isEditing() || !editor.isActive('table');
      } else if (action === 'deleteTable') {
        isActive = false;
	        isDisabled = !canRun((c) => c.deleteTable());
	      }

      el.disabled = Boolean(isDisabled);
      el.classList.toggle('is-active', Boolean(isActive));
    }
  };

  let syncRaf = null;
  const scheduleSync = () => {
    if (syncRaf) return;
    syncRaf = window.requestAnimationFrame(() => {
      syncRaf = null;
      sync();
    });
  };

  const cleanups = [
    click(btns.undo, () => editor.chain().focus().undo().run()),
    click(btns.redo, () => editor.chain().focus().redo().run()),
  ];

  const TextSelection = tiptap?.pmStateMod?.TextSelection || null;

  const findImmediateParentSectionPosForSectionPos = (doc, sectionPos) => {
    try {
      const $inside = doc.resolve(Math.min(doc.content.size, sectionPos + 1));
      let currentDepth = null;
      for (let d = $inside.depth; d > 0; d -= 1) {
        if ($inside.node(d)?.type?.name !== 'outlineSection') continue;
        const pos = $inside.before(d);
        if (pos === sectionPos) {
          currentDepth = d;
          break;
        }
      }
      if (currentDepth === null) return null;
      for (let d = currentDepth - 1; d > 0; d -= 1) {
        if ($inside.node(d)?.type?.name === 'outlineSection') return $inside.before(d);
      }
      return null;
    } catch {
      return null;
    }
  };

  const moveActiveSection = (dir) => {
    try {
      if (!TextSelection) return;
      editor.commands.command(({ state: pmState, dispatch }) => {
        const sectionPos = findOutlineSectionPosAtSelection(pmState.doc, pmState.selection.$from);
        if (typeof sectionPos !== 'number') return false;
        const $pos = pmState.doc.resolve(sectionPos);
        const idx = $pos.index();
        const parent = $pos.parent;
        if (!parent) return false;
        const sectionNode = pmState.doc.nodeAt(sectionPos);
        if (!sectionNode) return false;

        if (dir === 'up') {
          if (idx > 0) {
            const prevNode = parent.child(idx - 1);
            const prevStart = sectionPos - prevNode.nodeSize;
            let tr = pmState.tr.delete(sectionPos, sectionPos + sectionNode.nodeSize).insert(prevStart, sectionNode);
            tr = tr.setMeta(OUTLINE_ALLOW_META, true);
            tr = tr.setSelection(TextSelection.near(tr.doc.resolve(prevStart + 2), 1));
            dispatch(tr.scrollIntoView());
            return true;
          }

          const parentSectionPos = findImmediateParentSectionPosForSectionPos(pmState.doc, sectionPos);
          if (typeof parentSectionPos !== 'number') return false;
          const $parent = pmState.doc.resolve(parentSectionPos);
          const parentIdx = $parent.index();
          const grandParent = $parent.parent;
          if (!grandParent || parentIdx <= 0) return false;
          const prevUncleNode = grandParent.child(parentIdx - 1);
          const prevUncleStart = parentSectionPos - prevUncleNode.nodeSize;
          const prevUncle = pmState.doc.nodeAt(prevUncleStart);
          if (!prevUncle || prevUncle.type?.name !== 'outlineSection') return false;
          const prevHeading = prevUncle.child(0);
          const prevBody = prevUncle.child(1);
          const prevChildren = prevUncle.child(2);
          const childrenStart = prevUncleStart + 1 + prevHeading.nodeSize + prevBody.nodeSize;
          const baseInsertPos = childrenStart + prevChildren.nodeSize - 1;

          let tr = pmState.tr.delete(sectionPos, sectionPos + sectionNode.nodeSize).setMeta(OUTLINE_ALLOW_META, true);
          const mappedPrevUncleStart = tr.mapping.map(prevUncleStart, -1);
          const mappedInsertPos = tr.mapping.map(baseInsertPos, -1);
          tr = tr.insert(mappedInsertPos, sectionNode);
          const prevAfter = tr.doc.nodeAt(mappedPrevUncleStart);
          if (prevAfter?.type?.name === 'outlineSection' && Boolean(prevAfter.attrs?.collapsed)) {
            tr = tr.setNodeMarkup(mappedPrevUncleStart, undefined, { ...prevAfter.attrs, collapsed: false });
          }
          tr = tr.setSelection(TextSelection.near(tr.doc.resolve(mappedInsertPos + 2), 1));
          dispatch(tr.scrollIntoView());
          return true;
        }
        if (dir === 'down') {
          if (idx < parent.childCount - 1) {
            const nextStart = sectionPos + sectionNode.nodeSize;
            const nextNode = pmState.doc.nodeAt(nextStart);
            if (!nextNode) return false;
            let tr = pmState.tr.delete(sectionPos, sectionPos + sectionNode.nodeSize);
            const insertPos = sectionPos + nextNode.nodeSize;
            tr = tr.insert(insertPos, sectionNode);
            tr = tr.setMeta(OUTLINE_ALLOW_META, true);
            tr = tr.setSelection(TextSelection.near(tr.doc.resolve(insertPos + 2), 1));
            dispatch(tr.scrollIntoView());
            return true;
          }

          const parentSectionPos = findImmediateParentSectionPosForSectionPos(pmState.doc, sectionPos);
          if (typeof parentSectionPos !== 'number') return false;
          const parentSectionNode = pmState.doc.nodeAt(parentSectionPos);
          if (!parentSectionNode || parentSectionNode.type?.name !== 'outlineSection') return false;
          const $parent = pmState.doc.resolve(parentSectionPos);
          const parentIdx = $parent.index();
          const grandParent = $parent.parent;
          if (!grandParent || parentIdx >= grandParent.childCount - 1) return false;

          const nextUncleStart = parentSectionPos + parentSectionNode.nodeSize;
          const nextUncle = pmState.doc.nodeAt(nextUncleStart);
          if (!nextUncle || nextUncle.type?.name !== 'outlineSection') return false;
          const nextHeading = nextUncle.child(0);
          const nextBody = nextUncle.child(1);
          const nextChildren = nextUncle.child(2);
          const childrenStart = nextUncleStart + 1 + nextHeading.nodeSize + nextBody.nodeSize;
          const baseInsertPos = childrenStart + 1;

          let tr = pmState.tr.delete(sectionPos, sectionPos + sectionNode.nodeSize).setMeta(OUTLINE_ALLOW_META, true);
          const mappedNextUncleStart = tr.mapping.map(nextUncleStart, -1);
          const mappedInsertPos = tr.mapping.map(baseInsertPos, -1);
          tr = tr.insert(mappedInsertPos, sectionNode);
          const nextAfter = tr.doc.nodeAt(mappedNextUncleStart);
          if (nextAfter?.type?.name === 'outlineSection' && Boolean(nextAfter.attrs?.collapsed)) {
            tr = tr.setNodeMarkup(mappedNextUncleStart, undefined, { ...nextAfter.attrs, collapsed: false });
          }
          tr = tr.setSelection(TextSelection.near(tr.doc.resolve(mappedInsertPos + 2), 1));
          dispatch(tr.scrollIntoView());
          return true;
        }
        return false;
      });
    } catch {
      // ignore
    }
  };

  const indentActiveSection = () => {
    try {
      if (!TextSelection) return;
      editor.commands.command(({ state: pmState, dispatch }) => {
        const sectionPos = findOutlineSectionPosAtSelection(pmState.doc, pmState.selection.$from);
        if (typeof sectionPos !== 'number') return false;
        const $pos = pmState.doc.resolve(sectionPos);
        let depthCount = 0;
        for (let d = $pos.depth; d >= 0; d -= 1) {
          if ($pos.node(d)?.type?.name === 'outlineSection') depthCount += 1;
        }
        if (depthCount >= 6) return false;
        const idx = $pos.index();
        const parent = $pos.parent;
        if (!parent || idx <= 0) return false;
        const sectionNode = pmState.doc.nodeAt(sectionPos);
        if (!sectionNode) return false;

        const prevNode = parent.child(idx - 1);
        const prevStart = sectionPos - prevNode.nodeSize;
        const prevSection = pmState.doc.nodeAt(prevStart);
        if (!prevSection) return false;
        const prevHeading = prevSection.child(0);
        const prevBody = prevSection.child(1);
        const prevChildren = prevSection.child(2);
        const childrenStart = prevStart + 1 + prevHeading.nodeSize + prevBody.nodeSize;
        const insertPos = childrenStart + prevChildren.nodeSize - 1;

        let tr = pmState.tr.delete(sectionPos, sectionPos + sectionNode.nodeSize).insert(insertPos, sectionNode);
        // Если новый родитель свёрнут, развернём его, чтобы переносимый блок не "исчезал".
        const parentAfter = tr.doc.nodeAt(prevStart);
        if (parentAfter?.type?.name === 'outlineSection' && Boolean(parentAfter.attrs?.collapsed)) {
          tr = tr.setNodeMarkup(prevStart, undefined, { ...parentAfter.attrs, collapsed: false });
        }
        tr = tr.setMeta(OUTLINE_ALLOW_META, true);
        tr = tr.setSelection(TextSelection.near(tr.doc.resolve(insertPos + 2), 1));
        dispatch(tr.scrollIntoView());
        return true;
      });
    } catch {
      // ignore
    }
  };

  const outdentActiveSection = () => {
    try {
      if (!TextSelection) return;
      editor.commands.command(({ state: pmState, dispatch }) => {
        const $from = pmState.selection.$from;
        let currentDepth = null;
        let parentDepth = null;
        for (let d = $from.depth; d > 0; d -= 1) {
          if ($from.node(d)?.type?.name === 'outlineSection') {
            if (currentDepth === null) currentDepth = d;
            else {
              parentDepth = d;
              break;
            }
          }
        }
        if (currentDepth === null || parentDepth === null) return false;
        const sectionPos = $from.before(currentDepth);
        const parentPos = $from.before(parentDepth);
        const sectionNode = pmState.doc.nodeAt(sectionPos);
        if (!sectionNode) return false;

        let tr = pmState.tr.delete(sectionPos, sectionPos + sectionNode.nodeSize);
        const parentAfter = tr.doc.nodeAt(parentPos);
        if (!parentAfter) return false;
        const insertPos = parentPos + parentAfter.nodeSize;
        tr = tr.insert(insertPos, sectionNode);
        tr = tr.setMeta(OUTLINE_ALLOW_META, true);
        tr = tr.setSelection(TextSelection.near(tr.doc.resolve(insertPos + 2), 1));
        dispatch(tr.scrollIntoView());
        return true;
      });
    } catch {
      // ignore
    }
  };

  const deleteActiveSection = () => {
    try {
      if (!TextSelection) return;
      editor.commands.command(({ state: pmState, dispatch }) => {
        const sectionPos = findOutlineSectionPosAtSelection(pmState.doc, pmState.selection.$from);
        if (typeof sectionPos !== 'number') return false;
        const sectionNode = pmState.doc.nodeAt(sectionPos);
        if (!sectionNode) return false;
        const sid = String(sectionNode.attrs?.id || '').trim();
        const $pos = pmState.doc.resolve(sectionPos);
        const idx = $pos.index();
        const parent = $pos.parent;
        if (!parent) return false;

        const schema = pmState.doc.type.schema;
        if (parent.childCount <= 1) {
          const newSection = schema.nodes.outlineSection.create(
            { ...sectionNode.attrs, collapsed: false },
            [
              schema.nodes.outlineHeading.create({}, []),
              schema.nodes.outlineBody.create({}, [schema.nodes.paragraph.create({}, [])]),
              schema.nodes.outlineChildren.create({}, []),
            ],
          );
          let tr = pmState.tr.replaceWith(sectionPos, sectionPos + sectionNode.nodeSize, newSection);
          tr = tr.setMeta(OUTLINE_ALLOW_META, true);
          const heading = newSection.child(0);
          const bodyStart = sectionPos + 1 + heading.nodeSize;
          tr = tr.setSelection(TextSelection.near(tr.doc.resolve(bodyStart + 2), 1));
          dispatch(tr.scrollIntoView());
          return true;
        }

        if (sid) markExplicitSectionDeletion(sid);
        const hasPrev = idx > 0;
        const prevNode = hasPrev ? parent.child(idx - 1) : null;
        const prevStart = hasPrev ? sectionPos - prevNode.nodeSize : null;

        let tr = pmState.tr.delete(sectionPos, sectionPos + sectionNode.nodeSize);
        tr = tr.setMeta(OUTLINE_ALLOW_META, true);

        const targetPos = hasPrev && typeof prevStart === 'number' ? prevStart : Math.min(tr.doc.content.size, sectionPos);
        const targetNode = tr.doc.nodeAt(targetPos);
        if (targetNode?.type?.name === 'outlineSection') {
          const h = targetNode.child(0);
          const b = targetNode.child(1);
          const bodyStart = targetPos + 1 + h.nodeSize;
          if (!b.childCount) {
            tr = tr.insert(bodyStart + 1, schema.nodes.paragraph.create({}, []));
          }
          tr = tr.setSelection(TextSelection.near(tr.doc.resolve(bodyStart + 2), 1));
        }
        dispatch(tr.scrollIntoView());
        return true;
      });
    } catch {
      // ignore
    }
  };

  const insertNewSectionBelow = () => {
    try {
      if (!TextSelection) return;
      editor.commands.command(({ state: pmState, dispatch }) => {
        const sectionPos = findOutlineSectionPosAtSelection(pmState.doc, pmState.selection.$from);
        if (typeof sectionPos !== 'number') return false;
        const sectionNode = pmState.doc.nodeAt(sectionPos);
        if (!sectionNode) return false;
        const schema = pmState.doc.type.schema;
        const insertPos = sectionPos + sectionNode.nodeSize;
        const newId = safeUuid();
        const newSection = schema.nodes.outlineSection.create(
          { id: newId, collapsed: false },
          [
            schema.nodes.outlineHeading.create({}, []),
            schema.nodes.outlineBody.create({}, [schema.nodes.paragraph.create({}, [])]),
            schema.nodes.outlineChildren.create({}, []),
          ],
        );
        let tr = pmState.tr.insert(insertPos, newSection);
        tr = tr.setSelection(TextSelection.create(tr.doc, insertPos + 2));
        tr = tr.setMeta(OUTLINE_ALLOW_META, true);
        if (outlineEditModeKey) {
          tr = tr.setMeta(outlineEditModeKey, { type: 'enter', sectionId: newId });
        }
        dispatch(tr.scrollIntoView());
        return true;
      });
    } catch {
      // ignore
    }
  };

  cleanups.push(click(btns.deleteBtn, () => deleteActiveSection()));
  cleanups.push(click(btns.moveUpBtn, () => moveActiveSection('up')));
  cleanups.push(click(btns.moveDownBtn, () => moveActiveSection('down')));
  cleanups.push(click(btns.outdentBtn, () => outdentActiveSection()));
  cleanups.push(click(btns.indentBtn, () => indentActiveSection()));
  cleanups.push(click(btns.newBelowBtn, () => insertNewSectionBelow()));

  for (const btn of dropdownBtns) {
    cleanups.push(tap(btn, () => toggleMenu(btn)));
  }
		  for (const item of actionButtons) {
		    cleanups.push(
		      click(item, () => {
		        const action = item.dataset.outlineAction || '';
		        if (action === 'insertHttpLink') {
		          closeAllMenus();
		          void insertHttpLink().finally(() => scheduleSync());
		          return;
		        }
		        if (action === 'insertArticleLink') {
		          closeAllMenus();
		          void insertArticleLink().finally(() => scheduleSync());
		          return;
		        }
		        const ok = runAction(action);
		        closeAllMenus();
		        if (ok) scheduleSync();
		      }),
		    );
		  }

		  for (const item of clipboardButtons) {
		    cleanups.push(
		      click(item, () => {
		        const action = item.getAttribute('data-outline-clipboard-action') || '';
		        if (!action) return;
		        closeAllMenus();

		        const activeId = lastActiveSectionId || null;
		        const selected = outlineSelectedSectionIds instanceof Set ? outlineSelectedSectionIds : new Set();
		        const effective = selected.size ? new Set(selected) : activeId ? new Set([activeId]) : new Set();

		        if (action === 'toggleSelectMode') {
		          setOutlineSelectionMode(!outlineSelectionMode);
		          return;
		        }
		        if (action === 'clear') {
		          writeOutlineSectionClipboard(null);
		          showToast('Буфер очищен');
		          return;
		        }
		        if (!outlineEditorInstance) return;

		        if (action === 'copy' || action === 'cut') {
		          if (!effective.size) {
		            showToast('Выберите блок');
		            return;
		          }
		          const roots = collectSelectedRootSections(outlineEditorInstance.state.doc, effective);
		          if (!roots.length) {
		            showToast('Выберите блок');
		            return;
		          }
		          const sectionsJson = roots.map((r) => r.node.toJSON());
		          try {
		            const text = roots.map((r) => buildMarkdownFromOutlineSectionNode(r.node)).filter(Boolean).join('\n\n');
		            void writeTextToSystemClipboard(text);
		          } catch {
		            // ignore
		          }
		          writeOutlineSectionClipboard({
		            mode: action === 'cut' ? 'cut' : 'copy',
		            sourceArticleId: outlineArticleId || state.articleId || null,
		            createdAt: new Date().toISOString(),
		            sections: sectionsJson,
		          });
		          if (action === 'copy') {
		            showToast(`Скопировано блоков: ${sectionsJson.length}`);
		            return;
		          }

		          const positions = [];
		          for (const r of roots) {
		            const pos = findSectionPosById(outlineEditorInstance.state.doc, r.id);
		            const node = typeof pos === 'number' ? outlineEditorInstance.state.doc.nodeAt(pos) : null;
		            if (typeof pos === 'number' && node) positions.push({ pos, size: node.nodeSize });
		          }
		          positions.sort((a, b) => b.pos - a.pos);
		          let tr = outlineEditorInstance.state.tr;
		          for (const { pos, size } of positions) {
		            tr = tr.delete(pos, pos + size);
		          }
		          tr = tr.setMeta(OUTLINE_ALLOW_META, true);
		          outlineEditorInstance.view.dispatch(tr.scrollIntoView());
		          outlineEditorInstance.view.focus();
		          docDirty = true;
		          scheduleAutosave({ delayMs: 200 });
		          setOutlineSelectionMode(false);
		          showToast(`Вырезано блоков: ${sectionsJson.length}`);
		          return;
		        }

		        if (action === 'paste') {
		          const clip = readOutlineSectionClipboard();
		          if (!clip || !Array.isArray(clip.sections) || !clip.sections.length) {
		            showToast('Буфер пуст');
		            return;
		          }
		          const pmState = outlineEditorInstance.state;
		          let insertPos = pmState.doc.content.size;
		          if (activeId) {
		            const pos = findSectionPosById(pmState.doc, activeId);
		            const node = typeof pos === 'number' ? pmState.doc.nodeAt(pos) : null;
		            if (typeof pos === 'number' && node) insertPos = pos + node.nodeSize;
		          }

		          const existingIds = new Set();
		          try {
		            pmState.doc.descendants((n) => {
		              if (n?.type?.name !== 'outlineSection') return;
		              const sid = String(n.attrs?.id || '').trim();
		              if (sid) existingIds.add(sid);
		            });
		          } catch {
		            // ignore
		          }

		          const sectionJsons = [];
		          if (clip.mode === 'copy') {
		            for (const s of clip.sections) {
		              sectionJsons.push(remapOutlineSectionIds(s, () => safeUuid()));
		            }
		          } else {
		            for (const s of clip.sections) {
		              const sid = String(s?.attrs?.id || '').trim();
		              if (sid && existingIds.has(sid)) {
		                showToast('Нельзя вставить: блок с таким id уже есть');
		                return;
		              }
		              sectionJsons.push(cloneJson(s));
		            }
		          }

		          const schema = pmState.doc.type.schema;
		          const nodes = [];
		          for (const j of sectionJsons) {
		            try {
		              const n = schema.nodeFromJSON(j);
		              if (n?.type?.name === 'outlineSection') nodes.push(n);
		            } catch {
		              // ignore
		            }
		          }
		          if (!nodes.length) {
		            showToast('Не удалось вставить блоки');
		            return;
		          }
		          let tr = pmState.tr;
		          let pos = insertPos;
		          for (const n of nodes) {
		            tr = tr.insert(pos, n);
		            pos += n.nodeSize;
		          }
		          tr = tr.setMeta(OUTLINE_ALLOW_META, true);
		          outlineEditorInstance.view.dispatch(tr.scrollIntoView());
		          outlineEditorInstance.view.focus();
		          docDirty = true;
		          scheduleAutosave({ delayMs: 200 });
		          if (clip.mode === 'cut') {
		            writeOutlineSectionClipboard(null);
		          }
		          setOutlineSelectionMode(false);
		          showToast(`Вставлено блоков: ${nodes.length}`);
		        }
		      }),
		    );
		  }

	  const onDocPointerDown = (event) => {
	    if (!state.isOutlineEditing) return;
	    if (!root.contains(event.target)) {
	      closeAllMenus();
    }
  };
  const onDocKeyDown = (event) => {
    if (!state.isOutlineEditing) return;
    if (event.key === 'Escape') {
      closeAllMenus();
    }
  };
  document.addEventListener('pointerdown', onDocPointerDown);
  document.addEventListener('keydown', onDocKeyDown);
  cleanups.push(() => document.removeEventListener('pointerdown', onDocPointerDown));
  cleanups.push(() => document.removeEventListener('keydown', onDocKeyDown));

  const offTx = editor.on('transaction', scheduleSync);
  const offSel = editor.on('selectionUpdate', scheduleSync);
  cleanups.push(() => offTx?.());
  cleanups.push(() => offSel?.());

  // Tags bar interactions (highlight + expand).
  try {
    const offTags = attachOutlineTagsBarHandlers({
      setActiveTagKey: (key) => {
        try {
          outlineSetActiveTagKey?.(key);
        } catch {
          // ignore
        }
      },
    });
    cleanups.push(() => offTags?.());
  } catch {
    // ignore
  }

  scheduleSync();

  outlineToolbarCleanup = () => {
    if (syncRaf) {
      window.cancelAnimationFrame(syncRaf);
      syncRaf = null;
    }
    for (const fn of cleanups) {
      try {
        fn();
      } catch {
        // ignore
      }
    }
  };
}

function unmountOutlineToolbar() {
  if (outlineToolbarCleanup) {
    try {
      outlineToolbarCleanup();
    } catch {
      // ignore
    }
  }
  outlineToolbarCleanup = null;
}

function formatTimeShort(date) {
  try {
    return new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date);
  } catch {
    return '';
  }
}

function setOutlineStatus(text = '') {
  const value = String(text || '');
  state.outlineStatusText = value;
  // В режиме outline показываем статус в месте updatedAt (в меню статьи),
  // чтобы не плодить отдельные панели и элементы интерфейса.
  if (refs.updatedAt && state.isOutlineEditing) {
    refs.updatedAt.textContent = value;
  }
}

function moveCursorToSectionBodyStart(editor, sectionPos) {
  if (!editor) return false;
  if (typeof sectionPos !== 'number') return false;
  try {
    const pmState = editor.state;
    const sectionNode = pmState.doc.nodeAt(sectionPos);
    if (!sectionNode) return false;
    const heading = sectionNode.child(0);
    const body = sectionNode.child(1);
    const bodyStart = sectionPos + 1 + heading.nodeSize;
    // Ensure there is at least one paragraph so selection can be placed inside.
    let tr = pmState.tr;
    if (!body.childCount) {
      const schema = pmState.doc.type.schema;
      tr = tr.insert(bodyStart + 1, schema.nodes.paragraph.create({}, []));
    }
    const { TextSelection } = tiptap?.pmStateMod || {};
    if (!TextSelection) return false;
    tr = tr.setSelection(TextSelection.near(tr.doc.resolve(bodyStart + 2), 1));
    editor.view.dispatch(tr.scrollIntoView());
    editor.view.focus?.({ preventScroll: true });
    return true;
  } catch {
    return false;
  }
}

function moveCursorToSectionHeadingStart(editor, sectionPos) {
  if (!editor) return false;
  if (typeof sectionPos !== 'number') return false;
  try {
    const pmState = editor.state;
    const sectionNode = pmState.doc.nodeAt(sectionPos);
    if (!sectionNode) return false;
    const heading = sectionNode.child(0);
    const headingPos = sectionPos + 1;
    const { TextSelection } = tiptap?.pmStateMod || {};
    if (!TextSelection) return false;
    const from = headingPos + 1;
    const to = headingPos + heading.nodeSize - 1;
    const anchor = Math.min(Math.max(from, from), Math.max(from, to));
    let tr = pmState.tr.setSelection(TextSelection.near(pmState.doc.resolve(anchor), 1));
    tr = tr.setMeta(OUTLINE_ALLOW_META, true);
    editor.view.dispatch(tr.scrollIntoView());
    editor.view.focus?.({ preventScroll: true });
    return true;
  } catch {
    return false;
  }
}

function moveCursorToSectionHeadingEnd(editor, sectionPos) {
  if (!editor) return false;
  if (typeof sectionPos !== 'number') return false;
  try {
    const pmState = editor.state;
    const sectionNode = pmState.doc.nodeAt(sectionPos);
    if (!sectionNode) return false;
    const heading = sectionNode.child(0);
    const headingPos = sectionPos + 1;
    const { TextSelection } = tiptap?.pmStateMod || {};
    if (!TextSelection) return false;
    const from = headingPos + 1;
    const to = headingPos + heading.nodeSize - 1;
    const anchor = Math.max(from, to);
    let tr = pmState.tr.setSelection(TextSelection.near(pmState.doc.resolve(anchor), -1));
    tr = tr.setMeta(OUTLINE_ALLOW_META, true);
    editor.view.dispatch(tr.scrollIntoView());
    editor.view.focus?.({ preventScroll: true });
    return true;
  } catch {
    return false;
  }
}

function moveCursorToSectionPreferredStart(editor, sectionId) {
  try {
    if (!editor) return false;
    const sid = String(sectionId || '').trim();
    if (!sid) return false;
    const pmState = editor.state;
    const pos = findSectionPosById(pmState.doc, sid);
    if (typeof pos !== 'number') return false;
    const node = pmState.doc.nodeAt(pos);
    if (!node || node.type?.name !== 'outlineSection') return false;
    if (Boolean(node.attrs?.collapsed)) return moveCursorToSectionHeadingStart(editor, pos);
    // Avoid mutating the document on open: if body is empty, place caret at the end of the heading.
    try {
      const body = node.child(1);
      if (!body?.childCount) return moveCursorToSectionHeadingEnd(editor, pos);
    } catch {
      // ignore
    }
    return moveCursorToSectionBodyStart(editor, pos);
  } catch {
    return false;
  }
}

function moveCursorToActiveSectionBodyStart(editor) {
  if (!editor) return false;
  try {
    const pmState = editor.state;
    const { selection } = pmState;
    if (!selection) return false;
    const sectionPos = findOutlineSectionPosAtSelection(pmState.doc, selection.$from);
    if (typeof sectionPos !== 'number') return false;
    return moveCursorToSectionBodyStart(editor, sectionPos);
  } catch {
    return false;
  }
}

async function loadTiptap() {
  if (tiptap) return tiptap;
  if (typeof window === 'undefined') {
    throw new Error('Outline editor is browser-only');
  }
  // TipTap загружаем локально (собранный bundle), чтобы не зависеть от CDN.
  // Если нужно пересобрать: `cd TTree && npm run build:tiptap`.
  const t0 = perfEnabled() ? performance.now() : 0;
  const mod = await import('./tiptap.bundle.js');
  if (t0) perfLog('import tiptap.bundle.js', { ms: Math.round(performance.now() - t0) });
  tiptap = {
    core: mod.core,
    starterKitMod: mod.starterKitMod,
    htmlMod: mod.htmlMod,
    pmStateMod: mod.pmStateMod,
    pmViewMod: mod.pmViewMod,
    pmTablesMod: mod.pmTablesMod,
    linkMod: mod.linkMod,
    imageMod: mod.imageMod,
    tableMod: mod.tableMod,
    tableRowMod: mod.tableRowMod,
    tableCellMod: mod.tableCellMod,
    tableHeaderMod: mod.tableHeaderMod,
    uniqueIdMod: mod.uniqueIdMod,
    markdownMod: mod.markdownMod,
  };
  return tiptap;
}

function buildOutlineDocFromBlocks({ blocks, parseHtmlToNodes }) {
  const ensureParagraph = (content) => {
    if (Array.isArray(content) && content.length > 0) return content;
    return [{ type: 'paragraph', content: [] }];
  };

  const convertBlock = (blk) => {
    const id = String(blk?.id || safeUuid());
    const collapsed = Boolean(blk?.collapsed);
    const sections = extractBlockSections(String(blk?.text || ''));
    // Заголовок секции — это отдельное поле; не подменяем его первой строкой body,
    // иначе при удалении заголовка body "переедет" в заголовок при следующем открытии.
    const titleText = stripHtml(sections.titleHtml) || '';
    const bodyNodes = ensureParagraph(parseHtmlToNodes(sections.bodyHtml || ''));
    const children = Array.isArray(blk?.children) ? blk.children : [];
    return {
      type: 'outlineSection',
      attrs: { id, collapsed },
      content: [
        { type: 'outlineHeading', content: titleText ? [{ type: 'text', text: titleText }] : [] },
        { type: 'outlineBody', content: bodyNodes },
        {
          type: 'outlineChildren',
          content: children.map(convertBlock),
        },
      ],
    };
  };

  const sections = (Array.isArray(blocks) ? blocks : []).map(convertBlock);
  return { type: 'doc', content: sections.length ? sections : [convertBlock({ id: safeUuid(), text: '', collapsed: false, children: [] })] };
}

function readOutlineLastActiveSnapshot(articleId) {
  try {
    const aid = String(articleId || '').trim();
    if (!aid) return null;
    const raw = window?.localStorage?.getItem?.('ttree_outline_last_active_v1') || '{}';
    const parsed = JSON.parse(raw || '{}');
    const row = parsed && typeof parsed === 'object' ? parsed[aid] : null;
    if (!row || typeof row !== 'object') return null;
    const sectionId = String(row.sectionId || '').trim();
    if (!sectionId) return null;
    return { sectionId, collapsed: Boolean(row.collapsed) };
  } catch {
    return null;
  }
}

function writeOutlineLastActiveSnapshot(articleId, sectionId, collapsed) {
  try {
    const aid = String(articleId || '').trim();
    const sid = String(sectionId || '').trim();
    if (!aid || !sid) return false;
    const raw = window?.localStorage?.getItem?.('ttree_outline_last_active_v1') || '{}';
    const parsed = JSON.parse(raw || '{}');
    const next = parsed && typeof parsed === 'object' ? parsed : {};
    next[aid] = { sectionId: sid, collapsed: Boolean(collapsed), savedAt: new Date().toISOString() };
    window?.localStorage?.setItem?.('ttree_outline_last_active_v1', JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}

function maybeWriteActiveOutlineSnapshotFromEditor(editor) {
  try {
    const articleId = outlineArticleId || state.articleId || null;
    if (!articleId) return false;
    if (!editor || editor.isDestroyed) return false;
    const pmState = editor.state;
    const sectionPos = findOutlineSectionPosAtSelection(pmState.doc, pmState.selection.$from);
    if (typeof sectionPos !== 'number') return false;
    const node = pmState.doc.nodeAt(sectionPos);
    if (!node || node.type?.name !== 'outlineSection') return false;
    const sectionId = String(node.attrs?.id || '').trim();
    if (!sectionId) return false;
    const collapsed = Boolean(node.attrs?.collapsed);
    if (
      lastActiveSnapshotMemo.articleId === articleId &&
      lastActiveSnapshotMemo.sectionId === sectionId &&
      lastActiveSnapshotMemo.collapsed === collapsed
    ) {
      return false;
    }
    lastActiveSnapshotMemo = { articleId, sectionId, collapsed };
    return writeOutlineLastActiveSnapshot(articleId, sectionId, collapsed);
  } catch {
    return false;
  }
}

function patchDocJsonCollapsedForPath(docJson, sectionId, targetCollapsed) {
  try {
    const sid = String(sectionId || '').trim();
    if (!docJson || typeof docJson !== 'object' || !sid) return false;
    let changed = false;
    const stack = [];
    const visit = (node) => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'outlineSection') {
        const id = String(node?.attrs?.id || '').trim();
        if (id === sid) {
          // Ensure the whole path is visible.
          for (const ancestor of stack) {
            if (ancestor?.attrs && ancestor.attrs.collapsed) {
              ancestor.attrs = { ...(ancestor.attrs || {}), collapsed: false };
              changed = true;
            }
          }
          if (typeof targetCollapsed === 'boolean') {
            const nextCollapsed = Boolean(targetCollapsed);
            if (Boolean(node?.attrs?.collapsed) !== nextCollapsed) {
              node.attrs = { ...(node.attrs || {}), collapsed: nextCollapsed };
              changed = true;
            }
          }
        }
      }
      const content = node.content;
      if (Array.isArray(content)) {
        if (node.type === 'outlineSection') stack.push(node);
        content.forEach(visit);
        if (node.type === 'outlineSection') stack.pop();
      }
    };
    visit(docJson);
    return changed;
  } catch {
    return false;
  }
}

function findOutlineSectionPosAtSelection(doc, $from) {
  try {
    // When a whole section node is selected (NodeSelection), the resolved $from is placed
    // before the node, so the section is available as `$from.nodeAfter`.
    if ($from?.nodeAfter?.type?.name === 'outlineSection') return $from.pos;
  } catch {
    // ignore
  }
  for (let d = $from.depth; d > 0; d -= 1) {
    if ($from.node(d)?.type?.name === 'outlineSection') return $from.before(d);
  }
  return null;
}

function computeSectionIndexText(sectionNode) {
  if (!sectionNode) return '';
  const headingNode = sectionNode.child(0);
  const bodyNode = sectionNode.child(1);
  const titlePlain = normalizeWhitespace(headingNode?.textContent || '');
  let bodyPlain = '';
  try {
    bodyPlain = normalizeWhitespace(bodyNode?.textBetween?.(0, bodyNode.content.size, '\n', '\n') || '');
  } catch {
    bodyPlain = normalizeWhitespace(bodyNode?.textContent || '');
  }
  return normalizeWhitespace(`${titlePlain}\n${bodyPlain}`);
}

function computeSectionBodyPlain(sectionNode) {
  if (!sectionNode) return '';
  const bodyNode = sectionNode.child(1);
  let bodyPlain = '';
  try {
    bodyPlain = normalizeWhitespace(bodyNode?.textBetween?.(0, bodyNode.content.size, '\n', '\n') || '');
  } catch {
    bodyPlain = normalizeWhitespace(bodyNode?.textContent || '');
  }
  return bodyPlain;
}

function bodyNodeToHtml(bodyNode) {
  if (!outlineGenerateHTML || !outlineHtmlExtensions) return '';
  const content = [];
  bodyNode?.content?.forEach?.((child) => {
    content.push(child.toJSON());
  });
  const doc = { type: 'doc', content };
  const html = outlineGenerateHTML(doc, outlineHtmlExtensions) || '';
  return (html || '').trim();
}

function applyBodyHtmlToSection(editor, sectionId, html) {
  if (!editor || !sectionId) return false;
  if (!outlineParseHtmlToNodes) return false;
  const pos = findSectionPosById(editor.state.doc, sectionId);
  if (typeof pos !== 'number') return false;
  const sectionNode = editor.state.doc.nodeAt(pos);
  if (!sectionNode) return false;
  const headingNode = sectionNode.child(0);
  const bodyNode = sectionNode.child(1);
  const bodyPos = pos + 1 + headingNode.nodeSize;
  const schema = editor.state.schema;
  let nodesJson = [];
  try {
    nodesJson = outlineParseHtmlToNodes(html || '');
  } catch {
    nodesJson = [];
  }
  let nodes = [];
  try {
    nodes = (Array.isArray(nodesJson) ? nodesJson : []).map((n) => schema.nodeFromJSON(n));
  } catch {
    nodes = [schema.nodes.paragraph.create({}, [])];
  }
  if (!nodes.length) {
    nodes = [schema.nodes.paragraph.create({}, [])];
  }
  const newBody = schema.nodes.outlineBody.create({}, nodes);
  const tr = editor.state.tr
    .replaceWith(bodyPos, bodyPos + bodyNode.nodeSize, newBody)
    .setMeta(OUTLINE_ALLOW_META, true);
  editor.view.dispatch(tr);
  return true;
}

function isHeadingEmpty(sectionNode) {
  if (!sectionNode) return true;
  const headingNode = sectionNode.child(0);
  return !normalizeWhitespace(headingNode?.textContent || '');
}

function applyGeneratedHeading(editor, sectionId, titleText) {
  if (!editor || !sectionId) return false;
  const pos = findSectionPosById(editor.state.doc, sectionId);
  if (typeof pos !== 'number') return false;
  const sectionNode = editor.state.doc.nodeAt(pos);
  if (!sectionNode) return false;
  if (!isHeadingEmpty(sectionNode)) return false;
  const headingNode = sectionNode.child(0);
  const headingStart = pos + 1;
  const from = headingStart + 1;
  const to = headingStart + headingNode.nodeSize - 1;
  const title = String(titleText || '').trim();
  if (!title) return false;
  const safe = title.length > 200 ? title.slice(0, 200) : title;
  const tr = editor.state.tr.insertText(safe, from, to).setMeta(OUTLINE_ALLOW_META, true);
  editor.view.dispatch(tr);
  return true;
}

function rebuildCommittedIndexTextMap(doc) {
  committedSectionIndexText.clear();
  doc.descendants((node) => {
    if (node?.type?.name !== 'outlineSection') return;
    const id = String(node.attrs?.id || '');
    if (!id) return;
    committedSectionIndexText.set(id, computeSectionIndexText(node));
  });
}

function findSectionPosById(doc, sectionId) {
  let found = null;
  doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node?.type?.name !== 'outlineSection') return;
    if (String(node.attrs?.id || '') !== String(sectionId || '')) return;
    found = pos;
  });
  return found;
}

function convertInlineMultilineCodeToCodeBlockInSection(state, sectionId) {
  try {
    const doc = state.doc;
    const sectionPos = findSectionPosById(doc, sectionId);
    const sectionNode = typeof sectionPos === 'number' ? doc.nodeAt(sectionPos) : null;
    if (!sectionNode) return null;

    const schema = state.schema;
    const codeMark = schema.marks?.code || null;
    const codeBlockType = schema.nodes?.codeBlock || null;
    if (!codeMark || !codeBlockType) return null;

    const headingNode = sectionNode.child(0);
    const bodyNode = sectionNode.child(1);
    if (!headingNode || !bodyNode) return null;

    const outlineBodyPos = sectionPos + 1 + headingNode.nodeSize;
    const bodyContentStart = outlineBodyPos + 1;

    const candidates = [];

    bodyNode.descendants((node, pos) => {
      if (!node || node.type?.name !== 'paragraph') return;

      let hasCodeText = false;
      let hasHardBreak = false;
      let allCodeish = true;

      for (let i = 0; i < node.childCount; i += 1) {
        const child = node.child(i);
        if (!child) continue;
        if (child.type?.name === 'hardBreak') {
          hasHardBreak = true;
          continue;
        }
        if (child.isText) {
          const text = String(child.text || '');
          if (!text) continue;
          const marks = Array.isArray(child.marks) ? child.marks : [];
          const isCode = marks.some((m) => m?.type === codeMark);
          if (!isCode) {
            allCodeish = false;
            break;
          }
          hasCodeText = true;
          continue;
        }
        allCodeish = false;
        break;
      }

      // Convert only multiline inline-code (<code> with <br>), not single-line inline code.
      if (!allCodeish || !hasCodeText || !hasHardBreak) return;

      let text = '';
      for (let i = 0; i < node.childCount; i += 1) {
        const child = node.child(i);
        if (!child) continue;
        if (child.type?.name === 'hardBreak') {
          text += '\n';
          continue;
        }
        if (child.isText) {
          text += String(child.text || '');
        }
      }
      if (!text.trim()) return;

      const absFrom = bodyContentStart + pos;
      candidates.push({ from: absFrom, to: absFrom + node.nodeSize, text });
    });

    if (!candidates.length) return null;

    let tr = state.tr;
    // Apply from bottom to top to keep positions stable.
    for (let i = candidates.length - 1; i >= 0; i -= 1) {
      const { from, to, text } = candidates[i];
      const $pos = tr.doc.resolve(from);
      const parent = $pos.parent;
      const index = $pos.index();
      if (!parent?.canReplaceWith?.(index, index + 1, codeBlockType)) continue;

      const content = schema.text(text);
      const codeBlock = codeBlockType.create(null, content);
      tr = tr.replaceWith(from, to, codeBlock);
    }

    if (!tr.docChanged) return null;
    return tr.setMeta(OUTLINE_ALLOW_META, true);
  } catch {
    return null;
  }
}

function maybeGenerateTitleOnLeave(editor, doc, sectionId) {
  if (!editor || !doc || !sectionId) return;
  if (state.article?.encrypted) return;

  const pos = findSectionPosById(doc, sectionId);
  const sectionNode = typeof pos === 'number' ? doc.nodeAt(pos) : null;
  if (!sectionNode) return;
  if (!isHeadingEmpty(sectionNode)) return;
  const bodyPlain = computeSectionBodyPlain(sectionNode);
  if (!bodyPlain) return;

  const bodyHash = hashTextForTitle(bodyPlain);
  const prev = titleGenState.get(sectionId) || null;
  if (prev?.inFlight) return;
  if (prev?.bodyHash === bodyHash) return;

  titleGenState.set(sectionId, { bodyHash, inFlight: true });
  generateOutlineTitle(bodyPlain)
    .then((res) => {
      const title = String(res?.title || '').trim();
      if (!title) return;
      if (title.length > 200) return;
      const currentDoc = editor.state.doc;
      const currentPos = findSectionPosById(currentDoc, sectionId);
      const currentNode = typeof currentPos === 'number' ? currentDoc.nodeAt(currentPos) : null;
      if (!currentNode) return;
      if (!isHeadingEmpty(currentNode)) return;
      const currentBody = computeSectionBodyPlain(currentNode);
      if (hashTextForTitle(currentBody) !== bodyHash) return;
      const applied = applyGeneratedHeading(editor, sectionId, title);
      if (!applied) return;
      docDirty = true;
      scheduleAutosave({ delayMs: 900 });
    })
    .catch(() => {})
    .finally(() => {
      titleGenState.set(sectionId, { bodyHash, inFlight: false });
    });
}

function maybeGenerateTitlesAfterSave(editor, doc, sectionIds) {
  if (!editor || !doc) return;
  if (!Array.isArray(sectionIds) || !sectionIds.length) return;
  if (state.article?.encrypted) return;
  if (typeof navigator !== 'undefined' && navigator && navigator.onLine === false) return;
  for (const sectionId of sectionIds) {
    try {
      maybeGenerateTitleOnLeave(editor, doc, sectionId);
    } catch {
      // ignore
    }
  }
}

function maybeProofreadOnLeave(editor, doc, sectionId) {
  const sid = String(sectionId || '').trim();
  const logSkip = (reason, extra = {}) => proofreadDebug('skip', { reason, sectionId: sid, ...extra });

  if (!editor || !doc || !sid) {
    logSkip('missing_args', { hasEditor: Boolean(editor), hasDoc: Boolean(doc), hasSectionId: Boolean(sid) });
    return;
  }
  if (state.article?.encrypted) {
    logSkip('encrypted_article');
    return;
  }
  try {
    if (typeof navigator !== 'undefined' && navigator && navigator.onLine === false) {
      logSkip('offline');
      return;
    }
  } catch {
    // ignore
  }

  const pos = findSectionPosById(doc, sid);
  const sectionNode = typeof pos === 'number' ? doc.nodeAt(pos) : null;
  if (!sectionNode) {
    logSkip('section_not_found', { pos: typeof pos === 'number' ? pos : null });
    return;
  }
  const bodyNode = sectionNode.child(1);
  const bodyHtml = bodyNodeToHtml(bodyNode);
  if (!bodyHtml) {
    logSkip('empty_body_html');
    return;
  }

  const htmlHash = hashTextForProofread(bodyHtml);
  const prev = proofreadState.get(sid) || null;
  if (prev?.inFlight) {
    logSkip('already_in_flight', { htmlHash });
    return;
  }
  if (prev?.status === 'ok' && prev?.htmlHash === htmlHash) {
    logSkip('already_ok_same_hash', { htmlHash });
    return;
  }
  if (prev?.status === 'error' && prev?.htmlHash === htmlHash) {
    const lastAttemptAtMs = Number(prev?.lastAttemptAtMs || 0) || 0;
    if (Date.now() - lastAttemptAtMs < PROOFREAD_RETRY_COOLDOWN_MS) {
      logSkip('error_cooldown', { htmlHash, lastAttemptAtMs, cooldownMs: PROOFREAD_RETRY_COOLDOWN_MS });
      return;
    }
  }

  proofreadDebug('start', { sectionId: sid, htmlHash });
  proofreadState.set(sid, { htmlHash, inFlight: true, status: prev?.status || 'ok', lastAttemptAtMs: Date.now() });
  proofreadOutlineHtml(bodyHtml)
    .then((res) => {
      const correctedHtml = String(res?.html || '').trim();
      if (!correctedHtml) {
        proofreadDebug('skip_apply', { sectionId: sid, reason: 'empty_corrected_html' });
        return;
      }
      const currentDoc = editor.state.doc;
      const currentPos = findSectionPosById(currentDoc, sid);
      const currentNode = typeof currentPos === 'number' ? currentDoc.nodeAt(currentPos) : null;
      if (!currentNode) {
        proofreadDebug('skip_apply', { sectionId: sid, reason: 'section_not_found_current_doc' });
        return;
      }
      const currentBodyHtml = bodyNodeToHtml(currentNode.child(1));
      if (hashTextForProofread(currentBodyHtml) !== htmlHash) {
        proofreadDebug('skip_apply', { sectionId: sid, reason: 'body_changed_since_request' });
        return;
      }
      if (hashTextForProofread(correctedHtml) === htmlHash) {
        proofreadDebug('skip_apply', { sectionId: sid, reason: 'no_changes_from_server' });
        return;
      }
      const applied = applyBodyHtmlToSection(editor, sid, correctedHtml);
      if (!applied) {
        proofreadDebug('skip_apply', { sectionId: sid, reason: 'apply_failed' });
        return;
      }
      docDirty = true;
      scheduleAutosave({ delayMs: 900 });
    })
    .catch(() => {
      proofreadDebug('error', { sectionId: sid, htmlHash });
      proofreadState.set(sid, { htmlHash, inFlight: false, status: 'error', lastAttemptAtMs: Date.now() });
    })
    .finally(() => {
      const next = proofreadState.get(sid) || null;
      if (next?.status === 'error') return;
      proofreadState.set(sid, { htmlHash, inFlight: false, status: 'ok', lastAttemptAtMs: Date.now() });
      proofreadDebug('done', { sectionId: sid, htmlHash });
    });
}

function markSectionDirtyIfChanged(doc, sectionId) {
  if (!sectionId) return false;
  const pos = findSectionPosById(doc, sectionId);
  if (typeof pos !== 'number') return false;
  const node = doc.nodeAt(pos);
  if (!node) return false;
  const current = computeSectionIndexText(node);
  const committed = committedSectionIndexText.get(sectionId) || '';
  if (current === committed) return false;
  dirtySectionIds.add(sectionId);
  return true;
}

function scheduleAutosave({ delayMs = 1200 } = {}) {
  if (!state.isOutlineEditing) return;
  if (!outlineEditorInstance) return;
  if (state.isPublicView) return;
  if (outlineArticleId && state.articleId && outlineArticleId !== state.articleId) return;
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    autosaveTimer = null;
    void runAutosave();
  }, Math.max(200, delayMs));
}

async function runAutosave({ force = false } = {}) {
  if (!state.isOutlineEditing) return;
  if (!outlineEditorInstance) return;
  if (state.isPublicView) return;
  if (outlineArticleId && state.articleId && outlineArticleId !== state.articleId) return;
  if (autosaveInFlight) return;
  if (!force && !docDirty && !dirtySectionIds.size) return;
  autosaveInFlight = true;
  setOutlineStatus('Сохраняем…');
  try {
    // Если пользователь менял текст и не покидал секцию, помечаем текущую секцию dirty,
    // чтобы семантика “истории секций” оставалась корректной.
    try {
      const pmState = outlineEditorInstance.state;
      const pos = findOutlineSectionPosAtSelection(pmState.doc, pmState.selection.$from);
      if (typeof pos === 'number') {
        const node = pmState.doc.nodeAt(pos);
        const id = String(node?.attrs?.id || '');
        if (id) markSectionDirtyIfChanged(pmState.doc, id);
      }
    } catch {
      // ignore
    }
    await saveOutlineEditor({ silent: true, mode: 'queue' });
  } finally {
    autosaveInFlight = false;
  }
}

async function mountOutlineEditor() {
  if (!refs.outlineEditor) return;
  const contentRoot = refs.outlineEditor.querySelector('#outlineEditorContent');
  if (!contentRoot) {
    showToast('Не удалось смонтировать outline-редактор');
    return;
  }

  // Защита от двойного mount (например, если юзер кликнул дважды пока грузим tiptap).
  if (mountPromise) return mountPromise;
  mountPromise = (async () => {
  const mountStart = perfEnabled() ? performance.now() : 0;
  const loadStart = perfEnabled() ? performance.now() : 0;
  const { core, starterKitMod, htmlMod, pmStateMod, pmViewMod } = await loadTiptap();
  if (loadStart) perfLog('loadTiptap()', { ms: Math.round(performance.now() - loadStart) });
  const { Editor, Node, Extension, InputRule, mergeAttributes } = core;
  const StarterKit = starterKitMod.default || starterKitMod.StarterKit || starterKitMod;
  const { generateJSON, generateHTML } = htmlMod;
  const { TextSelection } = pmStateMod;
  const { Plugin, PluginKey } = pmStateMod;
		  const { Decoration, DecorationSet } = pmViewMod;
	  const Link = tiptap.linkMod.default || tiptap.linkMod.Link || tiptap.linkMod;
	  const Image = tiptap.imageMod.default || tiptap.imageMod.Image || tiptap.imageMod;
	  const TableKit = tiptap.tableMod.TableKit || tiptap.tableMod.tableKit;
		  outlineTableApi = {
		    TableMap: tiptap.pmTablesMod?.TableMap || null,
		    CellSelection: tiptap.pmTablesMod?.CellSelection || null,
		    moveTableColumn: tiptap.pmTablesMod?.moveTableColumn || null,
		    moveTableRow: tiptap.pmTablesMod?.moveTableRow || null,
		    addRowBefore: tiptap.pmTablesMod?.addRowBefore || null,
		    addRowAfter: tiptap.pmTablesMod?.addRowAfter || null,
		    deleteRow: tiptap.pmTablesMod?.deleteRow || null,
		    addColumnBefore: tiptap.pmTablesMod?.addColumnBefore || null,
		    addColumnAfter: tiptap.pmTablesMod?.addColumnAfter || null,
		    deleteColumn: tiptap.pmTablesMod?.deleteColumn || null,
		    toggleHeaderRow: tiptap.pmTablesMod?.toggleHeaderRow || null,
		    toggleHeaderColumn: tiptap.pmTablesMod?.toggleHeaderColumn || null,
		  };
	  const UniqueID = tiptap.uniqueIdMod.default || tiptap.uniqueIdMod.UniqueID || tiptap.uniqueIdMod;
	  const Markdown = tiptap.markdownMod?.Markdown || tiptap.markdownMod?.default?.Markdown || tiptap.markdownMod?.default || null;

	  const parseWidthPx = (value) => {
	    const raw = String(value || '').trim();
	    if (!raw) return null;
	    const m = raw.match(/(\d+(?:\.\d+)?)px/i);
	    if (!m) return null;
	    const num = Number.parseFloat(m[1]);
	    return Number.isFinite(num) ? num : null;
	  };

  const outlineTagHighlighterKey = new PluginKey('outlineTagHighlighter');

  const OutlineTag = Node.create({
    name: 'tag',
    group: 'inline',
    inline: true,
    atom: true,
    selectable: false,
    renderText({ node }) {
      try {
        return String(node?.attrs?.label || '').trim();
      } catch {
        return '';
      }
    },
    addAttributes() {
      return {
        label: { default: '' },
        key: { default: '' },
      };
    },
    parseHTML() {
      return [{ tag: 'span[data-tt-tag="1"]' }];
    },
    renderHTML({ node, HTMLAttributes }) {
      const label = String(node?.attrs?.label || '').trim();
      const key = String(node?.attrs?.key || '').trim();
      return [
        'span',
        mergeAttributes(HTMLAttributes, {
          'data-tt-tag': '1',
          'data-tag-key': key,
          class: 'tt-tag',
        }),
        label || key || '',
      ];
    },
    addInputRules() {
      const find = /(^|[\s([{"'«„–—-])\\([^\\\n]{1,60}?)\\$/;
      return [
        new InputRule({
          find,
          handler: ({ state: pmState, range, match }) => {
            const prefix = String(match?.[1] || '');
            const raw = String(match?.[2] || '');
            const label = normalizeTagLabel(raw);
            if (!label) return null;
            const key = normalizeTagKey(label);
            if (!key) return null;
            const type = pmState.schema.nodes?.tag;
            if (!type) return null;
            const tagNode = type.create({ label: key, key });

            let tr = pmState.tr.delete(range.from, range.to);
            let insertPos = range.from;
            if (prefix) {
              tr = tr.insertText(prefix, insertPos);
              insertPos += prefix.length;
            }
            tr = tr.insert(insertPos, tagNode);
            const sel = TextSelection.near(tr.doc.resolve(Math.min(tr.doc.content.size, insertPos + tagNode.nodeSize)), 1);
            tr = tr.setSelection(sel);
            tr = tr.setMeta(OUTLINE_ALLOW_META, true);
            return tr;
          },
        }),
      ];
    },
  });

  const OutlineTagHighlighter = Extension.create({
    name: 'outlineTagHighlighter',
    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: outlineTagHighlighterKey,
          state: {
            init: () => ({ activeKey: null }),
            apply: (tr, prev) => {
              const meta = tr.getMeta(outlineTagHighlighterKey);
              if (meta && Object.prototype.hasOwnProperty.call(meta, 'activeKey')) {
                return { activeKey: meta.activeKey ? String(meta.activeKey) : null };
              }
              return prev;
            },
          },
          props: {
            decorations(pmState) {
              const activeKey = outlineTagHighlighterKey.getState(pmState)?.activeKey || null;
              const decos = [];
              pmState.doc.descendants((node, pos) => {
                if (node?.type?.name !== 'tag') return;
                const key = String(node.attrs?.key || '').trim();
                if (!key) return;
                const cls = activeKey && key === activeKey ? 'tt-tag tt-tag--active' : 'tt-tag';
                decos.push(Decoration.node(pos, pos + node.nodeSize, { class: cls }));
              });
              if (!decos.length) return null;
              return DecorationSet.create(pmState.doc, decos);
            },
          },
        }),
      ];
    },
  });

	  const ResizableImage = Image.extend({
	    inline: true,
	    group: 'inline',
	    addAttributes() {
	      const parentAttrs = typeof this.parent === 'function' ? this.parent() : {};
	      return {
	        ...parentAttrs,
	        width: {
	          default: 320,
	          parseHTML: (element) => {
	            try {
	              const el = element;
	              const wrapper =
	                el && el.classList && el.classList.contains('resizable-image')
	                  ? el
	                  : el?.closest?.('.resizable-image');
	              const fromStyle = parseWidthPx(wrapper?.style?.width || '');
	              if (fromStyle !== null) return Math.round(fromStyle);
	              const fromAttr = parseWidthPx(wrapper?.getAttribute?.('style') || '') || parseWidthPx(el?.getAttribute?.('style') || '');
	              if (fromAttr !== null) return Math.round(fromAttr);
	              const data = wrapper?.getAttribute?.('data-width') || el?.getAttribute?.('data-width') || '';
	              const fromData = Number.parseFloat(String(data || ''));
	              if (Number.isFinite(fromData) && fromData > 0) return Math.round(fromData);
	              return 320;
	            } catch {
	              return 320;
	            }
	          },
	          renderHTML: () => ({}),
	        },
	        uploadToken: {
	          default: null,
	          parseHTML: () => null,
	          renderHTML: () => ({}),
	        },
	      };
	    },
	    parseHTML() {
	      return [
	        {
	          tag: 'span.resizable-image',
	          getAttrs: (element) => {
	            const el = element;
	            const img = el?.querySelector?.('img');
	            const src = img?.getAttribute?.('src') || '';
	            if (!src) return false;
	            const alt = img?.getAttribute?.('alt') || '';
	            const title = img?.getAttribute?.('title') || '';
	            const width = parseWidthPx(el?.style?.width || '') ?? 320;
	            return { src, alt, title, width: Math.round(width) };
	          },
	        },
	        {
	          tag: 'img[src]',
	          getAttrs: (element) => {
	            const el = element;
	            const src = el?.getAttribute?.('src') || '';
	            if (!src) return false;
	            const alt = el?.getAttribute?.('alt') || '';
	            const title = el?.getAttribute?.('title') || '';
	            return { src, alt, title, width: 320 };
	          },
	        },
	      ];
	    },
	    renderHTML({ node, HTMLAttributes }) {
	      const rawWidth = node?.attrs?.width;
	      const width = Number.isFinite(Number(rawWidth)) ? Math.round(Number(rawWidth)) : 320;
	      const imgAttrs = { ...HTMLAttributes };
	      delete imgAttrs.width;
	      delete imgAttrs.uploadToken;
	      return [
	        'span',
	        mergeAttributes(
	          { class: 'resizable-image', style: `width:${width}px;max-width:100%;` },
	          {},
	        ),
	        ['span', { class: 'resizable-image__inner' }, ['img', mergeAttributes(imgAttrs, { draggable: 'false' })]],
	        ['span', { class: 'resizable-image__handle', 'data-direction': 'e', 'aria-hidden': 'true' }],
	      ];
	    },
	  });

	  outlineGenerateHTML = generateHTML;
	  outlineHtmlExtensions = [
	    StarterKit.configure({ heading: false, link: false }),
	    Link.configure({ openOnClick: false, protocols: OUTLINE_ALLOWED_LINK_PROTOCOLS }),
	    ResizableImage,
	    TableKit.configure({ table: { resizable: true } }),
	  ];

	  const OutlineImageUpload = Extension.create({
	    name: 'outlineImageUpload',
	    addProseMirrorPlugins() {
	      const isImageLikeFile = (file) => {
	        if (!file) return false;
	        if (file.type && String(file.type).startsWith('image/')) return true;
	        const name = String(file.name || '').toLowerCase();
	        return Boolean(name && /\.(png|jpe?g|gif|webp|bmp|svg|heic|heif)$/i.test(name));
	      };

	      const collectFiles = (items, fallbackFiles) => {
	        const files = [];
	        Array.from(items || []).forEach((item) => {
	          if (item.kind !== 'file') return;
	          const file = typeof item.getAsFile === 'function' ? item.getAsFile() : null;
	          if (file && isImageLikeFile(file)) files.push(file);
	        });
	        if (!files.length && fallbackFiles?.length) {
	          Array.from(fallbackFiles).forEach((file) => {
	            if (isImageLikeFile(file)) files.push(file);
	          });
	        }
	        return files;
	      };

			      const insertUploadingImage = (view, file) => {
			        const token = `upl-${Date.now()}-${Math.random().toString(16).slice(2)}`;
			        const objectUrl = URL.createObjectURL(file);
			        try {
			          pendingUploadObjectUrls.set(token, objectUrl);
			        } catch {
			          // ignore
			        }
			        try {
			          const aid = outlineArticleId || state.articleId || null;
			          void putPendingUpload({
			            token,
			            articleId: aid,
			            kind: 'image',
			            blob: file,
			            fileName: file?.name || 'image',
			            mime: file?.type || '',
			          });
			        } catch {
			          // ignore
			        }
			        const imgNode = view.state.schema.nodes.image.create({
			          src: objectUrl,
			          alt: file?.name || 'image',
			          width: 320,
		          uploadToken: token,
		        });
		        // Вставляем картинку как inline, обрамляя пробелами, чтобы можно было писать до/после.
		        let tr = view.state.tr;
		        const selFrom = tr.selection.from;
		        const selTo = tr.selection.to;
		        // Удаляем выделение (если было) и вставляем пробелы/картинку.
		        if (selTo > selFrom) tr = tr.delete(selFrom, selTo);
		        tr = tr.insertText('  ', selFrom, selFrom);
		        const insertAt = tr.mapping.map(selFrom, 1);
		        tr = tr.replaceRangeWith(insertAt, insertAt, imgNode);
		        const afterImg = tr.mapping.map(insertAt + imgNode.nodeSize, 1);
		        tr = tr.insertText('  ', afterImg, afterImg);
			        tr = tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(tr.doc.content.size, afterImg + 1)), 1));
			        tr = tr.setMeta(OUTLINE_ALLOW_META, true);
			        view.dispatch(tr.scrollIntoView());

			        try {
			          if (typeof navigator !== 'undefined' && navigator && navigator.onLine === false) {
			            // We can still insert the image: it's stored in IndexedDB and will upload on next online session.
			            showToast('Оффлайн: изображение добавлено и будет загружено при появлении сети');
			            return;
			          }
			        } catch {
			          // ignore
			        }

			        uploadImageFile(file)
			          .then((res) => {
			            const url = String(res?.url || '').trim();
			            if (!url) throw new Error('Upload failed');
			            const pos = findImagePosByUploadToken(view.state.doc, token);
		            if (typeof pos !== 'number') return;
		            const node = view.state.doc.nodeAt(pos);
		            if (!node || node.type?.name !== 'image') return;
		            const nextAttrs = { ...node.attrs, src: url, uploadToken: null };
		            let tr2 = view.state.tr.setNodeMarkup(pos, undefined, nextAttrs);
		            tr2 = tr2.setMeta(OUTLINE_ALLOW_META, true);
		            view.dispatch(tr2);
		            revokePendingUploadObjectUrl(token);
		            void deletePendingUpload(token).catch(() => {});
		          })
		          .catch((err) => {
		            // IMPORTANT: if upload fails (offline/timeout), we must NOT delete the image.
		            // Keep the local preview (objectUrl) and mark it as failed so the user doesn't lose content.
		            showToast(err?.message || 'Не удалось загрузить изображение');
		            try {
		              if (window?.localStorage?.getItem?.('ttree_debug_outline_keys_v1') === '1') {
		                // eslint-disable-next-line no-console
		                console.log('[outline][image]', 'upload.failed', { token, message: String(err?.message || err || '') });
		              }
		            } catch {
		              // ignore
		            }
		            try {
		              const pos = findImagePosByUploadToken(view.state.doc, token);
		              if (typeof pos !== 'number') return;
		              const node = view.state.doc.nodeAt(pos);
		              if (!node || node.type?.name !== 'image') return;
		              const baseTitle = String(node.attrs?.title || '').trim();
		              const nextTitle = baseTitle ? `${baseTitle} (ошибка загрузки)` : 'Ошибка загрузки';
		              const nextAlt = String(node.attrs?.alt || file?.name || 'image');
		              const nextAttrs = { ...node.attrs, src: objectUrl, alt: nextAlt, title: nextTitle, uploadToken: token };
		              let tr2 = view.state.tr.setNodeMarkup(pos, undefined, nextAttrs);
		              tr2 = tr2.setMeta(OUTLINE_ALLOW_META, true);
		              view.dispatch(tr2);
		            } catch {
		              // ignore
		            }
		            try {
		              void markPendingUploadError(token, String(err?.message || err || 'error'));
		            } catch {
		              // ignore
		            }
		          });
	      };

	      const handle = (view, event, items, files) => {
	        try {
	          const st = outlineEditModeKey?.getState?.(view.state) || null;
	          if (!st?.editingSectionId) return false;
	        } catch {
	          return false;
	        }
	        const imgFiles = collectFiles(items, files);
	        if (!imgFiles.length) return false;
	        event.preventDefault();
	        event.stopPropagation();
	        for (const file of imgFiles) {
	          insertUploadingImage(view, file);
	        }
	        return true;
	      };

	      return [
	        new Plugin({
	          props: {
	            handleDOMEvents: {
	              paste(view, event) {
	                const items = event?.clipboardData?.items || null;
	                const files = event?.clipboardData?.files || null;
	                return handle(view, event, items, files);
	              },
	              drop(view, event) {
	                const items = event?.dataTransfer?.items || null;
	                const files = event?.dataTransfer?.files || null;
	                return handle(view, event, items, files);
	              },
	            },
	          },
	          view(view) {
	            return {
	              update(viewNow, prevState) {
	                try {
	                  const prevSt = key.getState(prevState) || {};
	                  const nextSt = key.getState(viewNow.state) || {};
	                  const wasEditing = prevSt.editingSectionId || null;
	                  const isEditing = nextSt.editingSectionId || null;
	                  if (wasEditing && !isEditing) {
	                    const sectionId = String(wasEditing || '').trim();
	                    const articleId = outlineArticleId || state.articleId || null;
	                    if (!sectionId || !articleId) return;
	                    let collapsed = false;
	                    try {
	                      const pos = findSectionPosById(viewNow.state.doc, sectionId);
	                      const node = typeof pos === 'number' ? viewNow.state.doc.nodeAt(pos) : null;
	                      if (node?.type?.name === 'outlineSection') collapsed = Boolean(node.attrs?.collapsed);
	                    } catch {
	                      // ignore
	                    }
	                    writeOutlineLastActiveSnapshot(articleId, sectionId, collapsed);
	                  }
	                } catch {
	                  // ignore
	                }
	              },
	            };
	          },
	        }),
	      ];
	    },
	  });

		  const OutlineImageResize = Extension.create({
		    name: 'outlineImageResize',
		    addProseMirrorPlugins() {
		      return [
		        new Plugin({
		          view(view) {
		            let session = null; // { pos, startWidth, startX, wrapper, lastWidth }

		            const resolveImagePos = (wrapper, event) => {
		              try {
		                // Best signal: NodeSelection on image.
		                const selNode = view.state.selection?.node || null;
		                if (selNode?.type?.name === 'image' && typeof view.state.selection.from === 'number') {
		                  return view.state.selection.from;
		                }

		                const tryPos = (pos) => {
		                  if (typeof pos !== 'number') return null;
		                  const candidates = [pos, pos - 1, pos + 1, pos - 2, pos + 2];
		                  for (const p of candidates) {
		                    if (p < 0) continue;
		                    const node = view.state.doc.nodeAt(p);
		                    if (node?.type?.name === 'image') return p;
		                  }
		                  return null;
		                };

		                const img = wrapper?.querySelector?.('img') || null;
		                const posFromDom = tryPos(view.posAtDOM(wrapper, 0));
		                if (typeof posFromDom === 'number') return posFromDom;
		                const posFromImg = img ? tryPos(view.posAtDOM(img, 0)) : null;
		                if (typeof posFromImg === 'number') return posFromImg;
		                const coords =
		                  event && typeof event.clientX === 'number' && typeof event.clientY === 'number'
		                    ? { left: event.clientX, top: event.clientY }
		                    : null;
		                const hit = coords ? view.posAtCoords(coords) : null;
		                const posFromCoords = hit && typeof hit.pos === 'number' ? tryPos(hit.pos) : null;
		                if (typeof posFromCoords === 'number') return posFromCoords;
		                return null;
		              } catch {
		                return null;
		              }
		            };

		            const onPointerDown = (event) => {
		              if (event.button !== 0) return;
		              const handle = event.target?.closest?.('.resizable-image__handle');
		              if (!handle) return;
	              const wrapper = handle.closest('.resizable-image');
	              if (!wrapper || !view.dom.contains(wrapper)) return;
		              const st = outlineEditModeKey?.getState?.(view.state) || null;
		              if (!st?.editingSectionId) return;

		              const pos = resolveImagePos(wrapper, event);
		              if (typeof pos !== 'number') return;
		              const node = view.state.doc.nodeAt(pos);
		              if (!node || node.type?.name !== 'image') return;

	              event.preventDefault();
	              event.stopPropagation();
		              const rect = wrapper.getBoundingClientRect();
		              session = {
		                pos,
		                startWidth: rect.width,
		                startX: event.clientX,
		                wrapper,
		                lastWidth: rect.width,
		              };
		              wrapper.classList.add('resizable-image--resizing');
		            };

		            const onPointerMove = (event) => {
		              if (!session) return;
		              event.preventDefault();
		              const delta = event.clientX - session.startX;
		              const rootFontSize = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
		              const minWidth = rootFontSize;
		              const viewportMax = Math.max(minWidth, document.documentElement.clientWidth - 32);
		              let width = session.startWidth + delta;
		              width = Math.max(minWidth, Math.min(width, viewportMax));
		              session.lastWidth = width;
		              session.wrapper.style.width = `${Math.round(width)}px`;
		            };

		            const onPointerEnd = () => {
		              if (!session) return;
		              const { pos, wrapper } = session;
		              wrapper.classList.remove('resizable-image--resizing');
		              const resolvedPos =
		                view.state.doc.nodeAt(pos)?.type?.name === 'image'
		                  ? pos
		                  : resolveImagePos(wrapper, null);
		              const node = typeof resolvedPos === 'number' ? view.state.doc.nodeAt(resolvedPos) : null;
		              if (node && node.type?.name === 'image') {
		                const width = Math.max(1, Math.round(Number(session.lastWidth || 0) || wrapper.getBoundingClientRect().width));
		                const nextAttrs = { ...node.attrs, width };
		                let tr = view.state.tr.setNodeMarkup(resolvedPos, undefined, nextAttrs);
		                tr = tr.setMeta(OUTLINE_ALLOW_META, true);
		                view.dispatch(tr);
		              }
		              session = null;
		            };

	            view.dom.addEventListener('pointerdown', onPointerDown);
	            document.addEventListener('pointermove', onPointerMove);
	            document.addEventListener('pointerup', onPointerEnd);
	            document.addEventListener('pointercancel', onPointerEnd);

	            return {
	              destroy() {
	                view.dom.removeEventListener('pointerdown', onPointerDown);
	                document.removeEventListener('pointermove', onPointerMove);
	                document.removeEventListener('pointerup', onPointerEnd);
	                document.removeEventListener('pointercancel', onPointerEnd);
	              },
	            };
	          },
	        }),
	      ];
	    },
	  });

	  const OutlineImagePreview = Extension.create({
	    name: 'outlineImagePreview',
	    addProseMirrorPlugins() {
	      return [
	        new Plugin({
	          props: {
	            handleDOMEvents: {
	              click(view, event) {
	                try {
	                  const st = outlineEditModeKey?.getState?.(view.state) || null;
	                  if (st?.editingSectionId) return false;
	                  const img = event?.target?.closest?.('img');
	                  if (!img) return false;
	                  const handle = event.target?.closest?.('.resizable-image__handle');
	                  if (handle) {
	                    event.preventDefault();
	                    return true;
	                  }
	                  event.preventDefault();
	                  showImagePreview(img.src, img.alt || '');
	                  return true;
	                } catch {
	                  return false;
	                }
	              },
	            },
	          },
	        }),
	      ];
	    },
	  });

		  const OutlineMarkdownTablePaste = Extension.create({
	    name: 'outlineMarkdownTablePaste',
	    addProseMirrorPlugins() {
	      const maybeHandlePaste = (view, event) => {
	        try {
	          const st = outlineEditModeKey?.getState?.(view.state) || null;
	          if (!st?.editingSectionId) return false;
	          const text = event?.clipboardData?.getData?.('text/plain') || '';
	          mdTableDebug('paste: text/plain', { len: text.length, sample: text.slice(0, 200) });
	          if (!text) return false;
	          const lines = normalizeLinesForMarkdownTable(text);
	          const parsed = parseMarkdownTableLines(lines);
	          mdTableDebug('paste: parsed', { ok: Boolean(parsed), lines });
	          const parsedRowsOnly = !parsed ? parseMarkdownTableRowsOnly(lines) : null;
	          if (!parsed && !parsedRowsOnly) return false;
	          const tableSpec = parsed
	            ? { header: parsed.header, rows: parsed.rows, withHeader: true }
	            : { header: null, rows: parsedRowsOnly.rows, withHeader: false };

	          let tableNode = null;
	          try {
	            tableNode = buildTableNodeFromMarkdown(view.state.schema, tableSpec);
	          } catch (err) {
	            mdTableDebug('paste: buildTableNode error', {
	              message: String(err?.message || err || ''),
	              stack: String(err?.stack || ''),
	              schemaNodes: Object.keys(view.state.schema?.nodes || {}),
	            });
	            return false;
	          }
	          mdTableDebug('paste: tableNode', {
	            ok: Boolean(tableNode),
	            schemaNodes: mdTableDebugEnabled() ? Object.keys(view.state.schema?.nodes || {}) : undefined,
	          });
	          if (!tableNode) return false;

	          event.preventDefault();
	          event.stopPropagation();

	          let tr = view.state.tr;
	          if (!view.state.selection.empty) {
	            tr = tr.deleteSelection();
	          }
	          try {
	            tr = tr.replaceSelectionWith(tableNode, false);
	          } catch (err) {
	            mdTableDebug('paste: replaceSelectionWith error', {
	              message: String(err?.message || err || ''),
	              stack: String(err?.stack || ''),
	              selection: {
	                from: view.state.selection?.from,
	                to: view.state.selection?.to,
	                empty: view.state.selection?.empty,
	                $fromParent: view.state.selection?.$from?.parent?.type?.name,
	              },
	            });
	            return false;
	          }
	          tr = tr.setMeta(OUTLINE_ALLOW_META, true);
	          view.dispatch(tr.scrollIntoView());
	          return true;
	        } catch (err) {
	          mdTableDebug('paste: unexpected error', {
	            message: String(err?.message || err || ''),
	            stack: String(err?.stack || ''),
	          });
	          return false;
	        }
	      };

	      return [
	        new Plugin({
	          appendTransaction(transactions, oldState, newState) {
	            try {
	              const didDocChange = transactions?.some?.((tr) => tr?.docChanged);
	              let enterSectionId = null;
	              if (outlineEditModeKey) {
	                for (const tr0 of transactions || []) {
	                  const meta = tr0?.getMeta?.(outlineEditModeKey) || null;
	                  if (meta?.type === 'enter' && meta?.sectionId) {
	                    enterSectionId = String(meta.sectionId);
	                    break;
	                  }
	                }
	              }
	              const didEnterEditMode = Boolean(enterSectionId);
	              if (!didDocChange && !didEnterEditMode) return null;
	              // Avoid loops: if one of transactions already did allow-meta conversion, skip.
	              if (transactions.some((tr) => tr.getMeta?.(OUTLINE_ALLOW_META))) return null;
	              const st = outlineEditModeKey?.getState?.(newState) || null;
	              const sid = enterSectionId || st?.editingSectionId || null;
		              if (!sid) return null;
			              mdTableDebug('appendTransaction: try convert', { didDocChange, didEnterEditMode, sectionId: sid });
			              const mdTr = convertMarkdownTablesInSection(newState, sid);
			              if (mdTr) return mdTr;
			              if (mdTableDebugEnabled()) {
			                // Quick hint: if current body contains pipes, but we didn't convert, log it.
			                const sectionPos = findSectionPosById(newState.doc, sid);
			                const sectionNode = typeof sectionPos === 'number' ? newState.doc.nodeAt(sectionPos) : null;
			                const bodyNode = sectionNode ? sectionNode.child(1) : null;
			                const bodyText = bodyNode ? bodyNode.textContent : '';
			                if (String(bodyText || '').includes('|')) {
			                  mdTableDebug('appendTransaction: saw pipes but no conversion', { sectionId: sid });
			                }
			              }
			              // Also migrate legacy multiline inline-code (<code><br>..</code>) into proper codeBlock.
			              return convertInlineMultilineCodeToCodeBlockInSection(newState, sid);
			            } catch {
			              return null;
			            }
			          },
	          props: {
	            handlePaste(view, event) {
	              return maybeHandlePaste(view, event);
	            },
	            handleDOMEvents: {
	              paste(view, event) {
	                return maybeHandlePaste(view, event);
	              },
	            },
	          },
	        }),
	      ];
	    },
		  });

		  const OutlineStructuredSectionPaste = Extension.create({
		    name: 'outlineStructuredSectionPaste',
		    addProseMirrorPlugins() {
		      const parseHtmlSections = (html) => {
		        const normalized = String(html || '').trim();
		        if (!normalized) return { sections: [], startsWithHeading: false, headingCount: 0 };
		        if (!/<h[1-6][\s>]/i.test(normalized)) return { sections: [], startsWithHeading: false, headingCount: 0 };
		        let doc = null;
		        try {
		          doc = new DOMParser().parseFromString(normalized, 'text/html');
		        } catch {
		          return { sections: [], startsWithHeading: false, headingCount: 0 };
		        }
		        const body = doc?.body;
		        if (!body) return { sections: [], startsWithHeading: false, headingCount: 0 };

		        let startsWithHeading = false;
		        try {
		          const firstEl = Array.from(body.childNodes || []).find((n) => n?.nodeType === 1 && String(n?.textContent || '').trim());
		          startsWithHeading = Boolean(firstEl && /^H[1-6]$/.test(String(firstEl.nodeName || '')));
		        } catch {
		          startsWithHeading = false;
		        }

		        const sections = [];
		        let current = null; // { level, title, nodes: Node[] }
		        const flush = () => {
		          if (!current) return;
		          const container = document.createElement('div');
		          for (const n of current.nodes) {
		            try {
		              container.appendChild(n.cloneNode(true));
		            } catch {
		              // ignore
		            }
		          }
		          const bodyText = String(container.innerText || container.textContent || '').trimEnd();
		          sections.push({ level: current.level, title: current.title, bodyText });
		          current = null;
		        };

		        for (const child of Array.from(body.childNodes || [])) {
		          const isEl = child?.nodeType === 1;
		          const nodeName = isEl ? String(child.nodeName || '').toUpperCase() : '';
		          const m = nodeName.match(/^H([1-6])$/);
		          if (m) {
		            flush();
		            const level = Number(m[1]);
		            const title = String(child.textContent || '').trim();
		            if (!title) continue;
		            current = { level, title, nodes: [] };
		            continue;
		          }
		          if (!current) continue;
		          current.nodes.push(child);
		        }
		        flush();
		        return { sections, startsWithHeading, headingCount: sections.length };
		      };

		      const findSectionPosFromSelection = (pmState) => {
		        const $from = pmState?.selection?.$from;
		        if (!$from) return null;
		        for (let d = $from.depth; d > 0; d -= 1) {
		          if ($from.node(d)?.type?.name === 'outlineSection') return $from.before(d);
		        }
		        return null;
		      };

		      const buildParagraphNodes = (schema, text) => {
		        const raw = String(text || '').replace(/\r\n/g, '\n').trimEnd();
		        const paragraphType = schema.nodes.paragraph;
		        if (!paragraphType) return [];

		        const hardBreakType = schema.nodes.hardBreak || schema.nodes.hard_break || null;
		        const makeParagraph = (lineText) => {
		          const lines = String(lineText || '').split('\n');
		          const content = [];
		          for (let i = 0; i < lines.length; i += 1) {
		            const t = lines[i];
		            if (i > 0 && hardBreakType) content.push(hardBreakType.create());
		            if (t) content.push(schema.text(t));
		          }
		          return paragraphType.create({}, content);
		        };

		        if (!raw.trim()) return [paragraphType.create({}, [])];
		        const parts = raw.split(/\n{2,}/);
		        const out = [];
		        for (const p of parts) {
		          const trimmed = String(p || '').trimEnd();
		          out.push(makeParagraph(trimmed));
		        }
		        return out.length ? out : [paragraphType.create({}, [])];
		      };

		      const buildPmSectionFromTree = (schema, node) => {
		        const headingNode = schema.nodes.outlineHeading.create({}, node.title ? [schema.text(node.title)] : []);
		        const bodyContent = buildParagraphNodes(schema, node.bodyText);
		        const bodyNode = schema.nodes.outlineBody.create({}, bodyContent);
		        const childrenPm = (node.children || []).map((c) => buildPmSectionFromTree(schema, c));
		        const childrenNode = schema.nodes.outlineChildren.create({}, childrenPm);
		        return schema.nodes.outlineSection.create({ id: node.id, collapsed: false }, [headingNode, bodyNode, childrenNode]);
		      };

		      const maybeHandlePaste = (view, event) => {
		        try {
		          const st = outlineEditModeKey?.getState?.(view.state) || null;
		          if (!st?.editingSectionId) return false;

		          const html = event?.clipboardData?.getData?.('text/html') || '';
		          const text = event?.clipboardData?.getData?.('text/plain') || '';

		          const htmlParsed = html ? parseHtmlSections(html) : { sections: [], startsWithHeading: false, headingCount: 0 };
		          const mdParsed = !htmlParsed.sections.length && text ? parseMarkdownOutlineSections(text) : { sections: [], startsWithHeading: false, headingCount: 0 };

		          const parsed = htmlParsed.sections.length ? htmlParsed : mdParsed;
		          if (!parsed.sections.length) return false;

		          const safeToConvert = parsed.startsWithHeading || parsed.sections.length >= 2;
		          if (!safeToConvert) return false;

		          event.preventDefault();
		          event.stopPropagation();

		          const sectionPos = findSectionPosFromSelection(view.state);
		          if (typeof sectionPos !== 'number') return false;
		          const sectionNode = view.state.doc.nodeAt(sectionPos);
		          if (!sectionNode || sectionNode.type?.name !== 'outlineSection') return false;

		          const roots = buildOutlineSectionTree(parsed.sections, { makeId: () => safeUuid() });
		          if (!roots.length) return false;

		          const schema = view.state.schema;
		          const nodes = roots.map((r) => buildPmSectionFromTree(schema, r));

		          let tr = view.state.tr;
		          let insertPos = sectionPos + sectionNode.nodeSize;
		          for (const n of nodes) {
		            tr = tr.insert(insertPos, n);
		            insertPos += n.nodeSize;
		          }
		          tr = tr.setMeta(OUTLINE_ALLOW_META, true);
		          view.dispatch(tr.scrollIntoView());
		          return true;
		        } catch {
		          return false;
		        }
		      };

		      return [
		        new Plugin({
		          props: {
		            handlePaste(view, event) {
		              return maybeHandlePaste(view, event);
		            },
		            handleDOMEvents: {
		              paste(view, event) {
		                return maybeHandlePaste(view, event);
		              },
		            },
		          },
		        }),
		      ];
		    },
		  });

			  const resolveYandexDiskHref = (rawPath = '') => {
			    const raw = String(rawPath || '').trim();
			    if (!raw) return '';
		    if (raw.startsWith('app:/') || raw.startsWith('disk:/')) {
		      const encoded = encodeURIComponent(raw);
		      return `/api/yandex/disk/file?path=${encoded}`;
		    }
		    return raw;
		  };

		  const OutlineAttachmentUpload = Extension.create({
		    name: 'outlineAttachmentUpload',
		    addProseMirrorPlugins() {
		      const isNonImageFile = (file) => {
		        const t = String(file?.type || '');
		        return !(t && t.startsWith('image/'));
		      };

		      const collectNonImageFiles = (items, files) => {
		        const out = [];
		        try {
		          const list = [];
		          if (files && typeof files.length === 'number') {
		            list.push(...Array.from(files || []));
		          } else if (items && typeof items.length === 'number') {
		            for (const it of Array.from(items || [])) {
		              if (!it || it.kind !== 'file') continue;
		              const f = it.getAsFile?.();
		              if (f) list.push(f);
		            }
		          }
		          for (const f of list) {
		            if (!f) continue;
		            if (isNonImageFile(f)) out.push(f);
		          }
		        } catch {
		          // ignore
		        }
		        return out;
		      };

		      const pendingHrefFor = (token) => `pending-attachment:${String(token || '')}`;

		      const findAttachmentRangeByToken = (doc, token) => {
		        const pendingHref = pendingHrefFor(token);
		        const linkType = doc?.type?.schema?.marks?.link || null;
		        if (!linkType) return null;
		        let found = null;
		        doc.descendants((node, pos) => {
		          if (found) return false;
		          if (!node || !node.isText) return;
		          const marks = Array.isArray(node.marks) ? node.marks : [];
		          const has = marks.find((m) => m?.type === linkType && String(m?.attrs?.href || '') === pendingHref);
		          if (!has) return;
		          found = { from: pos, to: pos + node.nodeSize };
		        });
		        return found;
		      };

		      const insertUploadingAttachment = (view, file) => {
		        const schema = view?.state?.schema;
		        const linkType = schema?.marks?.link || null;
		        if (!schema || !linkType) {
		          showToast('Не удалось вставить вложение: нет схемы ссылок');
		          return;
		        }
		        if (!state.articleId) {
		          showToast('Сначала откройте статью');
		          return;
		        }

		        const token = safeUuid();
		        const pendingHref = pendingHrefFor(token);
		        const safeName = String(file?.name || 'файл');
		        const placeholderText = `${safeName} (загрузка...)`;

		        const { from, to } = view.state.selection;
		        let tr = view.state.tr.insertText(placeholderText, from, to);
		        tr = tr.addMark(from, from + placeholderText.length, linkType.create({ href: pendingHref }));
		        tr = tr.setMeta(OUTLINE_ALLOW_META, true);
		        view.dispatch(tr.scrollIntoView());

		        uploadFileToYandexDisk(state.articleId, file)
		          .then((attachment) => {
		            const hrefRaw = String(attachment?.storedPath || attachment?.url || attachment?.path || '').trim();
		            if (!hrefRaw) throw new Error('Не удалось получить ссылку на файл');
		            const finalName = String(attachment?.originalName || file?.name || 'файл');
		            const range = findAttachmentRangeByToken(view.state.doc, token);
		            if (!range) return;
		            let tr2 = view.state.tr.insertText(finalName, range.from, range.to);
		            tr2 = tr2.addMark(range.from, range.from + finalName.length, linkType.create({ href: hrefRaw }));
		            tr2 = tr2.setMeta(OUTLINE_ALLOW_META, true);
		            view.dispatch(tr2);
		          })
		          .catch((err) => {
		            const range = findAttachmentRangeByToken(view.state.doc, token);
		            if (range) {
		              const errorText = `${safeName} (ошибка загрузки)`;
		              let tr2 = view.state.tr.insertText(errorText, range.from, range.to);
		              tr2 = tr2.setMeta(OUTLINE_ALLOW_META, true);
		              view.dispatch(tr2);
		            }
		            showToast(err?.message || 'Не удалось загрузить файл на Яндекс.Диск');
		          });
		      };

		      const handle = (view, event, items, files) => {
		        const nonImgFiles = collectNonImageFiles(items, files);
		        if (!nonImgFiles.length) return false;

		        // Always prevent default file drop (browser may navigate away/open new tab).
		        event.preventDefault();
		        event.stopPropagation();

		        try {
		          const st = outlineEditModeKey?.getState?.(view.state) || null;
		          if (!st?.editingSectionId) {
		            notifyReadOnlyGlobal();
		            return true;
		          }
		        } catch {
		          notifyReadOnlyGlobal();
		          return true;
		        }

		        for (const f of nonImgFiles) {
		          insertUploadingAttachment(view, f);
		        }
		        return true;
		      };

		      return [
		        new Plugin({
		          props: {
		            handleDOMEvents: {
		              drop(view, event) {
		                const items = event?.dataTransfer?.items || null;
		                const files = event?.dataTransfer?.files || null;
		                return handle(view, event, items, files);
		              },
		              paste(view, event) {
		                const items = event?.clipboardData?.items || null;
		                const files = event?.clipboardData?.files || null;
		                return handle(view, event, items, files);
		              },
		            },
		          },
		        }),
		      ];
		    },
		  });

	  const OutlineDocument = Node.create({
    name: 'doc',
    topNode: true,
    content: 'outlineSection+',
  });

		  const OutlineChildren = Node.create({
		    name: 'outlineChildren',
		    content: 'outlineSection*',
		    defining: true,
		    renderHTML() {
		      return ['div', { class: 'outline-children', 'data-outline-children': 'true' }, 0];
		    },
		    parseHTML() {
		      return [{ tag: 'div[data-outline-children]' }];
		    },
		    addNodeView() {
		      return ({ node }) => {
		        const dom = document.createElement('div');
		        dom.className = 'outline-children';
		        dom.setAttribute('data-outline-children', 'true');
		        const applyEmpty = (n) => {
		          const empty = !n || n.childCount === 0;
		          dom.setAttribute('data-empty', empty ? 'true' : 'false');
		        };
		        applyEmpty(node);
		        return {
		          dom,
		          contentDOM: dom,
		          update(updatedNode) {
		            if (!updatedNode || updatedNode.type?.name !== 'outlineChildren') return false;
		            applyEmpty(updatedNode);
		            return true;
		          },
		        };
		      };
		    },
		  });

	  const isOutlineBodyTrulyEmpty = (bodyNode) => {
	    try {
	      if (!bodyNode) return true;
	      if (bodyNode.childCount === 0) return true;
	      let hasContent = false;
	      bodyNode.descendants((n) => {
	        if (hasContent) return false;
	        const name = n?.type?.name;
	        if (name === 'image' || name === 'table') {
	          hasContent = true;
	          return false;
	        }
	        if (n.isText) {
	          const t = String(n.text || '').replace(/\u00a0/g, ' ');
	          if (t.trim()) {
	            hasContent = true;
	            return false;
	          }
	        }
	        return true;
	      });
	      return !hasContent;
	    } catch {
	      return false;
	    }
	  };

	  const OutlineBody = Node.create({
	    name: 'outlineBody',
	    content: 'block*',
	    defining: true,
	    renderHTML() {
	      return ['div', { class: 'outline-body', 'data-outline-body': 'true' }, 0];
	    },
	    parseHTML() {
	      return [{ tag: 'div[data-outline-body]' }];
	    },
	    addNodeView() {
	      return ({ node }) => {
	        const dom = document.createElement('div');
	        dom.className = 'outline-body';
	        dom.setAttribute('data-outline-body', 'true');
	        const applyEmpty = (n) => {
	          const empty = isOutlineBodyTrulyEmpty(n);
	          dom.setAttribute('data-empty', empty ? 'true' : 'false');
	        };
	        applyEmpty(node);
	        return {
	          dom,
	          contentDOM: dom,
	          update(updatedNode) {
	            if (!updatedNode || updatedNode.type?.name !== 'outlineBody') return false;
	            applyEmpty(updatedNode);
	            return true;
	          },
	        };
	      };
	    },
	  });

  const OutlineHeading = Node.create({
    name: 'outlineHeading',
    content: 'inline*',
    defining: true,
    renderHTML() {
      return ['div', { class: 'outline-heading', 'data-outline-heading': 'true' }, 0];
    },
    parseHTML() {
      return [{ tag: 'div[data-outline-heading]' }];
    },
    addNodeView() {
      return ({ editor, getPos, node }) => {
        const dom = document.createElement('div');
        dom.className = 'outline-heading';
        dom.setAttribute('data-outline-heading', 'true');

        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'outline-heading__toggle';
        toggle.title = 'Свернуть/развернуть (Ctrl+←/→), с детьми (Ctrl+↑/↓)';
        toggle.setAttribute('aria-label', 'Свернуть/развернуть');

	        const contentDOM = document.createElement('div');
	        contentDOM.className = 'outline-heading__content';
	
	        const selectBtn = document.createElement('button');
	        selectBtn.type = 'button';
	        selectBtn.className = 'outline-heading__select';
	        selectBtn.setAttribute('role', 'checkbox');
	        selectBtn.setAttribute('aria-checked', 'false');
	        selectBtn.setAttribute('aria-label', 'Выбрать блок');
	        selectBtn.textContent = '✓';
	        selectBtn.addEventListener('pointerdown', (event) => {
	          // Prevent long-press text selection on mobile.
	          event.preventDefault();
	        });
	        selectBtn.addEventListener('click', (event) => {
	          event.preventDefault();
	          event.stopPropagation();
	          if (!outlineSelectionMode) return;
	          const headingPos = typeof getPos === 'function' ? getPos() : null;
	          if (typeof headingPos !== 'number') return;
	          const sectionPos = headingPos - 1;
	          const sectionNode = editor.state.doc.nodeAt(sectionPos);
	          const sid = String(sectionNode?.attrs?.id || '').trim();
	          if (!sid) return;
	          toggleOutlineSelectedSectionId(sid);
	        });

	        const updateUi = () => {
	          const headingPos = typeof getPos === 'function' ? getPos() : null;
	          if (typeof headingPos !== 'number') return;
	          const sectionPos = headingPos - 1;
	          const sectionNode = editor.state.doc.nodeAt(sectionPos);
	          const sectionId = String(sectionNode?.attrs?.id || '');
	          if (sectionId) dom.setAttribute('data-section-id', sectionId);
	          dom.dataset.empty = node.content.size === 0 ? 'true' : 'false';
	          const $pos = editor.state.doc.resolve(Math.max(0, sectionPos + 1));
	          let depth = 0;
	          for (let d = $pos.depth; d >= 0; d -= 1) {
	            if ($pos.node(d)?.type?.name === 'outlineSection') depth += 1;
	          }
	          dom.dataset.depth = String(Math.min(6, Math.max(1, depth || 1)));
	          const checked = outlineSelectionMode && sectionId && outlineSelectedSectionIds.has(sectionId);
	          selectBtn.setAttribute('aria-checked', checked ? 'true' : 'false');
	          selectBtn.style.display = outlineSelectionMode ? 'inline-flex' : 'none';
	        };

        toggle.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          const headingPos = typeof getPos === 'function' ? getPos() : null;
          if (typeof headingPos !== 'number') return;
          const sectionPos = headingPos - 1;
          const sectionNode = editor.state.doc.nodeAt(sectionPos);
          if (!sectionNode) return;
          const next = !Boolean(sectionNode.attrs?.collapsed);
          let tr = editor.state.tr.setNodeMarkup(sectionPos, undefined, {
            ...sectionNode.attrs,
            collapsed: next,
          });
          // If we're collapsing anything while in edit mode, exit edit mode first.
          try {
            if (next && outlineEditModeKey) {
              const st = outlineEditModeKey.getState(editor.state) || {};
              if (st.editingSectionId) {
                tr = tr.setMeta(outlineEditModeKey, { type: 'exit' });
              }
            }
          } catch {
            // ignore
          }
          tr.setMeta(OUTLINE_ALLOW_META, true);
          editor.view.dispatch(tr);
          editor.view.focus();
        });

	        dom.appendChild(toggle);
	        dom.appendChild(contentDOM);
	        dom.appendChild(selectBtn);
	        updateUi();

        return {
          dom,
          contentDOM,
          update: (updatedNode) => {
            if (updatedNode.type.name !== 'outlineHeading') return false;
            node = updatedNode;
            updateUi();
            return true;
          },
        };
      };
    },
  });

  const OutlineSection = Node.create({
    name: 'outlineSection',
    group: 'block',
    content: 'outlineHeading outlineBody outlineChildren',
    defining: true,
    isolating: true,
    draggable: true,
    addAttributes() {
      return {
        collapsed: { default: false },
      };
    },
    renderHTML({ node, HTMLAttributes }) {
      const attrs = {
        ...HTMLAttributes,
        class: `outline-section${HTMLAttributes?.class ? ` ${HTMLAttributes.class}` : ''}`,
        'data-outline-section': 'true',
        'data-section-id': node.attrs.id || '',
        'data-collapsed': node.attrs.collapsed ? 'true' : 'false',
      };
      return ['div', mergeAttributes(attrs), 0];
    },
    parseHTML() {
      return [{ tag: 'div[data-outline-section]' }];
    },
  });

  // Shared helpers used outside keymap closures (e.g. view-mode Backspace merge).
  const outlineIsEffectivelyEmptyNodeForView = (node) => {
    if (!node) return true;
    const text = (node.textContent || '').replace(/\u00a0/g, ' ').trim();
    if (text) return false;
    if (node.childCount) {
      for (let i = 0; i < node.childCount; i += 1) {
        const child = node.child(i);
        if (child.type?.name !== 'paragraph') return false;
        const childText = (child.textContent || '').replace(/\u00a0/g, ' ').trim();
        if (childText) return false;
      }
    }
    return true;
  };

  const outlineIsSectionEmptyForView = (sectionNode) => {
    if (!sectionNode) return true;
    try {
      const heading = sectionNode.child(0);
      const body = sectionNode.child(1);
      const children = sectionNode.child(2);
      return (
        outlineIsEffectivelyEmptyNodeForView(heading) &&
        outlineIsEffectivelyEmptyNodeForView(body) &&
        (!children || children.childCount === 0)
      );
    } catch {
      return true;
    }
  };

	  const outlineDeleteCurrentSectionForView = (pmState, dispatch, sectionPos) => {
	    const sectionNode = pmState.doc.nodeAt(sectionPos);
	    if (!sectionNode) return false;
	    const sid = String(sectionNode.attrs?.id || '').trim();
	    const $pos = pmState.doc.resolve(sectionPos);
	    const idx = $pos.index();
	    const parent = $pos.parent;
	    if (!parent) return false;
	    if (parent.childCount <= 1) {
	      // Нельзя удалить последнюю секцию только на верхнем уровне документа.
	      // Внутри outlineChildren последнего ребёнка удалить можно.
	      if (parent.type?.name === 'doc') {
	        const schema = pmState.doc.type.schema;
	        const newSection = schema.nodes.outlineSection.create(
	          { ...sectionNode.attrs, collapsed: false },
	          [
	            schema.nodes.outlineHeading.create({}, []),
	            schema.nodes.outlineBody.create({}, [schema.nodes.paragraph.create({}, [])]),
	            schema.nodes.outlineChildren.create({}, []),
	          ],
	        );
	        let tr = pmState.tr.replaceWith(sectionPos, sectionPos + sectionNode.nodeSize, newSection);
	        tr = tr.setMeta(OUTLINE_ALLOW_META, true);
	        const heading = newSection.child(0);
	        const bodyStart = sectionPos + 1 + heading.nodeSize;
	        dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(bodyStart + 2), 1)).scrollIntoView());
	        return true;
	      }

	      if (sid) markExplicitSectionDeletion(sid);
	      // Deleting the last child: move selection to the owner (parent) section body.
	      let ownerSectionPos = null;
	      try {
	        for (let d = $pos.depth; d > 0; d -= 1) {
	          if ($pos.node(d)?.type?.name === 'outlineSection') {
	            ownerSectionPos = $pos.before(d);
	            break;
	          }
	        }
	      } catch {
	        ownerSectionPos = null;
	      }

	      let tr = pmState.tr.delete(sectionPos, sectionPos + sectionNode.nodeSize);
	      tr = tr.setMeta(OUTLINE_ALLOW_META, true);

	      try {
	        if (typeof ownerSectionPos === 'number') {
	          const mappedOwnerPos = tr.mapping.map(ownerSectionPos, -1);
	          const ownerNode = tr.doc.nodeAt(mappedOwnerPos);
	          if (ownerNode && ownerNode.type?.name === 'outlineSection') {
	            const ownerHeading = ownerNode.child(0);
	            const ownerBody = ownerNode.child(1);
	            const bodyStart = mappedOwnerPos + 1 + ownerHeading.nodeSize;
	            if (!ownerBody.childCount) {
	              const schema = tr.doc.type.schema;
	              tr = tr.insert(bodyStart + 1, schema.nodes.paragraph.create({}, []));
	            }
	            tr = tr.setSelection(TextSelection.near(tr.doc.resolve(bodyStart + 2), 1));
	          }
	        }
	      } catch {
	        // ignore
	      }

	      dispatch(tr.scrollIntoView());
	      return true;
	    }

	    const hasPrev = idx > 0;
	    const hasNext = idx < parent.childCount - 1;
	    const prevNode = hasPrev ? parent.child(idx - 1) : null;
	    const prevStart = hasPrev ? sectionPos - prevNode.nodeSize : null;
	    const nextStart = sectionPos + sectionNode.nodeSize;

	    if (sid) markExplicitSectionDeletion(sid);
	    let tr = pmState.tr.delete(sectionPos, sectionPos + sectionNode.nodeSize);
	    const selectSectionHeading = (tr, pos) => {
	      try {
	        const node = tr.doc.nodeAt(pos);
	        if (!node || node.type?.name !== 'outlineSection') return tr;
	        const heading = node.child(0);
	        const headingStart = pos + 1;
	        const headingEnd = headingStart + heading.nodeSize - 1;
	        return tr.setSelection(TextSelection.near(tr.doc.resolve(headingEnd), -1));
	      } catch {
	        return tr;
	      }
	    };

	    if (hasNext) {
	      // Prefer selecting the next section after deleting the current one.
	      const nextPos = sectionPos < tr.doc.content.size ? sectionPos : nextStart;
	      const nextSection = tr.doc.nodeAt(nextPos);
	      if (nextSection) {
	        // Keep the next section visible and avoid jumping deep into the body.
	        tr = selectSectionHeading(tr, nextPos);
	      }
	    } else if (hasPrev && typeof prevStart === 'number') {
	      // Deleted the last sibling: fall back to previous section.
	      const prevSection = tr.doc.nodeAt(prevStart);
	      if (prevSection) {
	        tr = selectSectionHeading(tr, prevStart);
	      }
	    }
	    tr = tr.setMeta(OUTLINE_ALLOW_META, true);
	    dispatch(tr.scrollIntoView());
	    return true;
	  };

  const outlineMergeSectionIntoPreviousForView = (pmState, dispatch, sectionPos) => {
    const sectionNode = pmState.doc.nodeAt(sectionPos);
    if (!sectionNode) return false;
    const $pos = pmState.doc.resolve(sectionPos);
    const idx = $pos.index();
    const parent = $pos.parent;
    if (!parent || idx <= 0) return false;
    const prevNode = parent.child(idx - 1);
    const prevStart = sectionPos - prevNode.nodeSize;
    const currentHeading = sectionNode.child(0);
    const currentBody = sectionNode.child(1);
    const currentChildren = sectionNode.child(2);

    let tr = pmState.tr.delete(sectionPos, sectionPos + sectionNode.nodeSize);
    const prevSection = tr.doc.nodeAt(prevStart);
    if (!prevSection) {
      tr = tr.setMeta(OUTLINE_ALLOW_META, true);
      dispatch(tr.scrollIntoView());
      return true;
    }
    const schema = tr.doc.type.schema;
    const prevHeading = prevSection.child(0);
    const prevBody = prevSection.child(1);
    const prevChildren = prevSection.child(2);

    const extraBlocks = [];
    const headingText = (currentHeading?.textContent || '').replace(/\u00a0/g, ' ').trim();
    if (headingText) {
      extraBlocks.push(schema.nodes.paragraph.create({}, [schema.text(headingText)]));
    }
    currentBody?.content?.forEach?.((node) => {
      extraBlocks.push(node);
    });
    const extraFragment = extraBlocks.length ? schema.nodes.outlineBody.create({}, extraBlocks).content : null;
    const mergedBodyContent = extraFragment ? prevBody.content.append(extraFragment) : prevBody.content;
    const mergedChildrenContent = prevChildren.content.append(currentChildren.content);
    const newPrevSection = schema.nodes.outlineSection.create(
      prevSection.attrs,
      [
        prevHeading,
        schema.nodes.outlineBody.create({}, mergedBodyContent),
        schema.nodes.outlineChildren.create({}, mergedChildrenContent),
      ],
    );
    tr = tr.replaceWith(prevStart, prevStart + prevSection.nodeSize, newPrevSection);
    const newPrev = tr.doc.nodeAt(prevStart);
    if (newPrev) {
      const heading = newPrev.child(0);
      const body = newPrev.child(1);
      const bodyStart = prevStart + 1 + heading.nodeSize;
      const bodyEnd = bodyStart + body.nodeSize - 1;
      tr = tr.setSelection(TextSelection.near(tr.doc.resolve(bodyEnd), -1));
    }
    tr = tr.setMeta(OUTLINE_ALLOW_META, true);
    dispatch(tr.scrollIntoView());
    return true;
  };

  const outlineMergeSectionIntoParentBodyForView = (pmState, dispatch, sectionPos) => {
    const sectionNode = pmState.doc.nodeAt(sectionPos);
    if (!sectionNode) return false;
    const $from = pmState.selection.$from;

    let currentDepth = null;
    let parentDepth = null;
    for (let d = $from.depth; d > 0; d -= 1) {
      if ($from.node(d)?.type?.name === 'outlineSection') {
        if (currentDepth === null) currentDepth = d;
        else {
          parentDepth = d;
          break;
        }
      }
    }
    if (currentDepth === null || parentDepth === null) return false;
    const parentPos = $from.before(parentDepth);
    const parentNode = pmState.doc.nodeAt(parentPos);
    if (!parentNode) return false;

    const schema = pmState.doc.type.schema;
    const childHeading = sectionNode.child(0);
    const childBody = sectionNode.child(1);
    const childChildren = sectionNode.child(2);

    let tr = pmState.tr.delete(sectionPos, sectionPos + sectionNode.nodeSize);
    const parentAfter = tr.doc.nodeAt(parentPos);
    if (!parentAfter) {
      tr = tr.setMeta(OUTLINE_ALLOW_META, true);
      dispatch(tr.scrollIntoView());
      return true;
    }

    const parentHeading = parentAfter.child(0);
    const parentBody = parentAfter.child(1);
    const parentChildren = parentAfter.child(2);

    const extraBlocks = [];
    const headingText = (childHeading?.textContent || '').replace(/\u00a0/g, ' ').trim();
    if (headingText) {
      extraBlocks.push(schema.nodes.paragraph.create({}, [schema.text(headingText)]));
    }
    childBody?.content?.forEach?.((node) => {
      extraBlocks.push(node);
    });

    const extraFragment = extraBlocks.length ? schema.nodes.outlineBody.create({}, extraBlocks).content : null;
    const mergedBodyContent = extraFragment ? parentBody.content.append(extraFragment) : parentBody.content;
    const mergedChildrenContent = childChildren.content.append(parentChildren.content);

    const newParentSection = schema.nodes.outlineSection.create(
      { ...parentAfter.attrs, collapsed: false },
      [
        parentHeading,
        schema.nodes.outlineBody.create({}, mergedBodyContent),
        schema.nodes.outlineChildren.create({}, mergedChildrenContent),
      ],
    );

    tr = tr.replaceWith(parentPos, parentPos + parentAfter.nodeSize, newParentSection);

    const parentFinal = tr.doc.nodeAt(parentPos);
    if (parentFinal) {
      const heading = parentFinal.child(0);
      const body = parentFinal.child(1);
      const bodyStart = parentPos + 1 + heading.nodeSize;
      const bodyEnd = bodyStart + body.nodeSize - 1;
      tr = tr.setSelection(TextSelection.near(tr.doc.resolve(bodyEnd), -1));
    }
    tr = tr.setMeta(OUTLINE_ALLOW_META, true);
    dispatch(tr.scrollIntoView());
    return true;
  };

  const OutlineCommands = Extension.create({
    name: 'outlineCommands',
    addKeyboardShortcuts() {
      const findSectionPos = (doc, $from) => {
        for (let d = $from.depth; d > 0; d -= 1) {
          if ($from.node(d)?.type?.name === 'outlineSection') {
            return $from.before(d);
          }
        }
        return null;
      };

      const findDepth = ($from, name) => {
        for (let d = $from.depth; d > 0; d -= 1) {
          if ($from.node(d)?.type?.name === name) return d;
        }
        return null;
      };

      const isEffectivelyEmptyNode = (node) => {
        if (!node) return true;
        const text = (node.textContent || '').replace(/\u00a0/g, ' ').trim();
        if (text) return false;
        // Если есть нетекстовые узлы (например, image/table), textContent может быть пустым.
        // Считаем контент непустым, если внутри есть хоть один child, который не пустой paragraph.
        if (node.childCount) {
          for (let i = 0; i < node.childCount; i += 1) {
            const child = node.child(i);
            if (child.type?.name !== 'paragraph') return false;
            const childText = (child.textContent || '').replace(/\u00a0/g, ' ').trim();
            if (childText) return false;
          }
        }
        return true;
      };

      // Защита от "случайного склеивания" секций при выделении тела через Shift+↓,
      // когда selection фактически захватывает начало заголовка следующей секции.
      const clampCrossSectionDeletionToBody = (pmState, dispatch) => {
        const { selection } = pmState;
        if (!selection || selection.empty) return false;
        const fromSectionPos = findSectionPos(pmState.doc, selection.$from);
        const toSectionPos = findSectionPos(pmState.doc, selection.$to);
        if (typeof fromSectionPos !== 'number' || typeof toSectionPos !== 'number') return false;
        if (fromSectionPos === toSectionPos) return false;

        const fromBodyDepth = findDepth(selection.$from, 'outlineBody');
        if (fromBodyDepth === null) return false;

        // Если selection заканчивается ровно в начале заголовка другой секции — это почти
        // всегда результат keyboard selection (Shift+↓), а не намерение "удалить секции".
        if (selection.$to.parent?.type?.name !== 'outlineHeading') return false;
        if (selection.$to.parentOffset !== 0) return false;

        const sectionNode = pmState.doc.nodeAt(fromSectionPos);
        if (!sectionNode) return false;
        const headingNode = sectionNode.child(0);
        const bodyNode = sectionNode.child(1);
        const bodyStart = fromSectionPos + 1 + headingNode.nodeSize;
        const bodyContentFrom = bodyStart + 1;
        const bodyContentTo = bodyStart + bodyNode.nodeSize - 1;

        const deleteFrom = Math.max(selection.from, bodyContentFrom);
        const deleteTo = Math.min(selection.to, bodyContentTo);
        if (deleteTo < deleteFrom) return true;

        let tr = pmState.tr.delete(deleteFrom, deleteTo);
        const bodyAfter = tr.doc.nodeAt(bodyStart);
        if (bodyAfter && bodyAfter.content.size === 0) {
          const schema = tr.doc.type.schema;
          tr = tr.insert(bodyContentFrom, schema.nodes.paragraph.create({}, []));
        }
        tr = tr.setSelection(TextSelection.near(tr.doc.resolve(bodyContentFrom + 1), 1));
        dispatch(tr.scrollIntoView());
        return true;
      };

      // Защита от ситуации, когда удаление/вырезание "всего заголовка" удаляет ноду outlineHeading,
      // и ProseMirror нормализует секцию, подтягивая первую строку body в заголовок.
      const clampHeadingDeletionToHeadingText = (pmState, dispatch, options = {}) => {
        const { selection } = pmState;
        if (!selection || selection.empty) return false;
        const fromSectionPos = findSectionPos(pmState.doc, selection.$from);
        const toSectionPos = findSectionPos(pmState.doc, selection.$to);
        if (typeof fromSectionPos !== 'number' || typeof toSectionPos !== 'number') return false;
        if (fromSectionPos !== toSectionPos) return false;

        const fromHeadingDepth = findDepth(selection.$from, 'outlineHeading');
        const toHeadingDepth = findDepth(selection.$to, 'outlineHeading');
        if (fromHeadingDepth === null || toHeadingDepth === null) return false;

        const sectionNode = pmState.doc.nodeAt(fromSectionPos);
        if (!sectionNode) return false;
        const headingNode = sectionNode.child(0);
        const headingStart = fromSectionPos + 1;
        const headingContentFrom = headingStart + 1;
        const headingContentTo = headingStart + headingNode.nodeSize - 1;

        // Срабатываем только если selection целиком внутри контента заголовка.
        if (selection.from < headingContentFrom) return false;
        if (selection.to > headingContentTo) return false;

        const deleteFrom = Math.max(selection.from, headingContentFrom);
        const deleteTo = Math.min(selection.to, headingContentTo);
        if (deleteTo < deleteFrom) return true;

        if (typeof options.onClipboard === 'function') {
          try {
            const plain = pmState.doc.textBetween(deleteFrom, deleteTo, '\n', '\n');
            options.onClipboard(plain);
          } catch {
            // ignore
          }
        }

        let tr = pmState.tr.delete(deleteFrom, deleteTo);
        tr = tr.setSelection(TextSelection.near(tr.doc.resolve(headingContentFrom), 1));
        dispatch(tr.scrollIntoView());
        return true;
      };

      const isSectionEmpty = (sectionNode) => {
        if (!sectionNode) return true;
        const heading = sectionNode.child(0);
        const body = sectionNode.child(1);
        const children = sectionNode.child(2);
        return (
          isEffectivelyEmptyNode(heading) &&
          isEffectivelyEmptyNode(body) &&
          (!children || children.childCount === 0)
        );
      };

      const moveSelectionToSectionBodyEnd = (pmState, dispatch, sectionPos) => {
        const sectionNode = pmState.doc.nodeAt(sectionPos);
        if (!sectionNode) return false;
        const heading = sectionNode.child(0);
        const body = sectionNode.child(1);
        const bodyStart = sectionPos + 1 + heading.nodeSize;
        const bodyEnd = bodyStart + body.nodeSize - 1;
        const tr = pmState.tr.setSelection(TextSelection.near(pmState.doc.resolve(bodyEnd), -1));
        dispatch(tr.scrollIntoView());
        return true;
      };

      const moveSelectionToSectionHeadingStart = (pmState, dispatch, sectionPos) => {
        const sectionNode = pmState.doc.nodeAt(sectionPos);
        if (!sectionNode) return false;
        const heading = sectionNode.child(0);
        const headingStart = sectionPos + 1;
        const tr = pmState.tr.setSelection(TextSelection.near(pmState.doc.resolve(headingStart + 1), 1));
        dispatch(tr.scrollIntoView());
        return true;
      };

      const moveSelectionToSectionBodyStart = (pmState, dispatch, sectionPos) => {
        const sectionNode = pmState.doc.nodeAt(sectionPos);
        if (!sectionNode) return false;
        const heading = sectionNode.child(0);
        const body = sectionNode.child(1);
        const bodyStart = sectionPos + 1 + heading.nodeSize;
        let tr = pmState.tr;
        if (!body.childCount) {
          const schema = pmState.doc.type.schema;
          tr = tr.insert(bodyStart + 1, schema.nodes.paragraph.create({}, []));
        }
        tr = tr.setSelection(TextSelection.near(tr.doc.resolve(bodyStart + 2), 1));
        dispatch(tr.scrollIntoView());
        return true;
      };

      const moveSelectionToSectionEnd = (pmState, dispatch, sectionPos) => {
        const sectionNode = pmState.doc.nodeAt(sectionPos);
        if (!sectionNode) return false;
        const heading = sectionNode.child(0);
        const body = sectionNode.child(1);
        const isCollapsed = Boolean(sectionNode.attrs?.collapsed);
        if (isCollapsed) {
          const headingStart = sectionPos + 1;
          const headingEnd = headingStart + heading.nodeSize - 1;
          const tr = pmState.tr.setSelection(TextSelection.near(pmState.doc.resolve(headingEnd), -1));
          dispatch(tr);
          return true;
        }
        const bodyStart = sectionPos + 1 + heading.nodeSize;
        const bodyEnd = bodyStart + body.nodeSize - 1;
        const tr = pmState.tr.setSelection(TextSelection.near(pmState.doc.resolve(bodyEnd), -1));
        dispatch(tr);
        return true;
      };

      const isSectionVisible = (doc, sectionPos) => {
        try {
          const $p = doc.resolve(Math.min(doc.content.size, Math.max(0, sectionPos + 1)));
          for (let d = $p.depth; d > 0; d -= 1) {
            const n = $p.node(d);
            if (n?.type?.name !== 'outlineSection') continue;
            const pos = $p.before(d);
            if (pos === sectionPos) continue;
            if (Boolean(n.attrs?.collapsed)) return false;
          }
          return true;
        } catch {
          return true;
        }
      };

      const findPrevVisibleSectionPos = (doc, beforePos) => {
        let prev = null;
        doc.nodesBetween(0, beforePos, (node, pos) => {
          if (pos >= beforePos) return false;
          if (node?.type?.name !== 'outlineSection') return;
          if (!isSectionVisible(doc, pos)) return;
          prev = pos;
        });
        return prev;
      };

	      const deleteCurrentSection = (pmState, dispatch, sectionPos) => {
	        const sectionNode = pmState.doc.nodeAt(sectionPos);
	        if (!sectionNode) return false;
	        const sid = String(sectionNode.attrs?.id || '').trim();
	        const $pos = pmState.doc.resolve(sectionPos);
	        const idx = $pos.index();
	        const parent = $pos.parent;
	        if (!parent) return false;
	        if (parent.childCount <= 1) {
	          if (parent.type?.name === 'doc') {
	            // Нельзя удалить последнюю секцию документа — просто очищаем.
	            const schema = pmState.doc.type.schema;
	            const newSection = schema.nodes.outlineSection.create(
	              { ...sectionNode.attrs, collapsed: false },
	              [
	                schema.nodes.outlineHeading.create({}, []),
	                schema.nodes.outlineBody.create({}, [schema.nodes.paragraph.create({}, [])]),
	                schema.nodes.outlineChildren.create({}, []),
	              ],
	            );
	            let tr = pmState.tr.replaceWith(sectionPos, sectionPos + sectionNode.nodeSize, newSection);
	            tr = tr.setMeta(OUTLINE_ALLOW_META, true);
	            // После очистки последней секции ставим курсор в начало body.
	            const heading = newSection.child(0);
	            const bodyStart = sectionPos + 1 + heading.nodeSize;
	            dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(bodyStart + 2), 1)).scrollIntoView());
	            return true;
	          }

	          // Последнего ребёнка в outlineChildren удалять можно.
	          let ownerSectionPos = null;
	          try {
	            for (let d = $pos.depth; d > 0; d -= 1) {
	              if ($pos.node(d)?.type?.name === 'outlineSection') {
	                ownerSectionPos = $pos.before(d);
	                break;
	              }
	            }
	          } catch {
	            ownerSectionPos = null;
	          }

	          let tr = pmState.tr.delete(sectionPos, sectionPos + sectionNode.nodeSize);
	          tr = tr.setMeta(OUTLINE_ALLOW_META, true);
	          try {
	            if (typeof ownerSectionPos === 'number') {
	              const mappedOwnerPos = tr.mapping.map(ownerSectionPos, -1);
	              const ownerNode = tr.doc.nodeAt(mappedOwnerPos);
	              if (ownerNode && ownerNode.type?.name === 'outlineSection') {
	                const ownerHeading = ownerNode.child(0);
	                const ownerBody = ownerNode.child(1);
	                const bodyStart = mappedOwnerPos + 1 + ownerHeading.nodeSize;
	                if (!ownerBody.childCount) {
	                  const schema = tr.doc.type.schema;
	                  tr = tr.insert(bodyStart + 1, schema.nodes.paragraph.create({}, []));
	                }
	                tr = tr.setSelection(TextSelection.near(tr.doc.resolve(bodyStart + 2), 1));
	              }
	            }
	          } catch {
	            // ignore
	          }
	          dispatch(tr.scrollIntoView());
	          return true;
	        }

	        if (sid) markExplicitSectionDeletion(sid);
        const hasPrev = idx > 0;
        const prevNode = hasPrev ? parent.child(idx - 1) : null;
        const prevStart = hasPrev ? sectionPos - prevNode.nodeSize : null;
        const nextStart = sectionPos + sectionNode.nodeSize;

        let tr = pmState.tr.delete(sectionPos, sectionPos + sectionNode.nodeSize);
        if (hasPrev && typeof prevStart === 'number') {
          const prevSection = tr.doc.nodeAt(prevStart);
          if (prevSection) {
            const prevHeading = prevSection.child(0);
            const prevBody = prevSection.child(1);
            const bodyStart = prevStart + 1 + prevHeading.nodeSize;
            if (!prevBody.childCount) {
              const schema = tr.doc.type.schema;
              tr = tr.insert(bodyStart + 1, schema.nodes.paragraph.create({}, []));
            }
            tr = tr.setSelection(TextSelection.near(tr.doc.resolve(bodyStart + 2), 1));
          }
        } else {
          const nextPos = sectionPos < tr.doc.content.size ? sectionPos : nextStart;
          const nextSection = tr.doc.nodeAt(nextPos);
          if (nextSection) {
            const nextHeading = nextSection.child(0);
            const nextBody = nextSection.child(1);
            const bodyStart = nextPos + 1 + nextHeading.nodeSize;
            if (!nextBody.childCount) {
              const schema = tr.doc.type.schema;
              tr = tr.insert(bodyStart + 1, schema.nodes.paragraph.create({}, []));
            }
            tr = tr.setSelection(TextSelection.near(tr.doc.resolve(bodyStart + 2), 1));
          }
        }
        tr = tr.setMeta(OUTLINE_ALLOW_META, true);
        dispatch(tr.scrollIntoView());
        return true;
      };

      const mergeSectionIntoPrevious = (pmState, dispatch, sectionPos) => {
        const sectionNode = pmState.doc.nodeAt(sectionPos);
        if (!sectionNode) return false;
        const sid = String(sectionNode.attrs?.id || '').trim();
        const $pos = pmState.doc.resolve(sectionPos);
        const idx = $pos.index();
        const parent = $pos.parent;
        if (!parent || idx <= 0) return false;
        if (sid) markExplicitSectionDeletion(sid);
        const prevNode = parent.child(idx - 1);
        const prevStart = sectionPos - prevNode.nodeSize;
        const currentHeading = sectionNode.child(0);
        const currentBody = sectionNode.child(1);
        const currentChildren = sectionNode.child(2);

        let tr = pmState.tr.delete(sectionPos, sectionPos + sectionNode.nodeSize);
        const prevSection = tr.doc.nodeAt(prevStart);
        if (!prevSection) {
          tr = tr.setMeta(OUTLINE_ALLOW_META, true);
          dispatch(tr.scrollIntoView());
          return true;
        }
        const schema = tr.doc.type.schema;
        const prevHeading = prevSection.child(0);
        const prevBody = prevSection.child(1);
        const prevChildren = prevSection.child(2);

        // При merge заголовок текущей секции не должен пропадать:
        // переносим его в body предыдущей секции отдельным абзацем (если не пустой),
        // затем добавляем body текущей секции.
        const extraBlocks = [];
        const headingText = (currentHeading?.textContent || '').replace(/\u00a0/g, ' ').trim();
        if (headingText) {
          extraBlocks.push(schema.nodes.paragraph.create({}, [schema.text(headingText)]));
        }
        currentBody?.content?.forEach?.((node) => {
          extraBlocks.push(node);
        });
        const extraFragment = extraBlocks.length ? schema.nodes.outlineBody.create({}, extraBlocks).content : null;
        const mergedBodyContent = extraFragment ? prevBody.content.append(extraFragment) : prevBody.content;
        const mergedChildrenContent = prevChildren.content.append(currentChildren.content);
        const newPrevSection = schema.nodes.outlineSection.create(
          prevSection.attrs,
          [
            prevHeading,
            schema.nodes.outlineBody.create({}, mergedBodyContent),
            schema.nodes.outlineChildren.create({}, mergedChildrenContent),
          ],
        );
        tr = tr.replaceWith(prevStart, prevStart + prevSection.nodeSize, newPrevSection);
        const newPrev = tr.doc.nodeAt(prevStart);
        if (newPrev) {
          const heading = newPrev.child(0);
          const body = newPrev.child(1);
          const bodyStart = prevStart + 1 + heading.nodeSize;
          const bodyEnd = bodyStart + body.nodeSize - 1;
          tr = tr.setSelection(TextSelection.near(tr.doc.resolve(bodyEnd), -1));
        }
        tr = tr.setMeta(OUTLINE_ALLOW_META, true);
        dispatch(tr.scrollIntoView());
        return true;
      };

      const mergeSectionIntoParentBody = (pmState, dispatch, sectionPos) => {
        const sectionNode = pmState.doc.nodeAt(sectionPos);
        if (!sectionNode) return false;
        const sid = String(sectionNode.attrs?.id || '').trim();
        const $from = pmState.selection.$from;

        // Находим непосредственного родителя секции.
        let currentDepth = null;
        let parentDepth = null;
        for (let d = $from.depth; d > 0; d -= 1) {
          if ($from.node(d)?.type?.name === 'outlineSection') {
            if (currentDepth === null) currentDepth = d;
            else {
              parentDepth = d;
              break;
            }
          }
        }
        if (currentDepth === null || parentDepth === null) return false;
        const parentPos = $from.before(parentDepth);
        const parentNode = pmState.doc.nodeAt(parentPos);
        if (!parentNode) return false;

        const schema = pmState.doc.type.schema;
        const childHeading = sectionNode.child(0);
        const childBody = sectionNode.child(1);
        const childChildren = sectionNode.child(2);

        // 1) Удаляем текущую секцию из children родителя.
        if (sid) markExplicitSectionDeletion(sid);
        let tr = pmState.tr.delete(sectionPos, sectionPos + sectionNode.nodeSize);
        const parentAfter = tr.doc.nodeAt(parentPos);
        if (!parentAfter) {
          tr = tr.setMeta(OUTLINE_ALLOW_META, true);
          dispatch(tr.scrollIntoView());
          return true;
        }

        // 2) Переносим содержимое секции в body родителя:
        //    - заголовок секции превращаем в отдельный paragraph (если не пустой),
        //    - затем добавляем body секции.
        const parentHeading = parentAfter.child(0);
        const parentBody = parentAfter.child(1);
        const parentChildren = parentAfter.child(2);

        const extraBlocks = [];
        const headingText = (childHeading?.textContent || '').replace(/\u00a0/g, ' ').trim();
        if (headingText) {
          extraBlocks.push(schema.nodes.paragraph.create({}, [schema.text(headingText)]));
        }
        // Добавляем body как есть (block*).
        childBody?.content?.forEach?.((node) => {
          extraBlocks.push(node);
        });

        const extraFragment = extraBlocks.length ? schema.nodes.outlineBody.create({}, extraBlocks).content : null;
        const mergedBodyContent = extraFragment ? parentBody.content.append(extraFragment) : parentBody.content;

        // 3) Дети удалённой секции становятся детьми родителя в начале (на месте удалённой секции).
        const mergedChildrenContent = childChildren.content.append(parentChildren.content);

        const newParentSection = schema.nodes.outlineSection.create(
          { ...parentAfter.attrs, collapsed: false },
          [
            parentHeading,
            schema.nodes.outlineBody.create({}, mergedBodyContent),
            schema.nodes.outlineChildren.create({}, mergedChildrenContent),
          ],
        );

        tr = tr.replaceWith(parentPos, parentPos + parentAfter.nodeSize, newParentSection);

        // 4) Ставим курсор в конец body родителя.
        const parentFinal = tr.doc.nodeAt(parentPos);
        if (parentFinal) {
          const heading = parentFinal.child(0);
          const body = parentFinal.child(1);
          const bodyStart = parentPos + 1 + heading.nodeSize;
          const bodyEnd = bodyStart + body.nodeSize - 1;
          tr = tr.setSelection(TextSelection.near(tr.doc.resolve(bodyEnd), -1));
        }
        tr = tr.setMeta(OUTLINE_ALLOW_META, true);
        dispatch(tr.scrollIntoView());
        return true;
      };

      const mergeSectionWithNextSibling = (pmState, dispatch, sectionPos) => {
        const sectionNode = pmState.doc.nodeAt(sectionPos);
        if (!sectionNode) return false;
        const $pos = pmState.doc.resolve(sectionPos);
        const idx = $pos.index();
        const parent = $pos.parent;
        if (!parent) return false;
        if (idx >= parent.childCount - 1) return false;

        const nextStart = sectionPos + sectionNode.nodeSize;
        const nextNode = pmState.doc.nodeAt(nextStart);
        if (!nextNode || nextNode.type?.name !== 'outlineSection') return false;

        const schema = pmState.doc.type.schema;
        const headingNode = sectionNode.child(0);
        const bodyNode = sectionNode.child(1);
        const childrenNode = sectionNode.child(2);
        const nextBody = nextNode.child(1);
        const nextChildren = nextNode.child(2);

        const mergedBodyContent = bodyNode.content.append(nextBody.content);
        const mergedChildrenContent = childrenNode.content.append(nextChildren.content);
        const newSection = schema.nodes.outlineSection.create(
          { ...sectionNode.attrs, collapsed: false },
          [
            headingNode,
            schema.nodes.outlineBody.create({}, mergedBodyContent),
            schema.nodes.outlineChildren.create({}, mergedChildrenContent),
          ],
        );

        let tr = pmState.tr;
        // 1) удалить next sibling
        tr = tr.delete(nextStart, nextStart + nextNode.nodeSize);
        // 2) заменить текущую секцию на объединённую
        tr = tr.replaceWith(sectionPos, sectionPos + sectionNode.nodeSize, newSection);

        // 3) курсор в конец body (перед children)
        const updated = tr.doc.nodeAt(sectionPos);
        if (updated) {
          const h = updated.child(0);
          const b = updated.child(1);
          const bodyStart = sectionPos + 1 + h.nodeSize;
          const bodyEnd = bodyStart + b.nodeSize - 1;
          tr = tr.setSelection(TextSelection.near(tr.doc.resolve(bodyEnd), -1));
        }
        tr = tr.setMeta(OUTLINE_ALLOW_META, true);
        dispatch(tr.scrollIntoView());
        return true;
      };

      const moveSection = (dir) =>
        this.editor.commands.command(({ state: pmState, dispatch }) => {
          const sectionPos = findSectionPos(pmState.doc, pmState.selection.$from);
          if (typeof sectionPos !== 'number') return false;
          const $pos = pmState.doc.resolve(sectionPos);
          const idx = $pos.index();
          const parent = $pos.parent;
          if (!parent) return false;
          const sectionNode = pmState.doc.nodeAt(sectionPos);
          if (!sectionNode) return false;

          if (dir === 'up') {
            if (idx > 0) {
              const prevNode = parent.child(idx - 1);
              const prevStart = sectionPos - prevNode.nodeSize;
              const tr = pmState.tr
                .delete(sectionPos, sectionPos + sectionNode.nodeSize)
                .insert(prevStart, sectionNode)
                .setMeta(OUTLINE_ALLOW_META, true);
              const sel = TextSelection.near(tr.doc.resolve(prevStart + 2), 1);
              tr.setSelection(sel);
              dispatch(tr.scrollIntoView());
              return true;
            }

            // At the top of siblings: move into the previous sibling of the parent (if any),
            // as the last child of that "uncle" section.
            const parentSectionPos = findImmediateParentSectionPosForSectionPos(pmState.doc, sectionPos);
            if (typeof parentSectionPos !== 'number') return false;
            const $parent = pmState.doc.resolve(parentSectionPos);
            const parentIdx = $parent.index();
            const grandParent = $parent.parent;
            if (!grandParent || parentIdx <= 0) return false;
            const prevUncleNode = grandParent.child(parentIdx - 1);
            const prevUncleStart = parentSectionPos - prevUncleNode.nodeSize;
            const prevUncle = pmState.doc.nodeAt(prevUncleStart);
            if (!prevUncle || prevUncle.type?.name !== 'outlineSection') return false;
            const prevHeading = prevUncle.child(0);
            const prevBody = prevUncle.child(1);
            const prevChildren = prevUncle.child(2);
            const childrenStart = prevUncleStart + 1 + prevHeading.nodeSize + prevBody.nodeSize;
            const baseInsertPos = childrenStart + prevChildren.nodeSize - 1; // append

            let tr = pmState.tr.delete(sectionPos, sectionPos + sectionNode.nodeSize).setMeta(OUTLINE_ALLOW_META, true);
            const mappedPrevUncleStart = tr.mapping.map(prevUncleStart, -1);
            const mappedInsertPos = tr.mapping.map(baseInsertPos, -1);
            tr = tr.insert(mappedInsertPos, sectionNode);
            const prevAfter = tr.doc.nodeAt(mappedPrevUncleStart);
            if (prevAfter?.type?.name === 'outlineSection' && Boolean(prevAfter.attrs?.collapsed)) {
              tr = tr.setNodeMarkup(mappedPrevUncleStart, undefined, { ...prevAfter.attrs, collapsed: false });
            }
            const sel = TextSelection.near(tr.doc.resolve(mappedInsertPos + 2), 1);
            tr.setSelection(sel);
            dispatch(tr.scrollIntoView());
            return true;
          }
          if (dir === 'down') {
            if (idx < parent.childCount - 1) {
              const nextStart = sectionPos + sectionNode.nodeSize;
              const nextNode = pmState.doc.nodeAt(nextStart);
              if (!nextNode) return false;
              const tr = pmState.tr
                .delete(sectionPos, sectionPos + sectionNode.nodeSize)
                .setMeta(OUTLINE_ALLOW_META, true);
              const insertPos = sectionPos + nextNode.nodeSize;
              tr.insert(insertPos, sectionNode);
              const sel = TextSelection.near(tr.doc.resolve(insertPos + 2), 1);
              tr.setSelection(sel);
              dispatch(tr.scrollIntoView());
              return true;
            }

            // At the bottom of siblings: move into the next sibling of the parent (if any),
            // as the first child of that "uncle" section.
            const parentSectionPos = findImmediateParentSectionPosForSectionPos(pmState.doc, sectionPos);
            if (typeof parentSectionPos !== 'number') return false;
            const parentSectionNode = pmState.doc.nodeAt(parentSectionPos);
            if (!parentSectionNode || parentSectionNode.type?.name !== 'outlineSection') return false;
            const $parent = pmState.doc.resolve(parentSectionPos);
            const parentIdx = $parent.index();
            const grandParent = $parent.parent;
            if (!grandParent || parentIdx >= grandParent.childCount - 1) return false;

            const nextUncleStart = parentSectionPos + parentSectionNode.nodeSize;
            const nextUncle = pmState.doc.nodeAt(nextUncleStart);
            if (!nextUncle || nextUncle.type?.name !== 'outlineSection') return false;
            const nextHeading = nextUncle.child(0);
            const nextBody = nextUncle.child(1);
            const nextChildren = nextUncle.child(2);
            const childrenStart = nextUncleStart + 1 + nextHeading.nodeSize + nextBody.nodeSize;
            const baseInsertPos = childrenStart + 1; // prepend

            let tr = pmState.tr.delete(sectionPos, sectionPos + sectionNode.nodeSize).setMeta(OUTLINE_ALLOW_META, true);
            const mappedNextUncleStart = tr.mapping.map(nextUncleStart, -1);
            const mappedInsertPos = tr.mapping.map(baseInsertPos, -1);
            tr = tr.insert(mappedInsertPos, sectionNode);
            const nextAfter = tr.doc.nodeAt(mappedNextUncleStart);
            if (nextAfter?.type?.name === 'outlineSection' && Boolean(nextAfter.attrs?.collapsed)) {
              tr = tr.setNodeMarkup(mappedNextUncleStart, undefined, { ...nextAfter.attrs, collapsed: false });
            }
            const sel = TextSelection.near(tr.doc.resolve(mappedInsertPos + 2), 1);
            tr.setSelection(sel);
            dispatch(tr.scrollIntoView());
            return true;
          }
          return false;
        });

      const splitSectionAtCaret = () =>
        this.editor.commands.command(({ state: pmState, dispatch }) => {
          const { selection } = pmState;
          if (!selection?.empty) return false;
          const { $from } = selection;
          const sectionPos = findSectionPos(pmState.doc, $from);
          if (typeof sectionPos !== 'number') return false;
          const sectionNode = pmState.doc.nodeAt(sectionPos);
          if (!sectionNode) return false;
          const schema = pmState.doc.type.schema;

          // Если секция схлопнута — Ctrl+Enter просто создаёт новый sibling ниже
          // (ничего не переносим и не "split" содержимое).
          if (Boolean(sectionNode.attrs?.collapsed)) {
            const insertPos = sectionPos + sectionNode.nodeSize;
            const newId = safeUuid();
            const newSection = schema.nodes.outlineSection.create(
              { id: newId, collapsed: false },
              [
                schema.nodes.outlineHeading.create({}, []),
                schema.nodes.outlineBody.create({}, [schema.nodes.paragraph.create({}, [])]),
                schema.nodes.outlineChildren.create({}, []),
              ],
            );
            let tr = pmState.tr.insert(insertPos, newSection);
            tr = tr.setSelection(TextSelection.create(tr.doc, insertPos + 2));
            tr = tr.setMeta(OUTLINE_ALLOW_META, true);
            if (outlineEditModeKey) {
              tr = tr.setMeta(outlineEditModeKey, { type: 'enter', sectionId: newId });
            }
            dispatch(tr.scrollIntoView());
            return true;
          }

          const emptyChildren = schema.nodes.outlineChildren.create({}, []);
          const ensureBodyNotEmpty = (bodyNode) => {
            if (bodyNode && bodyNode.childCount) return bodyNode;
            return schema.nodes.outlineBody.create({}, [schema.nodes.paragraph.create({}, [])]);
          };

          // Split в заголовке: делим текст заголовка на 2 секции,
          // body+children переносим в новую секцию.
          if ($from.parent?.type?.name === 'outlineHeading') {
            const headingNode = sectionNode.child(0);
            const bodyNode = sectionNode.child(1);
            const childrenNode = sectionNode.child(2);
            const offset = $from.parentOffset || 0;
            const beforeText = headingNode.textBetween(0, Math.max(0, Math.min(offset, headingNode.content.size)), '', '');
            const afterText = headingNode.textBetween(Math.max(0, Math.min(offset, headingNode.content.size)), headingNode.content.size, '', '');
            const leftHeading = schema.nodes.outlineHeading.create({}, beforeText ? [schema.text(beforeText)] : []);
            const rightHeading = schema.nodes.outlineHeading.create({}, afterText ? [schema.text(afterText)] : []);
            const newId = safeUuid();
            const leftSection = schema.nodes.outlineSection.create(
              { ...sectionNode.attrs, collapsed: false },
              [leftHeading, ensureBodyNotEmpty(schema.nodes.outlineBody.create({}, [])), emptyChildren],
            );
            const rightSection = schema.nodes.outlineSection.create(
              { id: newId, collapsed: false },
              [rightHeading, ensureBodyNotEmpty(bodyNode), childrenNode],
            );
            let tr = pmState.tr.replaceWith(sectionPos, sectionPos + sectionNode.nodeSize, leftSection);
            const leftAfter = tr.doc.nodeAt(sectionPos);
            const insertPos = sectionPos + (leftAfter ? leftAfter.nodeSize : leftSection.nodeSize);
            tr = tr.insert(insertPos, rightSection);
            tr = tr.setSelection(TextSelection.create(tr.doc, insertPos + 2));
            tr = tr.setMeta(OUTLINE_ALLOW_META, true);
            if (outlineEditModeKey) {
              tr = tr.setMeta(outlineEditModeKey, { type: 'enter', sectionId: newId });
            }
            dispatch(tr.scrollIntoView());
            return true;
          }

          // Split в body: разрезаем body в позиции курсора и переносим tail + children в новую секцию.
          const bodyDepth = findDepth($from, 'outlineBody');
          if (bodyDepth === null) return false;
          if (!$from.parent?.isTextblock) return false;

          let tr = pmState.tr;
          const originalFrom = selection.from;
          try {
            tr = tr.split(originalFrom);
          } catch {
            return false;
          }

          // Переносим курсор в начало "второй половины", чтобы определить границу на уровне параграфа.
          const mapped = tr.mapping.map(originalFrom);
          try {
            tr = tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(tr.doc.content.size, mapped + 1)), 1));
          } catch {
            // ignore
          }
          const $sel = tr.selection.$from;
          const bodyDepthSel = findDepth($sel, 'outlineBody');
          const paragraphDepth = findDepth($sel, 'paragraph');
          if (bodyDepthSel === null || paragraphDepth === null) return false;

          const cutFrom = $sel.before(paragraphDepth);
          const bodyEnd = $sel.end(bodyDepthSel);
          if (typeof cutFrom !== 'number' || typeof bodyEnd !== 'number') return false;
          if (bodyEnd < cutFrom) return false;

          const tailFragment = tr.doc.slice(cutFrom, bodyEnd).content;
          tr = tr.delete(cutFrom, bodyEnd);

          // Находим секцию после всех изменений.
          const sectionPosAfter = tr.mapping.map(sectionPos, -1);
          const currentSection = tr.doc.nodeAt(sectionPosAfter);
          if (!currentSection) {
            dispatch(tr.scrollIntoView());
            return true;
          }
          const currentHeading = currentSection.child(0);
          const currentBody = ensureBodyNotEmpty(currentSection.child(1));
          const currentChildren = currentSection.child(2);

          const newCurrentSection = schema.nodes.outlineSection.create(
            { ...currentSection.attrs, collapsed: false },
            [currentHeading, currentBody, emptyChildren],
          );

          const tailBody =
            tailFragment && tailFragment.childCount
              ? schema.nodes.outlineBody.create({}, tailFragment)
              : schema.nodes.outlineBody.create({}, [schema.nodes.paragraph.create({}, [])]);
          const newId = safeUuid();
          const newSection = schema.nodes.outlineSection.create(
            { id: newId, collapsed: false },
            [schema.nodes.outlineHeading.create({}, []), tailBody, currentChildren],
          );

          tr = tr.replaceWith(sectionPosAfter, sectionPosAfter + currentSection.nodeSize, newCurrentSection);
          const insertPos = sectionPosAfter + newCurrentSection.nodeSize;
          tr = tr.insert(insertPos, newSection);
          tr = tr.setSelection(TextSelection.create(tr.doc, insertPos + 2));
          tr = tr.setMeta(OUTLINE_ALLOW_META, true);
          if (outlineEditModeKey) {
            tr = tr.setMeta(outlineEditModeKey, { type: 'enter', sectionId: newId });
          }
          dispatch(tr.scrollIntoView());
          return true;
        });

      const indentSection = () =>
        this.editor.commands.command(({ state: pmState, dispatch }) => {
          const sectionPos = findSectionPos(pmState.doc, pmState.selection.$from);
          if (typeof sectionPos !== 'number') return false;
          const $pos = pmState.doc.resolve(sectionPos);
          let depthCount = 0;
          for (let d = $pos.depth; d >= 0; d -= 1) {
            if ($pos.node(d)?.type?.name === 'outlineSection') depthCount += 1;
          }
          if (depthCount >= 6) return false;
          const idx = $pos.index();
          const parent = $pos.parent;
          if (!parent || idx <= 0) return false;
          const sectionNode = pmState.doc.nodeAt(sectionPos);
          if (!sectionNode) return false;

          const prevNode = parent.child(idx - 1);
          const prevStart = sectionPos - prevNode.nodeSize;
          const prevSection = pmState.doc.nodeAt(prevStart);
          if (!prevSection) return false;
          const prevHeading = prevSection.child(0);
          const prevBody = prevSection.child(1);
          const prevChildren = prevSection.child(2);
          const childrenStart = prevStart + 1 + prevHeading.nodeSize + prevBody.nodeSize;
          const insertPos = childrenStart + prevChildren.nodeSize - 1;
          let tr = pmState.tr
            .delete(sectionPos, sectionPos + sectionNode.nodeSize)
            .insert(insertPos, sectionNode)
            .setMeta(OUTLINE_ALLOW_META, true);
          // Если новый родитель свёрнут, развернём его, чтобы переносимый блок не "исчезал".
          const parentAfter = tr.doc.nodeAt(prevStart);
          if (parentAfter?.type?.name === 'outlineSection' && Boolean(parentAfter.attrs?.collapsed)) {
            tr = tr.setNodeMarkup(prevStart, undefined, { ...parentAfter.attrs, collapsed: false });
          }
          const sel = TextSelection.near(tr.doc.resolve(insertPos + 2), 1);
          tr.setSelection(sel);
          dispatch(tr.scrollIntoView());
          return true;
        });

      const outdentSection = () =>
        this.editor.commands.command(({ state: pmState, dispatch }) => {
          const $from = pmState.selection.$from;
          let currentDepth = null;
          let parentDepth = null;
          for (let d = $from.depth; d > 0; d -= 1) {
            if ($from.node(d)?.type?.name === 'outlineSection') {
              if (currentDepth === null) currentDepth = d;
              else {
                parentDepth = d;
                break;
              }
            }
          }
          if (currentDepth === null || parentDepth === null) return false;
          const sectionPos = $from.before(currentDepth);
          const parentPos = $from.before(parentDepth);
          const sectionNode = pmState.doc.nodeAt(sectionPos);
          if (!sectionNode) return false;
          const tr = pmState.tr.delete(sectionPos, sectionPos + sectionNode.nodeSize).setMeta(OUTLINE_ALLOW_META, true);
          const parentAfter = tr.doc.nodeAt(parentPos);
          if (!parentAfter) return false;
          const insertPos = parentPos + parentAfter.nodeSize;
          tr.insert(insertPos, sectionNode);
          const sel = TextSelection.near(tr.doc.resolve(insertPos + 2), 1);
          tr.setSelection(sel);
          dispatch(tr.scrollIntoView());
          return true;
        });

      const toggleCollapsed = (collapsed) =>
        this.editor.commands.command(({ state: pmState, dispatch }) => {
          const sectionPos = findSectionPos(pmState.doc, pmState.selection.$from);
          if (typeof sectionPos !== 'number') return false;
          const sectionNode = pmState.doc.nodeAt(sectionPos);
          if (!sectionNode) return false;
          const next = typeof collapsed === 'boolean' ? collapsed : !Boolean(sectionNode.attrs?.collapsed);
          let tr = pmState.tr
            .setNodeMarkup(sectionPos, undefined, { ...sectionNode.attrs, collapsed: next })
            .setMeta(OUTLINE_ALLOW_META, true);
          // Collapsing while editing should exit edit-mode so a hidden body isn't editable.
          try {
            if (next && outlineEditModeKey) {
              const st = outlineEditModeKey.getState(pmState) || {};
              if (st.editingSectionId) {
                tr = tr.setMeta(outlineEditModeKey, { type: 'exit' });
              }
            }
          } catch {
            // ignore
          }
          dispatch(tr);
          return true;
        });

      const collectSectionPositions = (doc, rootPos) => {
        const rootNode = doc.nodeAt(rootPos);
        if (!rootNode || rootNode.type?.name !== 'outlineSection') return [];
        const positions = [rootPos];
        rootNode.descendants((node, pos) => {
          if (node?.type?.name !== 'outlineSection') return;
          positions.push(rootPos + 1 + pos);
        });
        return positions;
      };

      const findImmediateParentSectionPosForSectionPos = (doc, sectionPos) => {
        try {
          const $inside = doc.resolve(Math.min(doc.content.size, sectionPos + 1));
          let currentDepth = null;
          for (let d = $inside.depth; d > 0; d -= 1) {
            if ($inside.node(d)?.type?.name !== 'outlineSection') continue;
            const pos = $inside.before(d);
            if (pos === sectionPos) {
              currentDepth = d;
              break;
            }
          }
          if (currentDepth === null) return null;
          for (let d = currentDepth - 1; d > 0; d -= 1) {
            if ($inside.node(d)?.type?.name === 'outlineSection') return $inside.before(d);
          }
          return null;
        } catch {
          return null;
        }
      };

      const applyCollapsedToPositions = (pmState, dispatch, positions, collapsed) => {
        const next = Boolean(collapsed);
        let tr = pmState.tr;
        for (const pos of positions) {
          const node = tr.doc.nodeAt(pos);
          if (!node || node.type?.name !== 'outlineSection') continue;
          if (Boolean(node.attrs?.collapsed) === next) continue;
          tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, collapsed: next });
        }
        tr = tr.setMeta(OUTLINE_ALLOW_META, true);
        try {
          if (next && outlineEditModeKey) {
            const st = outlineEditModeKey.getState(pmState) || {};
            if (st.editingSectionId) {
              tr = tr.setMeta(outlineEditModeKey, { type: 'exit' });
            }
          }
        } catch {
          // ignore
        }
        dispatch(tr);
      };

      const collapseParentSubtree = () =>
        this.editor.commands.command(({ state: pmState, dispatch }) => {
          const sectionPos = findSectionPos(pmState.doc, pmState.selection.$from);
          if (typeof sectionPos !== 'number') return false;
          const parentPos = findImmediateParentSectionPosForSectionPos(pmState.doc, sectionPos);
          const targetPos = typeof parentPos === 'number' ? parentPos : sectionPos;
          const positions = collectSectionPositions(pmState.doc, targetPos);
          if (!positions.length) return false;

          // Схлопываем полностью subtree: parent + все дети внутри него.
          let tr = pmState.tr;
          for (const pos of positions) {
            const node = tr.doc.nodeAt(pos);
            if (!node || node.type?.name !== 'outlineSection') continue;
            if (Boolean(node.attrs?.collapsed) === true) continue;
            tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, collapsed: true });
          }
          tr = tr.setMeta(OUTLINE_ALLOW_META, true);

          // После схлопывания переносим курсор в заголовок targetPos,
          // иначе selection может оказаться "внутри" скрытых детей.
          const targetNode = tr.doc.nodeAt(targetPos);
          if (targetNode) {
            const heading = targetNode.child(0);
            const headingStart = targetPos + 1;
            const headingEnd = headingStart + heading.nodeSize - 1;
            tr = tr.setSelection(TextSelection.near(tr.doc.resolve(headingEnd), -1));
          }
          dispatch(tr.scrollIntoView());
          return true;
        });

      const expandCurrentSubtree = () =>
        this.editor.commands.command(({ state: pmState, dispatch }) => {
          const sectionPos = findSectionPos(pmState.doc, pmState.selection.$from);
          if (typeof sectionPos !== 'number') return false;
          const positions = collectSectionPositions(pmState.doc, sectionPos);
          if (!positions.length) return false;
          // Разворачиваем полностью subtree: current + все дети внутри него.
          applyCollapsedToPositions(pmState, dispatch, positions, false);
          return true;
        });

      const toggleCollapsedRecursive = (collapsed) =>
        this.editor.commands.command(({ state: pmState, dispatch }) => {
          const { selection } = pmState;
          const selectedNode = selection?.node || null;
          const sectionPos =
            selectedNode?.type?.name === 'outlineSection'
              ? selection.from
              : findSectionPos(pmState.doc, pmState.selection.$from);
          if (typeof sectionPos !== 'number') return false;
          const sectionNode = pmState.doc.nodeAt(sectionPos);
          if (!sectionNode) return false;
          const next = Boolean(collapsed);

          const positions = collectSectionPositions(pmState.doc, sectionPos);
          if (!positions.length) return false;
          applyCollapsedToPositions(pmState, dispatch, positions, next);
          return true;
        });

      return {
        'Alt-ArrowUp': () => (this.editor.isActive('table') ? false : moveSection('up')),
        'Alt-ArrowDown': () => (this.editor.isActive('table') ? false : moveSection('down')),
        'Alt-ArrowRight': () => (this.editor.isActive('table') ? false : indentSection()),
        'Alt-ArrowLeft': () => (this.editor.isActive('table') ? false : outdentSection()),
        'Mod-ArrowRight': () => toggleCollapsed(false),
        'Mod-ArrowLeft': () => toggleCollapsed(true),
        // Ctrl+↑: схлопнуть родителя (и всё внутри него)
	        'Mod-ArrowUp': () => {
	          try {
	            const pmState = this.editor.state;
	            const sectionPos = findSectionPos(pmState.doc, pmState.selection.$from);
	            if (typeof sectionPos === 'number') {
	              const sectionNode = pmState.doc.nodeAt(sectionPos);
	              if (sectionNode?.type?.name === 'outlineSection') {
	                const parentPos = findImmediateParentSectionPosForSectionPos(pmState.doc, sectionPos);
	                const isTopLevel = typeof parentPos !== 'number';
	                // If a top-level block is already collapsed, Ctrl+↑ collapses the whole article.
	                if (isTopLevel && Boolean(sectionNode.attrs?.collapsed)) {
	                  return toggleAllOutlineSectionsCollapsed(this.editor, true);
	                }
	              }
	            }
	          } catch {
	            // ignore
	          }
	          return collapseParentSubtree();
	        },
	        // Ctrl+↓: развернуть текущую секцию (и всех её детей)
	        'Mod-ArrowDown': () => expandCurrentSubtree(),
	        // Ctrl+Enter: split секции в позиции курсора (children → в новую секцию)
	        'Mod-Enter': () => {
	          // IMPORTANT: In view-mode Ctrl/Cmd+Enter creates a new empty block above/below.
	          // Section split must work only in edit-mode.
	          try {
	            if (outlineEditModeKey) {
	              const st = outlineEditModeKey.getState(this.editor.state) || {};
	              if (!st.editingSectionId) return false;
	            }
	          } catch {
	            // ignore
	          }
	          return splitSectionAtCaret();
	        },
	        Backspace: () =>
	          this.editor.commands.command(({ state: pmState, dispatch }) => {
	            const { selection } = pmState;
	            if (clampHeadingDeletionToHeadingText(pmState, dispatch)) return true;
            if (clampCrossSectionDeletionToBody(pmState, dispatch)) return true;
            if (!selection?.empty) return false;
            const { $from } = selection;
            if ($from.parent?.type?.name !== 'outlineHeading') return false;
            if ($from.parentOffset !== 0) return false;
            const sectionPos = findSectionPos(pmState.doc, $from);
            if (typeof sectionPos !== 'number') return false;
            const sectionNode = pmState.doc.nodeAt(sectionPos);
            if (!sectionNode) return false;
            if (isSectionEmpty(sectionNode)) {
              return deleteCurrentSection(pmState, dispatch, sectionPos);
            }
            // Если нет предыдущего sibling — сливаемся в body родителя.
            try {
              const $pos = pmState.doc.resolve(sectionPos);
              const idx = $pos.index();
              if (idx <= 0) {
                return mergeSectionIntoParentBody(pmState, dispatch, sectionPos);
              }
            } catch {
              // ignore
            }
            return mergeSectionIntoPrevious(pmState, dispatch, sectionPos);
          }),
        Delete: () =>
          this.editor.commands.command(({ state: pmState, dispatch }) => {
            const { selection } = pmState;
            if (clampHeadingDeletionToHeadingText(pmState, dispatch)) return true;
            if (clampCrossSectionDeletionToBody(pmState, dispatch)) return true;
            if (!selection?.empty) return false;
            const { $from } = selection;

            // Delete в конце body: объединяем с нижним sibling.
            const bodyDepth = findDepth($from, 'outlineBody');
            if (bodyDepth !== null) {
              const sectionPos = findSectionPos(pmState.doc, $from);
              if (typeof sectionPos !== 'number') return false;
              const sectionNode = pmState.doc.nodeAt(sectionPos);
              if (!sectionNode) return false;
              const headingNode = sectionNode.child(0);
              const bodyNode = sectionNode.child(1);
              const bodyStart = sectionPos + 1 + headingNode.nodeSize;
              const bodyEnd = bodyStart + bodyNode.nodeSize - 1;
              if ($from.pos === bodyEnd) {
                return mergeSectionWithNextSibling(pmState, dispatch, sectionPos);
              }
              return false;
            }

            if ($from.parent?.type?.name !== 'outlineHeading') return false;
            // Если удаляем в заголовке на границе — не прыгаем в следующий блок,
            // а переходим в body текущей секции.
            const sectionPos = findSectionPos(pmState.doc, $from);
            if (typeof sectionPos !== 'number') return false;
            const sectionNode = pmState.doc.nodeAt(sectionPos);
            if (!sectionNode) return false;
            const headingNode = sectionNode.child(0);
            if ($from.parentOffset === headingNode.content.size) {
              if (isSectionEmpty(sectionNode)) {
                return deleteCurrentSection(pmState, dispatch, sectionPos);
              }
              const bodyNode = sectionNode.child(1);
              const bodyStart = sectionPos + 1 + headingNode.nodeSize;
              let tr = pmState.tr;
              if (!bodyNode.childCount) {
                const schema = pmState.doc.type.schema;
                tr = tr.insert(bodyStart + 1, schema.nodes.paragraph.create({}, []));
              }
              // Ставим курсор внутрь первого абзаца body (а не "между" body и абзацем),
              // иначе Delete/Backspace могут не срабатывать ожидаемо.
              tr = tr.setSelection(TextSelection.near(tr.doc.resolve(bodyStart + 2), 1));
              dispatch(tr.scrollIntoView());
              return true;
            }
            return false;
          }),
        Enter: () =>
          this.editor.commands.command(({ state: pmState, dispatch }) => {
            const { selection } = pmState;
            if (!selection?.empty) return false;
            const { $from } = selection;
            if ($from.parent?.type?.name !== 'outlineHeading') return false;
            const sectionPos = findSectionPos(pmState.doc, $from);
            if (typeof sectionPos !== 'number') return false;
            const sectionNode = pmState.doc.nodeAt(sectionPos);
            if (!sectionNode) return false;
            const headingNode = sectionNode.child(0);
            const bodyNode = sectionNode.child(1);
            const bodyStart = sectionPos + 1 + headingNode.nodeSize;

            // Enter в конце заголовка схлопнутой секции: создаём новый sibling ниже,
            // ничего не переносим и не пытаемся переходить в скрытое body.
            if (Boolean(sectionNode.attrs?.collapsed) && $from.parentOffset === headingNode.content.size) {
              const insertPos = sectionPos + sectionNode.nodeSize;
              const schema = pmState.doc.type.schema;
              const newId = safeUuid();
              const newSection = schema.nodes.outlineSection.create(
                { id: newId, collapsed: false },
                [
                  schema.nodes.outlineHeading.create({}, []),
                  schema.nodes.outlineBody.create({}, [schema.nodes.paragraph.create({}, [])]),
                  schema.nodes.outlineChildren.create({}, []),
                ],
              );
              let tr = pmState.tr.insert(insertPos, newSection);
              tr = tr.setSelection(TextSelection.create(tr.doc, insertPos + 2));
              tr = tr.setMeta(OUTLINE_ALLOW_META, true);
              if (outlineEditModeKey) {
                tr = tr.setMeta(outlineEditModeKey, { type: 'enter', sectionId: newId });
              }
              dispatch(tr.scrollIntoView());
              return true;
            }

            // Enter в начале заголовка: вставляем новый блок выше текущего
            // и ставим курсор в начало нового заголовка.
            if ($from.parentOffset === 0) {
              const schema = pmState.doc.type.schema;
              const newId = safeUuid();
              const newSection = schema.nodes.outlineSection.create(
                { id: newId, collapsed: false },
                [
                  schema.nodes.outlineHeading.create({}, []),
                  schema.nodes.outlineBody.create({}, [schema.nodes.paragraph.create({}, [])]),
                  schema.nodes.outlineChildren.create({}, []),
                ],
              );
              let tr = pmState.tr.insert(sectionPos, newSection);
              tr = tr.setSelection(TextSelection.create(tr.doc, sectionPos + 2));
              tr = tr.setMeta(OUTLINE_ALLOW_META, true);
              if (outlineEditModeKey) {
                tr = tr.setMeta(outlineEditModeKey, { type: 'enter', sectionId: newId });
              }
              dispatch(tr.scrollIntoView());
              return true;
            }

            let tr = pmState.tr;
            if (!bodyNode.childCount) {
              const schema = pmState.doc.type.schema;
              tr = tr.insert(bodyStart + 1, schema.nodes.paragraph.create({}, []));
            }
            tr = tr.setSelection(TextSelection.near(tr.doc.resolve(bodyStart + 2), 1));
            dispatch(tr.scrollIntoView());
            return true;
          }),
        ArrowUp: () =>
          this.editor.commands.command(({ state: pmState, dispatch }) => {
            const { selection } = pmState;
            if (!selection?.empty) return false;
            const { $from } = selection;
            if ($from.parent?.type?.name !== 'outlineHeading') return false;
            if ($from.parentOffset !== 0) return false;
            const sectionPos = findSectionPos(pmState.doc, $from);
            if (typeof sectionPos !== 'number') return false;

            // Навигация должна соответствовать визуальному порядку секций:
            // ищем предыдущую ВИДИМУЮ секцию в порядке обхода документа (DFS),
            // игнорируя секции, скрытые из-за collapsed-родителей.
            const prevVisible = findPrevVisibleSectionPos(pmState.doc, sectionPos);
            if (typeof prevVisible === 'number') {
              return moveSelectionToSectionEnd(pmState, dispatch, prevVisible);
            }

            const $pos = pmState.doc.resolve(sectionPos);
            const idx = $pos.index();
            const parent = $pos.parent;
            if (!parent) return false;

            // Обычный кейс: есть предыдущий sibling — прыгаем в конец его body.
            if (idx > 0) {
              const prevNode = parent.child(idx - 1);
              const prevStart = sectionPos - prevNode.nodeSize;
              return moveSelectionToSectionEnd(pmState, dispatch, prevStart);
            }

            // Если мы первый child, то предыдущего sibling нет — прыгаем в конец body родителя.
            let currentDepth = null;
            let parentDepth = null;
            for (let d = $from.depth; d > 0; d -= 1) {
              if ($from.node(d)?.type?.name === 'outlineSection') {
                if (currentDepth === null) currentDepth = d;
                else {
                  parentDepth = d;
                  break;
                }
              }
            }
            if (parentDepth === null) return false;
            const parentSectionPos = $from.before(parentDepth);
            return moveSelectionToSectionEnd(pmState, dispatch, parentSectionPos);
          }),
      };
    },
    addProseMirrorPlugins() {
      const findDepth = ($from, name) => {
        for (let d = $from.depth; d > 0; d -= 1) {
          if ($from.node(d)?.type?.name === name) return d;
        }
        return null;
      };

      return [
        new Plugin({
          props: {
            handleDOMEvents: {
              cut: (view, event) => {
                try {
                  const { state: pmState } = view;
                  const { selection } = pmState;
                  if (!selection || selection.empty) return false;

                  // Ctrl/Cmd+X: защита как для Delete/Backspace — не даём "съесть" границу секций,
                  // если выделение начинается в body и заканчивается в начале heading другой секции.
                  const findSectionPos = (doc, $from) => {
                    for (let d = $from.depth; d > 0; d -= 1) {
                      if ($from.node(d)?.type?.name === 'outlineSection') return $from.before(d);
                    }
                    return null;
                  };
                  const fromSectionPos = findSectionPos(pmState.doc, selection.$from);
                  const toSectionPos = findSectionPos(pmState.doc, selection.$to);
                  if (typeof fromSectionPos !== 'number' || typeof toSectionPos !== 'number') return false;
                  const escapeHtml = (s = '') =>
                    String(s || '')
                      .replace(/&/g, '&amp;')
                      .replace(/</g, '&lt;')
                      .replace(/>/g, '&gt;')
                      .replace(/"/g, '&quot;');

                  // Если вырезаем только заголовок (selection внутри outlineHeading),
                  // то не удаляем саму ноду заголовка, чтобы body не "переезжал" вверх.
                  if (fromSectionPos === toSectionPos) {
                    const fromHeadingDepth = findDepth(selection.$from, 'outlineHeading');
                    const toHeadingDepth = findDepth(selection.$to, 'outlineHeading');
                    if (fromHeadingDepth !== null && toHeadingDepth !== null) {
                      const sectionNode = pmState.doc.nodeAt(fromSectionPos);
                      if (!sectionNode) return false;
                      const headingNode = sectionNode.child(0);
                      const headingStart = fromSectionPos + 1;
                      const headingContentFrom = headingStart + 1;
                      const headingContentTo = headingStart + headingNode.nodeSize - 1;
                      if (selection.from >= headingContentFrom && selection.to <= headingContentTo) {
                        const deleteFrom = Math.max(selection.from, headingContentFrom);
                        const deleteTo = Math.min(selection.to, headingContentTo);
                        const plain = pmState.doc.textBetween(deleteFrom, deleteTo, '\n', '\n');
                        if (event?.clipboardData) {
                          try {
                            event.clipboardData.setData('text/plain', plain);
                            event.clipboardData.setData('text/html', `<pre>${escapeHtml(plain)}</pre>`);
                          } catch {
                            // ignore
                          }
                        }
                        event.preventDefault();
                        event.stopPropagation();
                        let tr = pmState.tr.delete(deleteFrom, deleteTo);
                        tr = tr.setSelection(TextSelection.near(tr.doc.resolve(headingContentFrom), 1));
                        view.dispatch(tr.scrollIntoView());
                        return true;
                      }
                    }
                    return false;
                  }

                  const fromBodyDepth = findDepth(selection.$from, 'outlineBody');
                  if (fromBodyDepth === null) return false;
                  if (selection.$to.parent?.type?.name !== 'outlineHeading') return false;
                  if (selection.$to.parentOffset !== 0) return false;

                  const sectionNode = pmState.doc.nodeAt(fromSectionPos);
                  if (!sectionNode) return false;
                  const headingNode = sectionNode.child(0);
                  const bodyNode = sectionNode.child(1);
                  const bodyStart = fromSectionPos + 1 + headingNode.nodeSize;
                  const bodyContentFrom = bodyStart + 1;
                  const bodyContentTo = bodyStart + bodyNode.nodeSize - 1;

                  const deleteFrom = Math.max(selection.from, bodyContentFrom);
                  const deleteTo = Math.min(selection.to, bodyContentTo);
                  if (deleteTo < deleteFrom) return true;

                  // Пишем в clipboard хотя бы text/plain, чтобы Ctrl+X не превращался в "Delete".
                  const plain = pmState.doc.textBetween(deleteFrom, deleteTo, '\n', '\n');
                  if (event?.clipboardData) {
                    try {
                      event.clipboardData.setData('text/plain', plain);
                      event.clipboardData.setData('text/html', `<pre>${escapeHtml(plain)}</pre>`);
                    } catch {
                      // ignore
                    }
                  }

                  event.preventDefault();
                  event.stopPropagation();

                  let tr = pmState.tr.delete(deleteFrom, deleteTo);
                  const bodyAfter = tr.doc.nodeAt(bodyStart);
                  if (bodyAfter && bodyAfter.content.size === 0) {
                    const schema = tr.doc.type.schema;
                    tr = tr.insert(bodyContentFrom, schema.nodes.paragraph.create({}, []));
                  }
                  tr = tr.setSelection(TextSelection.near(tr.doc.resolve(bodyContentFrom + 1), 1));
                  view.dispatch(tr.scrollIntoView());
                  return true;
                } catch {
                  return false;
                }
              },
            },
          },
        }),
        new Plugin({
          props: {
            handleKeyDown: (view, event) => {
              // UX для списков: если курсор в начале li и жмём Backspace,
              // переносим содержимое текущего li как НОВЫЙ абзац в конец предыдущего li,
              // вместо склеивания в конец строки.
              if (event.key !== 'Backspace') return false;
              const { state: pmState } = view;
              const { selection } = pmState;
              if (!selection?.empty) return false;
              const { $from } = selection;
              if ($from.parent?.type?.name !== 'paragraph') return false;
              if ($from.parentOffset !== 0) return false;

              // Найдём listItem и убедимся, что мы в самом начале первого paragraph внутри него.
              let listItemDepth = null;
              for (let d = $from.depth; d > 0; d -= 1) {
                if ($from.node(d)?.type?.name === 'listItem') {
                  listItemDepth = d;
                  break;
                }
              }
              if (listItemDepth === null) return false;
              if ($from.index(listItemDepth) !== 0) return false;

              const listDepth = listItemDepth - 1;
              const listNode = $from.node(listDepth);
              if (!listNode) return false;
              // Индекс текущего listItem среди children списка (bulletList/orderedList).
              const itemIndex = $from.index(listDepth);
              if (itemIndex <= 0) return false;

              const listItemPos = $from.before(listItemDepth);
              const prevNode = listNode.child(itemIndex - 1);
              const prevStart = listItemPos - prevNode.nodeSize;
              const curNode = pmState.doc.nodeAt(listItemPos);
              if (!curNode || curNode.type?.name !== 'listItem') return false;

              event.preventDefault();
              event.stopPropagation();

              // Собираем новый prev li = old prev + blocks текущего li,
              // при этом blocks остаются отдельными paragraph'ами (а не склеиваются в один).
              const mergedPrev = prevNode.type.create(
                prevNode.attrs,
                prevNode.content.append(curNode.content),
                prevNode.marks,
              );
              let tr = pmState.tr.replaceWith(prevStart, prevStart + prevNode.nodeSize, mergedPrev);

              // Позиция, где начинается перенесённый контент (после старого контента prev li).
              const insertedStartOrig = prevStart + 1 + prevNode.content.size;
              const insertedStart = tr.mapping.map(insertedStartOrig, 1);

              const curPosMapped = tr.mapping.map(listItemPos);
              tr = tr.delete(curPosMapped, curPosMapped + curNode.nodeSize);

              // Ставим курсор в начало перенесённого текста (в новый paragraph).
              try {
                tr = tr.setSelection(TextSelection.near(tr.doc.resolve(insertedStart + 1), 1));
              } catch {
                // ignore
              }
              view.dispatch(tr.scrollIntoView());
              return true;
            },
          },
        }),
        new Plugin({
          props: {
            handleKeyDown: (_view, event) => {
              // Внутри редактора Tab не должен уводить фокус на кнопки интерфейса.
              // При этом оставляем возможность другим плагинам обработать Tab (списки/таблицы).
              if (event.key !== 'Tab') return false;
              event.preventDefault();
              return false;
            },
          },
        }),
        new Plugin({
          props: {
            handleKeyDown: (view, event) => {
              // Гарантируем работу Ctrl+↑/↓ независимо от того, где стоит курсор
              // (в заголовке/теле/на границе), и не даём дефолтной навигации/скроллу перехватывать хоткей.
              if (!event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return false;
              if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return false;

              const { state: pmState } = view;
              const { selection } = pmState;
              if (!selection) return false;

              const findSectionPosFromSelection = () => {
                const selectedNode = selection?.node || null;
                if (selectedNode?.type?.name === 'outlineSection') return selection.from;
                const $from = selection.$from;
                for (let d = $from.depth; d > 0; d -= 1) {
                  if ($from.node(d)?.type?.name === 'outlineSection') return $from.before(d);
                }
                return null;
              };

              const sectionPos = findSectionPosFromSelection();
              if (typeof sectionPos !== 'number') return false;

              const findImmediateParentSectionPosForSectionPos = (doc, pos) => {
                try {
                  const $inside = doc.resolve(Math.min(doc.content.size, pos + 1));
                  let currentDepth = null;
                  for (let d = $inside.depth; d > 0; d -= 1) {
                    if ($inside.node(d)?.type?.name !== 'outlineSection') continue;
                    if ($inside.before(d) === pos) {
                      currentDepth = d;
                      break;
                    }
                  }
                  if (currentDepth === null) return null;
                  for (let d = currentDepth - 1; d > 0; d -= 1) {
                    if ($inside.node(d)?.type?.name === 'outlineSection') return $inside.before(d);
                  }
                  return null;
                } catch {
                  return null;
                }
              };

              const collectSectionPositions = (doc, rootPos) => {
                const rootNode = doc.nodeAt(rootPos);
                if (!rootNode || rootNode.type?.name !== 'outlineSection') return [];
                const positions = [rootPos];
                rootNode.descendants((node, p) => {
                  if (node?.type?.name !== 'outlineSection') return;
                  positions.push(rootPos + 1 + p);
                });
                return positions;
              };

              event.preventDefault();
              event.stopPropagation();

              if (event.key === 'ArrowUp') {
                // Ctrl+↑: схлопнуть родителя (и всех детей внутри него).
                const parentPos = findImmediateParentSectionPosForSectionPos(pmState.doc, sectionPos);
                const targetPos = typeof parentPos === 'number' ? parentPos : sectionPos;
                const positions = collectSectionPositions(pmState.doc, targetPos);
                if (!positions.length) return true;

                let tr = pmState.tr;
                for (const p of positions) {
                  const node = tr.doc.nodeAt(p);
                  if (!node || node.type?.name !== 'outlineSection') continue;
                  if (Boolean(node.attrs?.collapsed) === true) continue;
                  tr = tr.setNodeMarkup(p, undefined, { ...node.attrs, collapsed: true });
                }
                const targetNode = tr.doc.nodeAt(targetPos);
                if (targetNode) {
                  const heading = targetNode.child(0);
                  const headingStart = targetPos + 1;
                  const headingEnd = headingStart + heading.nodeSize - 1;
                  tr = tr.setSelection(TextSelection.near(tr.doc.resolve(headingEnd), -1));
                }
                view.dispatch(tr.scrollIntoView());
                return true;
              }

              // Ctrl+↓: развернуть текущий блок (и всех детей внутри него).
              const positions = collectSectionPositions(pmState.doc, sectionPos);
              if (!positions.length) return true;
              let tr = pmState.tr;
              for (const p of positions) {
                const node = tr.doc.nodeAt(p);
                if (!node || node.type?.name !== 'outlineSection') continue;
                if (Boolean(node.attrs?.collapsed) === false) continue;
                tr = tr.setNodeMarkup(p, undefined, { ...node.attrs, collapsed: false });
              }
              view.dispatch(tr);
              return true;
            },
          },
        }),
        new Plugin({
          props: {
	            handleKeyDown: (view, event) => {
	              if (event.key !== 'Enter') return false;
	              const { state: pmState } = view;
	              const { $from } = pmState.selection;
	              if (!pmState.selection.empty) return false;
	              const bodyDepth = findDepth($from, 'outlineBody');
	              if (bodyDepth === null) return false;
	              const paragraphDepth = findDepth($from, 'paragraph');
	              if (paragraphDepth === null) return false;
	              if ($from.node(paragraphDepth - 1)?.type?.name !== 'outlineBody') return false;

	              const paragraph = $from.node(paragraphDepth);
	              if (!paragraph || paragraph.content.size !== 0) return false;
	              if ($from.parentOffset !== 0 && $from.parentOffset !== paragraph.content.size) {
	                return false;
	              }
	              const bodyNode = $from.node(bodyDepth);
	              const idx = $from.index(bodyDepth);
	              if (idx !== bodyNode.childCount - 1) return false;
	              // "Умный Enter" должен срабатывать только на 3-е нажатие:
	              // 1-е Enter создаёт пустой параграф,
	              // 2-е Enter создаёт второй пустой параграф (чтобы можно было вставить пустую строку),
	              // 3-е Enter (когда в конце уже 2 пустых параграфа) создаёт новый блок.
	              if (idx < 1) return false;
	              const prevParagraph = bodyNode.child(idx - 1);
	              if (!prevParagraph || prevParagraph.type?.name !== 'paragraph' || prevParagraph.content.size !== 0) {
	                return false;
	              }

	              const sectionDepth = findDepth($from, 'outlineSection');
	              if (sectionDepth === null) return false;
	              const sectionPos = $from.before(sectionDepth);

              event.preventDefault();
              event.stopPropagation();

              let tr = pmState.tr;
              const bodyStart = $from.start(bodyDepth);
              let paragraphStart = bodyStart;
              for (let i = 0; i < idx; i += 1) {
                paragraphStart += bodyNode.child(i).nodeSize;
              }
              // Удаляем хвостовые пустые параграфы в конце body, чтобы не
              // накапливать «пустые строки» при повторном Enter.
              let firstEmptyIdx = idx;
              for (let j = idx; j >= 0; j -= 1) {
                const n = bodyNode.child(j);
                if (!n || n.type?.name !== 'paragraph' || n.content.size !== 0) break;
                firstEmptyIdx = j;
              }
              let deleteFrom = bodyStart;
              for (let i = 0; i < firstEmptyIdx; i += 1) {
                deleteFrom += bodyNode.child(i).nodeSize;
              }
              const deleteTo = paragraphStart + bodyNode.child(idx).nodeSize;
              tr = tr.delete(deleteFrom, deleteTo);

              const sectionNodeAfter = tr.doc.nodeAt(sectionPos);
              if (!sectionNodeAfter) return true;

              const insertPos = sectionPos + sectionNodeAfter.nodeSize;
              const schema = tr.doc.type.schema;
              const newId = safeUuid();
              const newSection = schema.nodes.outlineSection.create(
                { id: newId, collapsed: false },
                [
                  schema.nodes.outlineHeading.create({}, []),
                  schema.nodes.outlineBody.create({}, [schema.nodes.paragraph.create({}, [])]),
                  schema.nodes.outlineChildren.create({}, []),
                ],
              );
              tr = tr.insert(insertPos, newSection);
              tr = tr.setSelection(TextSelection.create(tr.doc, insertPos + 2));
              tr = tr.setMeta(OUTLINE_ALLOW_META, true);
              if (outlineEditModeKey) {
                tr = tr.setMeta(outlineEditModeKey, { type: 'enter', sectionId: newId });
              }
              view.dispatch(tr.scrollIntoView());
              return true;
            },
          },
        }),
      ];
    },
  });

  const OutlineActiveSection = Extension.create({
    name: 'outlineActiveSection',
    addProseMirrorPlugins() {
      return [
        new Plugin({
          props: {
            decorations(pmState) {
              try {
                const sectionPos = findOutlineSectionPosAtSelection(pmState.doc, pmState.selection.$from);
                if (typeof sectionPos !== 'number') return null;
                const sectionNode = pmState.doc.nodeAt(sectionPos);
                if (!sectionNode) return null;
                return DecorationSet.create(pmState.doc, [
                  Decoration.node(sectionPos, sectionPos + sectionNode.nodeSize, { 'data-active': 'true' }),
                ]);
              } catch {
                return null;
              }
            },
          },
        }),
      ];
    },
  });

  const OutlineEditMode = Extension.create({
    name: 'outlineEditMode',
    addProseMirrorPlugins() {
      const key = new PluginKey('outlineEditMode');
      outlineEditModeKey = key;
      let pendingMerge = null; // { sectionId: string, key: 'Backspace'|'Delete', ts: number }

      const getActiveSectionId = (pmState) => {
        const sectionPos = findOutlineSectionPosAtSelection(pmState.doc, pmState.selection.$from);
        if (typeof sectionPos !== 'number') return null;
        const node = pmState.doc.nodeAt(sectionPos);
        const id = String(node?.attrs?.id || '');
        return id || null;
      };

      const canEditChangeRanges = (stateBefore, tr, editingSectionId) => {
        if (!tr.docChanged) return true;
        if (!editingSectionId) return false;
        const sectionPos = findSectionPosById(stateBefore.doc, editingSectionId);
        if (typeof sectionPos !== 'number') return false;
        const sectionNode = stateBefore.doc.nodeAt(sectionPos);
        if (!sectionNode) return false;

        const headingNode = sectionNode.child(0);
        const bodyNode = sectionNode.child(1);
        const headingStart = sectionPos + 1;
        const headingFrom = headingStart + 1;
        const headingTo = headingStart + headingNode.nodeSize - 1;
        const bodyStart = sectionPos + 1 + headingNode.nodeSize;
        const bodyFrom = bodyStart + 1;
        const bodyTo = bodyStart + bodyNode.nodeSize - 1;

        const isAllowed = (from, to) => {
          const withinHeading = from >= headingFrom && to <= headingTo;
          const withinBody = from >= bodyFrom && to <= bodyTo;
          return withinHeading || withinBody;
        };

        for (const step of tr.steps) {
          const map = step.getMap();
          let ok = true;
          map.forEach((from, to) => {
            if (!isAllowed(from, to)) ok = false;
          });
          if (!ok) return false;
        }
        return true;
      };

      const notifyReadOnly = () => {
        try {
          showToast('Для редактирования нажмите Enter или двойной клик мышкой. Esc для выхода.');
        } catch {
          // ignore
        }
      };

      const notifyMergeConfirm = () => {
        try {
          showToast('Нажмите ещё раз, чтобы объединить блоки');
        } catch {
          // ignore
        }
      };

      const isMergeCandidateBackspace = (pmState) => {
        try {
          const { selection } = pmState;
          if (!selection?.empty) return false;
          const { $from } = selection;
          // On some platforms the resolved parent may be a text node; detect heading via depth.
          let headingDepth = null;
          for (let d = $from.depth; d > 0; d -= 1) {
            if ($from.node(d)?.type?.name === 'outlineHeading') {
              headingDepth = d;
              break;
            }
          }
          if (headingDepth === null) return false;
          const atHeadingStart = $from.pos === $from.start(headingDepth);
          if (!atHeadingStart) return false;

          const sectionPos = findOutlineSectionPosAtSelection(pmState.doc, $from);
          if (typeof sectionPos !== 'number') return false;
          const $pos = pmState.doc.resolve(sectionPos);
          const idx = $pos.index();
          if (idx > 0) return true; // есть previous sibling

          // Нет previous sibling — merge в body родителя (если есть родитель-секция)
          let seenCurrentSection = false;
          for (let d = $from.depth; d > 0; d -= 1) {
            if ($from.node(d)?.type?.name !== 'outlineSection') continue;
            if (!seenCurrentSection) {
              seenCurrentSection = true;
              continue;
            }
            return true; // found parent section
          }
          return false;
        } catch {
          return false;
        }
      };

      const isMergeCandidateDelete = (pmState, editingSectionId) => {
        try {
          if (!editingSectionId) return false;
          const { selection } = pmState;
          if (!selection?.empty) return false;
          const { $from } = selection;
          // Candidate: caret at the very end of current section body.
          const sectionPos = findOutlineSectionPosAtSelection(pmState.doc, $from);
          if (typeof sectionPos !== 'number') return false;
          const sectionNode = pmState.doc.nodeAt(sectionPos);
          if (!sectionNode) return false;
          if (String(sectionNode.attrs?.id || '') !== String(editingSectionId)) return false;
          const headingNode = sectionNode.child(0);
          const bodyNode = sectionNode.child(1);
          const bodyStart = sectionPos + 1 + headingNode.nodeSize;
          const bodyEnd = bodyStart + bodyNode.nodeSize - 1;
          if ($from.pos !== bodyEnd) return false;

          // There must be a next sibling section to merge with.
          const $pos = pmState.doc.resolve(sectionPos);
          const idx = $pos.index();
          const parent = $pos.parent;
          if (!parent) return false;
          return idx < parent.childCount - 1;
        } catch {
          return false;
        }
      };

      return [
        new Plugin({
          key,
          state: {
            init() {
              return { editingSectionId: null };
            },
            apply(tr, prev) {
              const meta = tr.getMeta(key);
              if (!meta) return prev;
              if (meta.type === 'enter') return { editingSectionId: meta.sectionId || null };
              if (meta.type === 'exit') return { editingSectionId: null };
              return prev;
            },
          },
          filterTransaction(tr, stateBefore) {
            const st = key.getState(stateBefore) || {};
            const editingSectionId = st.editingSectionId || null;
            if (tr.getMeta(OUTLINE_ALLOW_META)) return true;
            // Undo/redo должны работать всегда, даже в view-mode.
            if (tr.getMeta('history$') != null || tr.getMeta('closeHistory$') != null) return true;
            if (!tr.docChanged) return true;
            return canEditChangeRanges(stateBefore, tr, editingSectionId);
          },
          props: {
            decorations(pmState) {
              try {
                const st = key.getState(pmState) || {};
                const editingSectionId = st.editingSectionId || null;
                if (!editingSectionId) return null;
                const pos = findSectionPosById(pmState.doc, editingSectionId);
                if (typeof pos !== 'number') return null;
                const node = pmState.doc.nodeAt(pos);
                if (!node) return null;
                return DecorationSet.create(pmState.doc, [
                  Decoration.node(pos, pos + node.nodeSize, { 'data-editing': 'true' }),
                ]);
              } catch {
                return null;
              }
            },
	            handleKeyDown(view, event) {
	              const pmState = view.state;
	              const st = key.getState(pmState) || {};
	              const editingSectionId = st.editingSectionId || null;
              outlineDebug('keydown', {
                key: event?.key || null,
                repeat: Boolean(event?.repeat),
                editingSectionId: editingSectionId || null,
                selection: {
                  empty: Boolean(pmState?.selection?.empty),
                  parent: pmState?.selection?.$from?.parent?.type?.name || null,
                  parentOffset: pmState?.selection?.$from?.parentOffset ?? null,
                },
	              });
	              const activeSectionId = getActiveSectionId(pmState);

		              // Ctrl/Cmd+Delete (or Ctrl/Cmd+Backspace on laptops without a Delete key) in view-mode:
		              // delete current block (same as outlineDeleteBtn).
		              // In edit-mode, keep native behavior and do not interfere.
		              if (
		                !editingSectionId &&
		                (event.key === 'Delete' || event.key === 'Del' || event.key === 'Backspace') &&
		                (event.ctrlKey || event.metaKey) &&
		                !event.shiftKey &&
		                !event.altKey
		              ) {
		                try {
		                  deleteActiveSection();
	                } catch {
	                  // ignore
	                }
	                event.preventDefault();
	                event.stopPropagation();
	                return true;
	              }

		              // Backspace at the start of the first table cell: if there is a table right before,
		              // merge the tables and keep the cursor in the same cell.
	              // Only in edit-mode.
	              if (editingSectionId && event.key === 'Backspace' && !event.ctrlKey && !event.metaKey && !event.altKey) {
	                const promoted = tryPromoteBodyFirstLineToHeadingOnBackspace(
	                  pmState,
	                  view.dispatch,
	                  editingSectionId,
	                  TextSelection,
	                );
	                outlineDebug('editorProps.backspace.bodyToHeading', { promoted, editingSectionId });
	                if (promoted) {
	                  event.preventDefault();
	                  event.stopPropagation();
	                  return true;
	                }
	                const merged = tryMergeWithPreviousTableOnBackspace(pmState, view.dispatch);
	                outlineDebug('editorProps.backspace.tableMerge', { merged, editingSectionId: editingSectionId || null });
	                if (merged) {
	                  event.preventDefault();
	                  event.stopPropagation();
                  return true;
                }
              }

              // Ctrl/Cmd+Enter в view-mode: создать новый блок.
              // Если курсор в начале заголовка — вставить сверху, иначе — снизу.
              try {
                const isCtrlEnter =
                  (event.key === 'Enter' || event.code === 'Enter' || event.code === 'NumpadEnter') &&
                  (event.ctrlKey || event.metaKey) &&
                  !event.shiftKey &&
                  !event.altKey;
                if (!state.isPublicView && !editingSectionId && isCtrlEnter) {
                  const sel = pmState.selection;
                  const $from = sel?.$from || null;
                  if ($from) {
                    const sectionPos = findOutlineSectionPosAtSelection(pmState.doc, $from);
                    const sectionNode = typeof sectionPos === 'number' ? pmState.doc.nodeAt(sectionPos) : null;
                    if (typeof sectionPos === 'number' && sectionNode && sectionNode.type?.name === 'outlineSection') {
                      const isCaret = Boolean(sel && sel.empty);
                      const inHeading = $from.parent?.type?.name === 'outlineHeading';
                      const atHeadingStart = isCaret && inHeading && $from.parentOffset === 0;
                      const insertPos = atHeadingStart ? sectionPos : sectionPos + sectionNode.nodeSize;

                      event.preventDefault();
                      event.stopPropagation();
                      const schema = pmState.schema;
                      const newId = safeUuid();
                      const newSection = schema.nodes.outlineSection.create(
                        { id: newId, collapsed: false },
                        [
                          schema.nodes.outlineHeading.create({}, []),
                          schema.nodes.outlineBody.create({}, [schema.nodes.paragraph.create({}, [])]),
                          schema.nodes.outlineChildren.create({}, []),
                        ],
                      );
	                      let tr = pmState.tr.insert(insertPos, newSection);
	                      try {
	                        const inserted = tr.doc.nodeAt(insertPos);
	                        const heading = inserted?.child?.(0) || newSection.child(0);
	                        const bodyStart = insertPos + 1 + heading.nodeSize;
	                        tr = tr.setSelection(TextSelection.near(tr.doc.resolve(bodyStart + 2), 1));
	                      } catch {
	                        tr = tr.setSelection(TextSelection.create(tr.doc, insertPos + 2));
	                      }
                      tr = tr.setMeta(OUTLINE_ALLOW_META, true);
                      tr = tr.setMeta(key, { type: 'enter', sectionId: newId });
                      view.dispatch(tr.scrollIntoView());
                      try {
                        view.focus();
                      } catch {
                        // ignore
                      }
                      return true;
                    }
                  }
                }
              } catch {
                // ignore
              }

              // Сбрасываем pending merge при смене секции/любой другой клавише.
              if (!pendingMerge || pendingMerge.sectionId !== activeSectionId || pendingMerge.key !== event.key) {
                pendingMerge = null;
              }

	              if (
	                state.isPublicView &&
	                !editingSectionId &&
	                ((event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) ||
	                  (event.key === 'F2' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey))
	              ) {
		                event.preventDefault();
		                event.stopPropagation();
		                return true;
		              }

		              if (
		                !editingSectionId &&
		                ((event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) ||
		                  (event.key === 'F2' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey))
		              ) {
		                const sectionId = getActiveSectionId(pmState);
		                if (!sectionId) return false;
		                event.preventDefault();
		                event.stopPropagation();
	                view.dispatch(pmState.tr.setMeta(key, { type: 'enter', sectionId }));
	                return true;
	              }

              if (editingSectionId && event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                view.dispatch(pmState.tr.setMeta(key, { type: 'exit' }));
                return true;
              }

              if (!editingSectionId) {
                const isTextInput = event.key && event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey;
                const isDelete = event.key === 'Backspace' || event.key === 'Delete';
                if (isDelete) {
                  // Special case (view-mode): allow merging sections with Backspace at the start of heading,
                  // without entering edit mode first. After merge, auto-enter edit mode on the target section.
                  if (event.key === 'Backspace' && isMergeCandidateBackspace(pmState)) {
                    try {
                      const { selection } = pmState;
                      const { $from } = selection;
                      const sectionPos = findSectionPos(pmState.doc, $from);
                      if (typeof sectionPos !== 'number') return false;
                      const sectionNode = pmState.doc.nodeAt(sectionPos);
                      if (!sectionNode) return false;
                      const currentSectionId = String(sectionNode.attrs?.id || '');

                      // Determine merge target id in advance (prev sibling, or parent section if no prev).
                      let targetSectionId = null;
                      try {
                        const $pos = pmState.doc.resolve(sectionPos);
                        const idx = $pos.index();
                        const parent = $pos.parent;
                        if (parent && idx > 0) {
                          const prevNode = parent.child(idx - 1);
                          const prevStart = sectionPos - prevNode.nodeSize;
                          const prevSection = pmState.doc.nodeAt(prevStart);
                          targetSectionId = String(prevSection?.attrs?.id || '') || null;
                        } else {
                          for (let d = $from.depth - 1; d > 0; d -= 1) {
                            const n = $from.node(d);
                            if (n?.type?.name === 'outlineSection') {
                              const pid = String(n.attrs?.id || '');
                              // Skip the current section itself; we need the parent section (where we merge into).
                              if (pid && pid !== currentSectionId) {
                                targetSectionId = pid;
                                break;
                              }
                            }
                          }
                        }
                      } catch {
                        targetSectionId = null;
                      }

                      // Execute the same merge/delete logic as the Backspace shortcut, but in view-mode.
                      let ok = false;
                      if (outlineIsSectionEmptyForView(sectionNode)) {
                        ok = outlineDeleteCurrentSectionForView(pmState, view.dispatch, sectionPos);
                      } else {
                        try {
                          const $pos = pmState.doc.resolve(sectionPos);
                          const idx = $pos.index();
                          if (idx <= 0) {
                            ok = outlineMergeSectionIntoParentBodyForView(pmState, view.dispatch, sectionPos);
                          } else {
                            ok = outlineMergeSectionIntoPreviousForView(pmState, view.dispatch, sectionPos);
                          }
                        } catch {
                          ok = outlineMergeSectionIntoPreviousForView(pmState, view.dispatch, sectionPos);
                        }
                      }

                      if (ok && targetSectionId) {
                        window.setTimeout(() => {
                          try {
                            const stNow = key.getState(view.state) || {};
                            if (stNow.editingSectionId) return;
                            const currentPos = findSectionPosById(view.state.doc, targetSectionId);
                            const currentNode = typeof currentPos === 'number' ? view.state.doc.nodeAt(currentPos) : null;
                            if (!currentNode) return;

                            // If target was collapsed, expand it so body is visible.
                            let tr = view.state.tr;
                            if (Boolean(currentNode?.attrs?.collapsed)) {
                              tr = tr.setNodeMarkup(currentPos, undefined, { ...currentNode.attrs, collapsed: false });
                              tr = tr.setMeta(OUTLINE_ALLOW_META, true);
                            }

                            tr = tr.setMeta(key, { type: 'enter', sectionId: targetSectionId });

                            // Put caret into the start of target body.
	                            try {
	                              const nodeAfter = tr.doc.nodeAt(currentPos);
	                              if (nodeAfter && nodeAfter.type?.name === 'outlineSection') {
	                                const heading = nodeAfter.child(0);
	                                const body = nodeAfter.child(1);
	                                const bodyStart = currentPos + 1 + heading.nodeSize;
	                                const bodyEnd = bodyStart + body.nodeSize - 1;
	                                tr = tr.setSelection(TextSelection.near(tr.doc.resolve(bodyEnd), -1));
	                              }
	                            } catch {
	                              // ignore
	                            }

                            view.dispatch(tr.scrollIntoView());
                            try {
                              view.focus();
                            } catch {
                              // ignore
                            }
                          } catch {
                            // ignore
                          }
                        }, 0);
                      }

                      event.preventDefault();
                      event.stopPropagation();
                      return true;
                    } catch {
                      // fall through to default view-mode delete handling
                    }
                  }
                  event.preventDefault();
                  event.stopPropagation();
                  return true;
                }
                if (isTextInput) {
                  event.preventDefault();
                  event.stopPropagation();
                  notifyReadOnly();
                  return true;
                }
              }

              // В edit-mode: merge по Backspace/Delete требует подтверждения (2 нажатия),
              // при этом автоповтор игнорируем, чтобы не "съесть" соседние блоки.
              const isMergeCandidate =
                (event.key === 'Backspace' && isMergeCandidateBackspace(pmState)) ||
                (event.key === 'Delete' && isMergeCandidateDelete(pmState, editingSectionId));
              if (editingSectionId && (event.key === 'Backspace' || event.key === 'Delete') && isMergeCandidate) {
                if (event.repeat) {
                  event.preventDefault();
                  event.stopPropagation();
                  return true;
                }
                const now = Date.now();
                if (
                  pendingMerge &&
                  pendingMerge.sectionId === editingSectionId &&
                  pendingMerge.key === event.key &&
                  now - pendingMerge.ts < 1200
                ) {
                  pendingMerge = null;
                  // Разрешаем штатному keymap выполнить merge.
                  return false;
                }
                pendingMerge = { sectionId: editingSectionId, key: event.key, ts: now };
                event.preventDefault();
                event.stopPropagation();
                notifyMergeConfirm();
                return true;
              }
              return false;
            },
            handleTextInput() {
              // ProseMirror вызывает handleTextInput(view, from, to, text).
              // Здесь важно читать состояние плагина из `view.state`, а не из `this`.
              // eslint-disable-next-line prefer-rest-params
              const view = arguments[0];
              const st = view?.state ? key.getState(view.state) : null;
              if (st && st.editingSectionId) return false;
              notifyReadOnly();
              return true;
            },
            handleDOMEvents: {
              paste(view, event) {
                const pmState = view.state;
                const st = key.getState(pmState) || {};
                if (st.editingSectionId) return false;
                event.preventDefault();
                event.stopPropagation();
                notifyReadOnly();
                return true;
              },
              drop(view, event) {
                const pmState = view.state;
                const st = key.getState(pmState) || {};
                if (st.editingSectionId) return false;
                event.preventDefault();
                event.stopPropagation();
                notifyReadOnly();
                return true;
              },
            },
          },
        }),
      ];
    },
  });

	  const parseHtmlToNodes = (html) => {
    const normalized = (html || '').trim();
    if (!normalized) return [];
    // Для парсинга body используем обычный doc (block+), а не outline-doc.
	    const tmp = generateJSON(normalized, [
	      StarterKit.configure({ heading: false, link: false }),
	      Link.configure({
	        openOnClick: false,
	        protocols: OUTLINE_ALLOWED_LINK_PROTOCOLS,
	      }),
	      ResizableImage,
	      TableKit.configure({ table: { resizable: true } }),
	    ]);
	    const content = Array.isArray(tmp?.content) ? tmp.content : [];
	    // Если в HTML лежит markdown-таблица как текст, конвертируем её в настоящую table node.
	    const converted = [];
	    for (let i = 0; i < content.length; i += 1) {
	      const node = content[i];
	      if (node?.type !== 'paragraph') {
	        converted.push(node);
	        continue;
	      }
	      const text = extractParagraphTextFromJson(node).trim();
	      const maybeLine = text;
	      const row1 = splitMarkdownRow(maybeLine);
	      if (!row1) {
	        converted.push(node);
	        continue;
	      }
	      const lines = [];
	      const start = i;
	      let j = i;
	      for (; j < content.length; j += 1) {
	        const n = content[j];
	        if (n?.type !== 'paragraph') break;
	        const t = extractParagraphTextFromJson(n).trim();
	        if (!t) break;
	        lines.push(t);
	      }
	      const parsed = parseMarkdownTableLines(lines);
	      if (!parsed) {
	        converted.push(node);
	        continue;
	      }
	      const tableNode = buildTableJsonFromMarkdown(parsed);
	      if (!tableNode) {
	        converted.push(node);
	        continue;
	      }
	      converted.push(tableNode);
	      i = j - 1;
	      if (i < start) i = start;
	    }
	    return converted;
	  };
  outlineParseHtmlToNodes = parseHtmlToNodes;

		  const OutlineMarkdown = Extension.create({
		    name: 'outlineMarkdown',
		    addCommands() {
		      return {
		        insertMarkdown:
		          (markdown) =>
		          ({ editor }) => {
	            if (!outlineEditModeKey) return false;
	            const st = outlineEditModeKey.getState(editor.state) || {};
	            if (!st.editingSectionId) {
	              notifyReadOnlyGlobal();
	              return false;
	            }
	            if (!editor?.storage?.markdown?.parser) {
	              showToast('Markdown не поддерживается');
	              return false;
	            }
	            const html = editor.storage.markdown.parser.parse(String(markdown || ''), { inline: true });
	            const nodes = parseHtmlToNodes(html);
	            if (!nodes.length) return false;
	            return editor.chain().focus().insertContent(nodes).run();
	          },
		      };
		    },
		  });

		  const OutlineFormattedPaste = Extension.create({
		    name: 'outlineFormattedPaste',
		    addProseMirrorPlugins() {
		      const editor = this.editor;

		      const normalizeHtmlForBodyInsert = (rawHtml) => {
		        const normalized = String(rawHtml || '').trim();
		        if (!normalized) return '';
		        let doc = null;
		        try {
		          doc = new DOMParser().parseFromString(normalized, 'text/html');
		        } catch {
		          return normalized;
		        }
		        const body = doc?.body;
		        if (!body) return normalized;
		        try {
		          // Outline body doesn't support nested headings; downgrade them to paragraphs.
		          for (const h of Array.from(body.querySelectorAll('h1,h2,h3,h4,h5,h6'))) {
		            const p = doc.createElement('p');
		            const strong = doc.createElement('strong');
		            try {
		              while (h.firstChild) strong.appendChild(h.firstChild);
		            } catch {
		              strong.textContent = String(h.textContent || '');
		            }
		            p.appendChild(strong);
		            h.replaceWith(p);
		          }
		        } catch {
		          // ignore
		        }
		        return String(body.innerHTML || '').trim();
		      };

		      const looksLikeHtmlSource = (text) => {
		        const t = String(text || '').trim();
		        if (!t) return false;
		        if (!t.includes('<') || !t.includes('>')) return false;
		        if (!/<\s*\/?\s*[a-z][^>]*>/i.test(t)) return false;
		        try {
		          const doc = new DOMParser().parseFromString(t, 'text/html');
		          const body = doc?.body;
		          if (!body) return false;
		          const allowed = new Set([
		            'p',
		            'br',
		            'strong',
		            'b',
		            'em',
		            'i',
		            'u',
		            's',
		            'a',
		            'ul',
		            'ol',
		            'li',
		            'blockquote',
		            'pre',
		            'code',
		            'table',
		            'thead',
		            'tbody',
		            'tr',
		            'td',
		            'th',
		            'img',
		            'span',
		            'div',
		            'h1',
		            'h2',
		            'h3',
		            'h4',
		            'h5',
		            'h6',
		          ]);
		          const el = Array.from(body.querySelectorAll('*')).find((e) => allowed.has(String(e.tagName || '').toLowerCase()));
		          return Boolean(el);
		        } catch {
		          return false;
		        }
		      };

		      const looksLikeMarkdown = (text) => {
		        const t = String(text || '').replace(/\r\n/g, '\n').trim();
		        if (!t) return false;
		        // Strong signals only to avoid breaking plain-text pastes (logs, etc.).
		        const signals = [
		          /```[\s\S]*```/m, // fenced code block
		          /^\s{0,3}([-*+]|\d+\.)\s+\S/m, // list item
		          /^\s{0,3}>\s+\S/m, // blockquote
		          /\[[^\]]+\]\([^)]+\)/, // link
		          /!\[[^\]]*\]\([^)]+\)/, // image
		          /\*\*[^*\n]+\*\*/, // bold
		          /__[^_\n]+__/, // bold
		          /`[^`\n]+`/, // inline code
		        ];
		        return signals.some((re) => re.test(t));
		      };

		      const looksLikeMarkdownTable = (text) => {
		        try {
		          const lines = String(text || '')
		            .replace(/\r\n/g, '\n')
		            .split('\n')
		            .map((l) => String(l || '').trim())
		            .filter(Boolean);
		          if (lines.length < 2) return false;
		          return Boolean(parseMarkdownTableLines(lines));
		        } catch {
		          return false;
		        }
		      };

		      const insertParsedNodes = (view, nodes) => {
		        if (!nodes || !Array.isArray(nodes) || !nodes.length) return false;
		        const from = view?.state?.selection?.from;
		        const to = view?.state?.selection?.to;
		        if (!Number.isFinite(from) || !Number.isFinite(to)) return false;
		        try {
		          return editor
		            .chain()
		            .focus()
		            .command(({ tr }) => {
		              tr.setMeta(OUTLINE_ALLOW_META, true);
		              return true;
		            })
		            .insertContentAt({ from, to }, nodes)
		            .run();
		        } catch {
		          return false;
		        }
		      };

		      const maybeHandlePaste = (view, event) => {
		        try {
		          const st = outlineEditModeKey?.getState?.(view.state) || null;
		          if (!st?.editingSectionId) return false;

		          const items = event?.clipboardData?.items || null;
		          const files = event?.clipboardData?.files || null;
		          if ((files && files.length) || (items && Array.from(items).some((it) => it?.kind === 'file'))) return false;

		          const html = String(event?.clipboardData?.getData?.('text/html') || '').trim();
		          const text = String(event?.clipboardData?.getData?.('text/plain') || '').trim();

		          // Keep the existing "paste as outline sections" behavior.
		          if (html) {
		            try {
		              const htmlParsed = /<h[1-6][\s>]/i.test(html) ? true : false;
		              if (htmlParsed) return false;
		            } catch {
		              // ignore
		            }
		          }

		          // HTML fragment insertion (clipboard provides HTML).
		          if (html) {
		            const normalizedHtml = normalizeHtmlForBodyInsert(html);
		            const nodes = parseHtmlToNodes(normalizedHtml);
		            if (!nodes.length) return false;
		            event.preventDefault();
		            event.stopPropagation();
		            return insertParsedNodes(view, nodes);
		          }

		          // HTML source insertion (clipboard provides raw `<tag>` in text/plain).
		          if (text && looksLikeHtmlSource(text)) {
		            const normalizedHtml = normalizeHtmlForBodyInsert(text);
		            const nodes = parseHtmlToNodes(normalizedHtml);
		            if (!nodes.length) return false;
		            event.preventDefault();
		            event.stopPropagation();
		            return insertParsedNodes(view, nodes);
		          }

		          // Markdown insertion (convert markdown to HTML, then to nodes).
		          if (text && looksLikeMarkdown(text)) {
		            // Keep dedicated markdown-table handler.
		            if (looksLikeMarkdownTable(text)) return false;

		            // Keep the existing "markdown headings => outline sections" handler.
		            try {
		              const mdParsed = parseMarkdownOutlineSections(text);
		              const safeToConvert = mdParsed?.startsWithHeading || (mdParsed?.sections?.length || 0) >= 2;
		              if (safeToConvert) return false;
		            } catch {
		              // ignore
		            }

		            const parser = editor?.storage?.markdown?.parser || null;
		            if (!parser?.parse) return false;

		            const isInline =
		              !text.includes('\n') &&
		              !/^\s{0,3}([-*+]|\d+\.)\s+\S/m.test(text) &&
		              !/```[\s\S]*```/m.test(text) &&
		              !/^\s{0,3}>\s+\S/m.test(text);

		            const htmlFromMarkdown = String(parser.parse(text, { inline: isInline })).trim();
		            if (!htmlFromMarkdown) return false;

		            const normalizedHtml = normalizeHtmlForBodyInsert(htmlFromMarkdown);
		            const nodes = parseHtmlToNodes(normalizedHtml);
		            if (!nodes.length) return false;

		            event.preventDefault();
		            event.stopPropagation();
		            return insertParsedNodes(view, nodes);
		          }

		          return false;
		        } catch {
		          return false;
		        }
		      };

		      return [
		        new Plugin({
		          props: {
		            handlePaste(view, event) {
		              return maybeHandlePaste(view, event);
		            },
		            handleDOMEvents: {
		              paste(view, event) {
		                return maybeHandlePaste(view, event);
		              },
		            },
		          },
		        }),
		      ];
		    },
		  });

	  let shouldBootstrapDocJson = false;
	  let content = null;
	  const contentStart = perfEnabled() ? performance.now() : 0;
	  const candidate = state.article?.docJson || null;
	  if (candidate && typeof candidate === 'object') {
    // TipTap can accept JSON content directly.
    if (candidate.type === 'doc' && Array.isArray(candidate.content)) {
      content = candidate;
    }
  }
  if (!content) {
    content = buildOutlineDocFromBlocks({
      blocks: state.article?.blocks || [],
      parseHtmlToNodes,
    });
    shouldBootstrapDocJson = Boolean(state.article && !state.article?.docJson && !state.article?.encrypted);
  }
  if (contentStart) perfLog('build initial content', { ms: Math.round(performance.now() - contentStart) });

  if (outlineEditorInstance) {
    try {
      outlineEditorInstance.destroy();
    } catch {
      // ignore
    }
    outlineEditorInstance = null;
  }

				  const markdownExtension = Markdown
				    ? Markdown.configure({ html: true, tightLists: true, transformPastedText: false, transformCopiedText: false })
				    : null;

				  const OutlineTableCellStyling = Extension.create({
				    name: 'outlineTableCellStyling',
				    addOptions() {
				      return {
				        types: ['tableCell', 'tableHeader'],
				        textAlignValues: ['left', 'center', 'right', 'justify'],
				        verticalAlignValues: ['top', 'middle', 'bottom'],
				      };
				    },
				    addGlobalAttributes() {
				      const parseStyleProp = (el, prop) => {
				        try {
				          const v = el?.style?.[prop];
				          return v ? String(v).trim() : '';
				        } catch {
				          return '';
				        }
				      };
				      const renderStyle = (attrs) => {
				        const parts = [];
				        const textAlign = attrs?.nodeTextAlign ? String(attrs.nodeTextAlign) : '';
				        const vAlign = attrs?.nodeVerticalAlign ? String(attrs.nodeVerticalAlign) : '';
				        const textColor = attrs?.nodeTextColor ? String(attrs.nodeTextColor) : '';
				        const background = attrs?.nodeBackground ? String(attrs.nodeBackground) : '';
				        if (textAlign && this.options.textAlignValues.includes(textAlign)) parts.push(`text-align: ${textAlign}`);
				        if (vAlign && this.options.verticalAlignValues.includes(vAlign)) parts.push(`vertical-align: ${vAlign}`);
				        if (textColor) parts.push(`color: ${textColor}`);
				        if (background) parts.push(`background-color: ${background}`);
				        return parts.length ? { style: parts.join('; ') } : {};
				      };
				      return [
				        {
				          types: this.options.types,
				          attributes: {
				            nodeTextAlign: {
				              default: null,
				              parseHTML: (el) => {
				                const v = parseStyleProp(el, 'textAlign');
				                return v && this.options.textAlignValues.includes(v) ? v : null;
				              },
				              renderHTML: (attrs) => renderStyle(attrs),
				            },
				            nodeVerticalAlign: {
				              default: null,
				              parseHTML: (el) => {
				                const v = parseStyleProp(el, 'verticalAlign');
				                return v && this.options.verticalAlignValues.includes(v) ? v : null;
				              },
				              renderHTML: (attrs) => renderStyle(attrs),
				            },
				            nodeTextColor: {
				              default: null,
				              parseHTML: (el) => {
				                const v = parseStyleProp(el, 'color');
				                return v ? String(v).replace(/['"]+/g, '') : null;
				              },
				              renderHTML: (attrs) => renderStyle(attrs),
				            },
				            nodeBackground: {
				              default: null,
				              parseHTML: (el) => {
				                const v = parseStyleProp(el, 'backgroundColor');
				                return v ? String(v).replace(/['"]+/g, '') : null;
				              },
				              renderHTML: (attrs) => renderStyle(attrs),
				            },
				          },
				        },
				      ];
				    },
				    addCommands() {
				      const setAttrForCells = (attr, value) => ({ state: pmState, dispatch }) => {
				        try {
				          const cells = getSelectedTableCellsFromState(pmState);
				          if (!cells.length) return false;
				          let tr = pmState.tr;
				          let changed = false;
				          for (const { node, pos } of cells) {
				            if (!node || typeof pos !== 'number') continue;
				            const next = { ...(node.attrs || {}) };
				            if (value == null || value === '') delete next[attr];
				            else next[attr] = value;
				            tr = tr.setNodeMarkup(pos, undefined, next);
				            changed = true;
				          }
				          if (!changed) return false;
				          tr = tr.setMeta(OUTLINE_ALLOW_META, true);
				          dispatch(tr);
				          return true;
				        } catch {
				          return false;
				        }
				      };

				      const clearCells = () => ({ state: pmState, dispatch }) => {
				        try {
				          const cells = getSelectedTableCellsFromState(pmState);
				          if (!cells.length) return false;
				          const paragraphType = pmState.schema.nodes?.paragraph || null;
				          if (!paragraphType) return false;
				          let tr = pmState.tr;
				          // Replace from bottom to top to keep positions stable.
				          const desc = [...cells].sort((a, b) => Number(b.pos) - Number(a.pos));
				          let changed = false;
				          for (const { node, pos } of desc) {
				            if (!node || typeof pos !== 'number') continue;
				            const from = pos + 1;
				            const to = pos + node.nodeSize - 1;
				            if (!(to >= from)) continue;
				            const para = paragraphType.createAndFill();
				            if (!para) continue;
				            tr = tr.replaceWith(from, to, para);
				            changed = true;
				          }
				          if (!changed) return false;
				          tr = tr.setMeta(OUTLINE_ALLOW_META, true);
				          dispatch(tr.scrollIntoView());
				          return true;
				        } catch {
				          return false;
				        }
				      };

				      return {
				        setNodeTextAlign: (value) => setAttrForCells('nodeTextAlign', value),
				        setNodeVAlign: (value) => setAttrForCells('nodeVerticalAlign', value),
				        setNodeTextColor: (value) => setAttrForCells('nodeTextColor', value),
				        setNodeBackground: (value) => setAttrForCells('nodeBackground', value),
				        unsetNodeAlignment: () => ({ state: pmState, dispatch }) => {
				          try {
				            const cells = getSelectedTableCellsFromState(pmState);
				            if (!cells.length) return false;
				            let tr = pmState.tr;
				            let changed = false;
				            for (const { node, pos } of cells) {
				              if (!node || typeof pos !== 'number') continue;
				              const prevAlign = node.attrs?.nodeTextAlign || null;
				              const prevV = node.attrs?.nodeVerticalAlign || null;
				              if (!prevAlign && !prevV) continue;
				              const next = { ...(node.attrs || {}) };
				              delete next.nodeTextAlign;
				              delete next.nodeVerticalAlign;
				              tr = tr.setNodeMarkup(pos, undefined, next);
				              changed = true;
				            }
				            if (!changed) return false;
				            tr = tr.setMeta(OUTLINE_ALLOW_META, true);
				            dispatch(tr);
				            return true;
				          } catch {
				            return false;
				          }
				        },
				        clearNodeContents: () => clearCells(),
				      };
				    },
				  });

				  const OutlineTablePercentWidths = Extension.create({
				    name: 'outlineTablePercentWidths',
				    addProseMirrorPlugins() {
				      return [
			        new Plugin({
			          view(view) {
			            let raf = null;
			            const parsePx = (value) => {
			              const s = String(value || '').trim();
			              if (!s) return 0;
			              const m = s.match(/(-?\\d+(?:\\.\\d+)?)px/i);
			              return m ? Number(m[1]) || 0 : 0;
			            };
			            const apply = () => {
			              raf = null;
			              try {
			                const root = view?.dom;
			                if (!root) return;
			                const tables = root.querySelectorAll('.tableWrapper > table');
			                for (const table of tables) {
			                  const colgroup = table.querySelector('colgroup');
			                  if (!colgroup) continue;
			                  const cols = Array.from(colgroup.querySelectorAll('col'));
			                  if (!cols.length) continue;
			                  if (tableResizeActive) continue;
			                  // Always keep table responsive.
			                  try {
			                    table.style.width = '100%';
			                    table.style.maxWidth = '100%';
			                    table.style.tableLayout = 'fixed';
			                  } catch {
			                    // ignore
			                  }

			                  // If we already have saved percents, just re-apply them (don't recompute).
			                  let hasSavedPct = false;
			                  for (const col of cols) {
			                    const ds = col?.dataset?.ttPct || '';
			                    const pct = Number.parseFloat(String(ds || ''));
			                    if (Number.isFinite(pct) && pct > 0) {
			                      hasSavedPct = true;
			                      col.style.width = `${pct.toFixed(4)}%`;
			                      col.style.minWidth = '';
			                    } else {
			                      const fromStylePct = parsePct(col.style.width);
			                      if (fromStylePct != null && fromStylePct > 0) {
			                        hasSavedPct = true;
			                        col.dataset.ttPct = fromStylePct.toFixed(4);
			                        col.style.width = `${fromStylePct.toFixed(4)}%`;
			                        col.style.minWidth = '';
			                      }
			                    }
			                  }
			                  if (hasSavedPct) continue;

			                  // No saved widths yet (e.g. after moveTableColumn replaces the table DOM).
			                  // Derive percents from current DOM widths and persist them to dataset+style
			                  // so widths never "snap" to an implicit default.
			                  try {
			                    const firstRow = table.querySelector('tbody tr');
			                    if (!firstRow) continue;
			                    const cells = Array.from(firstRow.children || []).filter((el) => el && el.nodeType === 1);
			                    if (cells.length < cols.length) continue;
			                    const widthsPx = [];
			                    for (let i = 0; i < cols.length; i += 1) {
			                      const rect = cells[i].getBoundingClientRect();
			                      widthsPx.push(Number.isFinite(rect.width) ? rect.width : 0);
			                    }
			                    const total = widthsPx.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
			                    if (!(total > 0)) continue;
			                    const next = widthsPx.map((w) => clampPct((w / total) * 100));
			                    // Normalize drift on the last column.
			                    const sum = next.reduce((a, b) => a + b, 0);
			                    if (Math.abs(sum - 100) > 0.01) {
			                      next[next.length - 1] = clampPct(next[next.length - 1] + (100 - sum));
			                    }
			                    for (let i = 0; i < cols.length; i += 1) setColPct(cols[i], next[i]);
			                  } catch {
			                    // ignore
			                  }
			                }
			              } catch {
			                // ignore
			              }
			            };
			            const schedule = () => {
			              if (raf != null) return;
			              raf = window.requestAnimationFrame(apply);
			            };
			            schedule();
			            return {
			              update() {
			                schedule();
			              },
			              destroy() {
			                if (raf != null) {
			                  window.cancelAnimationFrame(raf);
			                  raf = null;
			                }
			              },
			            };
			          },
			        }),
			      ];
			    },
			  });

			  const OutlineTableSmartMouseSelection = Extension.create({
			    name: 'outlineTableSmartMouseSelection',
			    addProseMirrorPlugins() {
			      const CellSelection = outlineTableApi?.CellSelection || null;
			      if (!CellSelection) return [];

			      return [
			        new Plugin({
			          view(view) {
			            const findCellPos = ($pos) => {
			              try {
			                for (let d = $pos.depth; d >= 0; d -= 1) {
			                  const name = $pos.node(d)?.type?.name;
			                  if (name === 'tableCell' || name === 'tableHeader') return $pos.before(d);
			                }
			              } catch {
			                // ignore
			              }
			              return null;
			            };

			            const onMouseUp = () => {
			              try {
			                const st = outlineEditModeKey?.getState?.(view.state) || null;
			                if (!st?.editingSectionId) return;
			                const sel = view.state.selection;
			                if (!sel || sel.empty) return;
			                // If selection spans multiple cells, force CellSelection (text-selection across cells is useless).
			                const a = findCellPos(sel.$anchor);
			                const b = findCellPos(sel.$head);
			                if (a == null || b == null) return;
			                if (a === b) return;
			                const cellSel =
			                  typeof CellSelection.create === 'function'
			                    ? CellSelection.create(view.state.doc, a, b)
			                    : null;
			                if (!cellSel) return;
			                let tr = view.state.tr.setSelection(cellSel);
			                tr = tr.setMeta(OUTLINE_ALLOW_META, true);
			                view.dispatch(tr);
			              } catch {
			                // ignore
			              }
			            };

			            // Use capture so we run even if some handler stops propagation.
			            view.dom.addEventListener('mouseup', onMouseUp, true);
			            return {
			              destroy() {
			                view.dom.removeEventListener('mouseup', onMouseUp, true);
			              },
			            };
			          },
			        }),
			      ];
			    },
			  });

				  const OutlineTableResizeCapture = Extension.create({
				    name: 'outlineTableResizeCapture',
				    addProseMirrorPlugins() {
				      return [
			        new Plugin({
			          view(view) {
			            const onPointerDown = (event) => {
			              try {
			                const handle = event?.target?.closest?.('.column-resize-handle');
			                if (!handle) return;
			                const st = outlineEditModeKey?.getState?.(view.state) || null;
			                if (!st?.editingSectionId) return;
			                tableResizeActive = true;
			              } catch {
			                // ignore
			              }
			            };

			            const onPointerUp = () => {
			              if (!tableResizeActive) return;
			              tableResizeActive = false;
			              try {
			                const domAt = view.domAtPos(view.state.selection.from);
			                const base =
			                  (domAt?.node && domAt.node.nodeType === 1 ? domAt.node : domAt?.node?.parentElement) || null;
			                const tableEl = base?.closest?.('table') || null;
			                if (tableEl) captureTableColumnPercentsFromDom(tableEl);
			              } catch {
			                // ignore
			              }
			            };

			            view.dom.addEventListener('pointerdown', onPointerDown, true);
			            document.addEventListener('pointerup', onPointerUp, true);
			            document.addEventListener('pointercancel', onPointerUp, true);
			            return {
			              destroy() {
			                view.dom.removeEventListener('pointerdown', onPointerDown, true);
			                document.removeEventListener('pointerup', onPointerUp, true);
			                document.removeEventListener('pointercancel', onPointerUp, true);
			              },
			            };
			          },
			        }),
			      ];
			    },
				  });

				  const OutlineTableNodeUi = Extension.create({
				    name: 'outlineTableNodeUi',
				    addProseMirrorPlugins() {
				      const editor = this.editor;
				      const TABLE_TEXT_COLORS = [
				        { label: 'Default text', value: null },
				        { label: 'Gray text', value: 'var(--tt-color-text-gray)' },
				        { label: 'Brown text', value: 'var(--tt-color-text-brown)' },
				        { label: 'Orange text', value: 'var(--tt-color-text-orange)' },
				        { label: 'Yellow text', value: 'var(--tt-color-text-yellow)' },
				        { label: 'Green text', value: 'var(--tt-color-text-green)' },
				        { label: 'Blue text', value: 'var(--tt-color-text-blue)' },
				        { label: 'Purple text', value: 'var(--tt-color-text-purple)' },
				        { label: 'Pink text', value: 'var(--tt-color-text-pink)' },
				        { label: 'Red text', value: 'var(--tt-color-text-red)' },
				      ];
				      const TABLE_BG_COLORS = [
				        { label: 'Default background', value: null },
				        { label: 'Gray background', value: 'var(--tt-color-highlight-gray)' },
				        { label: 'Brown background', value: 'var(--tt-color-highlight-brown)' },
				        { label: 'Orange background', value: 'var(--tt-color-highlight-orange)' },
				        { label: 'Yellow background', value: 'var(--tt-color-highlight-yellow)' },
				        { label: 'Green background', value: 'var(--tt-color-highlight-green)' },
				        { label: 'Blue background', value: 'var(--tt-color-highlight-blue)' },
				        { label: 'Purple background', value: 'var(--tt-color-highlight-purple)' },
				        { label: 'Pink background', value: 'var(--tt-color-highlight-pink)' },
				        { label: 'Red background', value: 'var(--tt-color-highlight-red)' },
				      ];
				      const TABLE_ALIGN_TEXT = [
				        { label: 'Align left', value: 'left' },
				        { label: 'Align center', value: 'center' },
				        { label: 'Align right', value: 'right' },
				        { label: 'Justify', value: 'justify' },
				      ];
				      const TABLE_ALIGN_VERTICAL = [
				        { label: 'Align top', value: 'top' },
				        { label: 'Align middle', value: 'middle' },
				        { label: 'Align bottom', value: 'bottom' },
				      ];

				      const safeRect = (rect) => {
				        try {
				          if (!rect) return null;
				          const r = {
				            left: Number(rect.left),
				            top: Number(rect.top),
				            right: Number(rect.right),
				            bottom: Number(rect.bottom),
				            width: Number(rect.width),
				            height: Number(rect.height),
				          };
				          if (!Number.isFinite(r.left) || !Number.isFinite(r.top)) return null;
				          return r;
				        } catch {
				          return null;
				        }
				      };

				      const clampToViewport = (x, y, w, h, pad = 8) => {
				        try {
				          const vw = window.innerWidth || 0;
				          const vh = window.innerHeight || 0;
				          const left = Math.max(pad, Math.min(x, Math.max(pad, vw - w - pad)));
				          const top = Math.max(pad, Math.min(y, Math.max(pad, vh - h - pad)));
				          return { left, top };
				        } catch {
				          return { left: x, top: y };
				        }
				      };

				      class Menu {
				        constructor() {
				          this.panels = [];
				          this.onDocPointerDown = (e) => {
				            try {
				              const target = e?.target || null;
				              const path = typeof e?.composedPath === 'function' ? e.composedPath() : null;
				              const nodes = Array.isArray(path) && path.length ? path : target ? [target] : [];
				              if (!nodes.length) return;
				              for (const n of nodes) {
				                for (const p of this.panels) {
				                  if (p && (n === p || p.contains(n))) return;
				                }
				              }
				              this.closeAll();
				            } catch {
				              this.closeAll();
				            }
				          };
				          this.onKeyDown = (e) => {
				            if (e?.key === 'Escape') this.closeAll();
				          };
				        }

				        isOpen() {
				          return this.panels.length > 0;
				        }

				        closeAll() {
				          try {
				            for (const p of this.panels) p?.remove?.();
				          } catch {
				            // ignore
				          }
				          this.panels = [];
				          try {
				            document.removeEventListener('pointerdown', this.onDocPointerDown, false);
				            window.removeEventListener('keydown', this.onKeyDown, false);
				          } catch {
				            // ignore
				          }
				        }

				        openPanel({ anchorRect, items, level = 0 }) {
				          const ar = safeRect(anchorRect);
				          if (!ar) return;
				          // close deeper panels
				          while (this.panels.length > level) {
				            const p = this.panels.pop();
				            try {
				              p?.remove?.();
				            } catch {
				              // ignore
				            }
				          }

				          const panel = document.createElement('div');
				          panel.className = 'tt-table-menu';
				          panel.setAttribute('role', 'menu');
				          panel.setAttribute('data-level', String(level));
				          panel.addEventListener('pointerdown', (e) => {
				            e.stopPropagation();
				          });
				          panel.addEventListener('mousedown', (e) => {
				            e.stopPropagation();
				          });

				          for (const it of items) {
				            if (it.type === 'separator') {
				              const sep = document.createElement('div');
				              sep.className = 'tt-table-menu-sep';
				              panel.appendChild(sep);
				              continue;
				            }
				            const btn = document.createElement('button');
				            btn.type = 'button';
				            btn.className = 'tt-table-menu-item';
				            btn.textContent = it.label;
				            btn.disabled = Boolean(it.disabled);
				            if (it.swatch) {
				              btn.classList.add('has-swatch');
				              try {
				                const v = it.swatchValue == null ? 'transparent' : String(it.swatchValue);
				                btn.style.setProperty('--tt-swatch', v);
				              } catch {
				                // ignore
				              }
				            }
				            if (it.submenu) btn.classList.add('has-submenu');
				            btn.addEventListener('click', (e) => {
				              e.preventDefault();
				              e.stopPropagation();
				              if (it.disabled) return;
				              if (it.submenu) {
				                const br = btn.getBoundingClientRect();
				                this.openPanel({ anchorRect: br, items: it.submenu(), level: level + 1 });
				                return;
				              }
				              try {
				                it.onClick?.();
				              } finally {
				                this.closeAll();
				              }
				            });
				            panel.appendChild(btn);
				          }

				          document.body.appendChild(panel);
				          // position after mount (getBoundingClientRect requires DOM)
				          const pr = panel.getBoundingClientRect();
				          const baseX = level === 0 ? ar.right + 8 : ar.right + 8;
				          const baseY = level === 0 ? ar.top : ar.top;
				          const pos = clampToViewport(baseX, baseY, pr.width, pr.height);
				          panel.style.left = `${pos.left}px`;
				          panel.style.top = `${pos.top}px`;

				          this.panels.push(panel);
				          try {
				            if (this.panels.length === 1) {
				              // Bubble phase so menu can stopPropagation on pointerdown.
				              document.addEventListener('pointerdown', this.onDocPointerDown, false);
				              window.addEventListener('keydown', this.onKeyDown, false);
				            }
				          } catch {
				            // ignore
				          }
				        }
				      }

				      class TableUiView {
				        constructor(view) {
				          this.view = view;
				          this.menu = new Menu();
				          this.wrapper = null;
				          this.table = null;
				          this.observedTable = null;
				          this.resizeObserver = null;
				          this.layoutRaf = null;
				          this.resizeRaf = null;
				          this.destroyed = false;
				          this.root = document.createElement('div');
				          this.root.className = 'tt-table-ui';
				          this.root.style.display = 'none';

				          this.cellOutline = document.createElement('div');
				          this.cellOutline.className = 'tt-table-active-cell-outline';
				          this.cellOutline.style.display = 'none';
				          this.root.appendChild(this.cellOutline);

				          this.scheduleLayout = () => {
				            if (this.layoutRaf != null) return;
				            this.layoutRaf = window.requestAnimationFrame(() => {
				              this.layoutRaf = null;
				              if (this.destroyed) return;
				              this.update(this.view);
				            });
				          };
				          this.scheduleResizeLoop = () => {
				            if (this.resizeRaf != null) return;
				            this.resizeRaf = window.requestAnimationFrame(() => {
				              this.resizeRaf = null;
				              if (this.destroyed) return;
				              if (tableResizeActive) this.update(this.view);
				            });
				          };
				          this.onWrapperScroll = () => this.scheduleLayout();
				          this.onWindowResize = () => this.scheduleLayout();
				          try {
				            window.addEventListener('resize', this.onWindowResize, { passive: true });
				          } catch {
				            // ignore
				          }

				          this.rowHandles = [];
				          this.colHandles = [];
				          this.dragState = null;
				          this.suppressClickUntil = 0;

				          this.colDropIndicator = document.createElement('div');
				          this.colDropIndicator.className = 'tt-table-drop-indicator tt-table-drop-indicator-col';
				          this.colDropIndicator.style.display = 'none';
				          this.root.appendChild(this.colDropIndicator);

				          this.rowDropIndicator = document.createElement('div');
				          this.rowDropIndicator.className = 'tt-table-drop-indicator tt-table-drop-indicator-row';
				          this.rowDropIndicator.style.display = 'none';
				          this.root.appendChild(this.rowDropIndicator);
				          this.cellHandle = document.createElement('button');
				          this.cellHandle.type = 'button';
				          this.cellHandle.className = 'tt-table-handle tt-table-cell-handle';
				          this.cellHandle.setAttribute('aria-label', 'Cell actions');
				          this.cellHandle.addEventListener('click', (e) => {
				            e.preventDefault();
				            e.stopPropagation();
				            const rect = this.cellHandle.getBoundingClientRect();
				            this.openCellMenu(rect);
				          });
				          this.root.appendChild(this.cellHandle);
				        }

				        hideDropIndicators() {
				          try {
				            if (this.colDropIndicator) this.colDropIndicator.style.display = 'none';
				          } catch {
				            // ignore
				          }
				          try {
				            if (this.rowDropIndicator) this.rowDropIndicator.style.display = 'none';
				          } catch {
				            // ignore
				          }
				        }

				        cancelDrag() {
				          const st = this.dragState;
				          if (!st) return;
				          this.dragState = null;
				          this.hideDropIndicators();
				          try {
				            window.removeEventListener('pointermove', st.onMove);
				            window.removeEventListener('pointerup', st.onUp);
				            window.removeEventListener('pointercancel', st.onUp);
          } catch {
            // ignore
          }
          try {
            document.body.classList.remove('tt-table-dragging');
          } catch {
            // ignore
          }
        }

				        destroy() {
				          this.destroyed = true;
				          this.cancelDrag();
				          try {
				            this.cellOutline.style.display = 'none';
				          } catch {
				            // ignore
				          }
				          this.menu.closeAll();
				          try {
				            if (this.layoutRaf != null) window.cancelAnimationFrame(this.layoutRaf);
				          } catch {
				            // ignore
				          }
				          this.layoutRaf = null;
				          try {
				            if (this.resizeRaf != null) window.cancelAnimationFrame(this.resizeRaf);
				          } catch {
				            // ignore
				          }
				          this.resizeRaf = null;
				          try {
				            window.removeEventListener('resize', this.onWindowResize);
				          } catch {
				            // ignore
				          }
				          try {
				            this.wrapper?.removeEventListener?.('scroll', this.onWrapperScroll);
				          } catch {
				            // ignore
				          }
				          try {
				            this.resizeObserver?.disconnect?.();
				          } catch {
				            // ignore
				          }
				          this.resizeObserver = null;
				          this.observedTable = null;
				          try {
				            this.root.remove();
				          } catch {
				            // ignore
				          }
				          this.wrapper = null;
				          this.table = null;
				        }

				        ensureAttached(wrapper) {
				          if (!wrapper) return;
				          if (this.wrapper === wrapper) return;
				          try {
				            this.wrapper?.removeEventListener?.('scroll', this.onWrapperScroll);
				          } catch {
				            // ignore
				          }
				          try {
				            this.root.remove();
				          } catch {
				            // ignore
				          }
				          this.wrapper = wrapper;
				          try {
				            this.wrapper.addEventListener('scroll', this.onWrapperScroll, { passive: true });
				          } catch {
				            // ignore
				          }
				          this.wrapper.appendChild(this.root);
				        }

				        buildRowHandles(count) {
				          while (this.rowHandles.length > count) {
				            const btn = this.rowHandles.pop();
				            try {
				              btn?.remove?.();
				            } catch {
				              // ignore
				            }
				          }
				          while (this.rowHandles.length < count) {
				            const btn = document.createElement('button');
				            btn.type = 'button';
				            btn.className = 'tt-table-handle tt-table-row-handle';
				            btn.setAttribute('aria-label', 'Row actions');
				            btn.dataset.idx = String(this.rowHandles.length);
				            btn.addEventListener('pointerdown', (e) => this.onHandlePointerDown(e, btn, 'row'));
					            btn.addEventListener('click', (e) => {
					              if (Date.now() < this.suppressClickUntil) {
					                e.preventDefault();
					                e.stopPropagation();
					                return;
					              }
					              e.preventDefault();
					              e.stopPropagation();
					              const tablePos = getActiveTableContext(this.view?.state)?.tablePos;
					              const rect = btn.getBoundingClientRect();
					              editor?.chain?.().focus?.().run?.();
					              const idx = Number(btn.dataset.idx || 0);
					              selectOutlineTableRow(editor, idx);
					              this.openRowMenu(rect, idx, tablePos);
					            });
				            this.rowHandles.push(btn);
				            this.root.appendChild(btn);
				          }
				        }

				        buildColHandles(count) {
				          while (this.colHandles.length > count) {
				            const btn = this.colHandles.pop();
				            try {
				              btn?.remove?.();
				            } catch {
				              // ignore
				            }
				          }
				          while (this.colHandles.length < count) {
				            const btn = document.createElement('button');
				            btn.type = 'button';
				            btn.className = 'tt-table-handle tt-table-col-handle';
				            btn.setAttribute('aria-label', 'Column actions');
				            btn.dataset.idx = String(this.colHandles.length);
				            btn.addEventListener('pointerdown', (e) => this.onHandlePointerDown(e, btn, 'col'));
					            btn.addEventListener('click', (e) => {
					              if (Date.now() < this.suppressClickUntil) {
					                e.preventDefault();
					                e.stopPropagation();
					                return;
					              }
					              e.preventDefault();
					              e.stopPropagation();
					              const tablePos = getActiveTableContext(this.view?.state)?.tablePos;
					              const rect = btn.getBoundingClientRect();
					              editor?.chain?.().focus?.().run?.();
					              const idx = Number(btn.dataset.idx || 0);
					              selectOutlineTableColumn(editor, idx);
					              this.openColumnMenu(rect, idx, tablePos);
					            });
				            this.colHandles.push(btn);
				            this.root.appendChild(btn);
				          }
				        }

	        onHandlePointerDown(e, btn, kind) {
	          try {
	            if (!e || e.button !== 0) return;
	            e.preventDefault();
	            e.stopPropagation();
	            editor?.chain?.().focus?.().run?.();
	            const fromIndex = Number(btn?.dataset?.idx || 0);
	            try {
	              if (typeof btn.setPointerCapture === 'function') btn.setPointerCapture(e.pointerId);
	            } catch {
	              // ignore
	            }

            const state = {
              kind,
              btn,
              pointerId: e.pointerId,
              fromIndex,
              startX: e.clientX,
              startY: e.clientY,
              moved: false,
            };
            this.dragState = state;

            const onMove = (ev) => this.onHandlePointerMove(ev);
            const onUp = (ev) => this.onHandlePointerUp(ev);
            state.onMove = onMove;
            state.onUp = onUp;
            window.addEventListener('pointermove', onMove, { passive: false });
            window.addEventListener('pointerup', onUp, { passive: false });
            window.addEventListener('pointercancel', onUp, { passive: false });
          } catch {
            // ignore
          }
        }

        onHandlePointerMove(e) {
          const st = this.dragState;
          if (!st || !e) return;
          if (e.pointerId !== st.pointerId) return;
          try {
            e.preventDefault();
          } catch {
            // ignore
          }
          const dx = e.clientX - st.startX;
          const dy = e.clientY - st.startY;
          if (!st.moved && Math.hypot(dx, dy) >= 4) {
            st.moved = true;
            try {
              document.body.classList.add('tt-table-dragging');
            } catch {
              // ignore
            }
          }
          if (st.moved) {
            const dropIndex = this.getDropIndexFromPointer(st.kind, e.clientX, e.clientY);
            st.dropIndex = dropIndex;
            if (dropIndex == null) this.hideDropIndicators();
            else this.updateDropIndicator(st.kind, dropIndex, e.clientX, e.clientY);
          }
        }

        getDropIndexFromPointer(kind, clientX, clientY) {
          try {
            const tableEl = this.table;
            if (!tableEl) return null;
            const rows = Array.from(tableEl.querySelectorAll('tbody tr'));
            if (!rows.length) return null;
            if (kind === 'col') {
              const firstRowCells = Array.from(rows[0].children || []).filter((x) => x && x.nodeType === 1);
              if (!firstRowCells.length) return null;
              const centers = firstRowCells.map((el) => {
                const rect = el.getBoundingClientRect();
                return rect.left + rect.width / 2;
              });
              if (!centers.length) return null;
              if (clientX < centers[0]) return 0;
              for (let i = 0; i < centers.length - 1; i += 1) {
                if (clientX >= centers[i] && clientX < centers[i + 1]) return i + 1;
              }
              return centers.length - 1;
            }
            const centers = rows
              .map((rowEl) => {
                const cellEl = rowEl.children && rowEl.children[0];
                if (!cellEl) return null;
                const rect = cellEl.getBoundingClientRect();
                return rect.top + rect.height / 2;
              })
              .filter((x) => typeof x === 'number');
            if (!centers.length) return null;
            if (clientY < centers[0]) return 0;
            for (let i = 0; i < centers.length - 1; i += 1) {
              if (clientY >= centers[i] && clientY < centers[i + 1]) return i + 1;
            }
            return centers.length - 1;
          } catch {
            return null;
          }
        }

        updateDropIndicator(kind, dropIndex, clientX, clientY) {
          try {
            const tableEl = this.table;
            const wrapper = this.wrapper;
            if (!tableEl || !wrapper) return;
            const wrapperRect = wrapper.getBoundingClientRect();
            const tableRect = tableEl.getBoundingClientRect();
            const tableTop = tableRect.top - wrapperRect.top;
            const tableLeft = tableRect.left - wrapperRect.left;
            const tableWidth = tableRect.width;
            const tableHeight = tableRect.height;
            const rows = Array.from(tableEl.querySelectorAll('tbody tr'));
            if (!rows.length) return;

            if (kind === 'col') {
              const cells = Array.from(rows[0].children || []).filter((x) => x && x.nodeType === 1);
              if (!cells.length) return;
              const idx = Math.max(0, Math.min(cells.length - 1, Number(dropIndex)));
              const rect = cells[idx].getBoundingClientRect();
              const lastRect = cells[cells.length - 1].getBoundingClientRect();
              const lastCenter = lastRect.left + lastRect.width / 2;
              const x =
                idx === cells.length - 1 && clientX > lastCenter ? lastRect.right - wrapperRect.left : rect.left - wrapperRect.left;

              this.colDropIndicator.style.display = '';
              this.rowDropIndicator.style.display = 'none';
              this.colDropIndicator.style.left = `${Math.round(x)}px`;
              this.colDropIndicator.style.top = `${Math.round(tableTop)}px`;
              this.colDropIndicator.style.height = `${Math.max(0, Math.round(tableHeight))}px`;
              return;
            }

            const idx = Math.max(0, Math.min(rows.length - 1, Number(dropIndex)));
            const cellEl = rows[idx]?.children?.[0];
            if (!cellEl) return;
            const rect = cellEl.getBoundingClientRect();
            const lastCell = rows[rows.length - 1]?.children?.[0] || null;
            const lastRect = lastCell?.getBoundingClientRect?.() || null;
            const lastCenter = lastRect ? lastRect.top + lastRect.height / 2 : null;
            const y =
              idx === rows.length - 1 && lastRect && typeof lastCenter === 'number' && clientY > lastCenter
                ? lastRect.bottom - wrapperRect.top
                : rect.top - wrapperRect.top;

            this.rowDropIndicator.style.display = '';
            this.colDropIndicator.style.display = 'none';
            this.rowDropIndicator.style.left = `${Math.round(tableLeft)}px`;
            this.rowDropIndicator.style.top = `${Math.round(y)}px`;
            this.rowDropIndicator.style.width = `${Math.max(0, Math.round(tableWidth))}px`;
          } catch {
            // ignore
          }
        }

        onHandlePointerUp(e) {
          const st = this.dragState;
          if (!st || !e) return;
          if (e.pointerId !== st.pointerId) return;
          try {
            e.preventDefault();
            e.stopPropagation();
          } catch {
            // ignore
          }
          this.dragState = null;
          try {
            window.removeEventListener('pointermove', st.onMove);
            window.removeEventListener('pointerup', st.onUp);
            window.removeEventListener('pointercancel', st.onUp);
          } catch {
            // ignore
          }
          try {
            document.body.classList.remove('tt-table-dragging');
          } catch {
            // ignore
          }
          this.hideDropIndicators();

          if (!st.moved) return;
          this.suppressClickUntil = Date.now() + 250;
          const dropIndex = st.dropIndex ?? this.getDropIndexFromPointer(st.kind, e.clientX, e.clientY);
          if (dropIndex == null) return;

          try {
            editor?.chain?.().focus?.().run?.();
          } catch {
            // ignore
          }
          if (st.kind === 'col') moveTableColumnToIndex(editor, st.fromIndex, dropIndex);
          else moveTableRowToIndex(editor, st.fromIndex, dropIndex);
          this.scheduleLayout();
        }

        isEnabled() {
          try {
            const st = outlineEditModeKey?.getState?.(this.view.state) || null;
            return Boolean(st?.editingSectionId) && !state.isPublicView;
				          } catch {
				            return false;
				          }
				        }

					        update(view) {
					          this.view = view;
				          if (!tableResizeActive && this.resizeRaf != null) {
				            try {
				              window.cancelAnimationFrame(this.resizeRaf);
				            } catch {
				              // ignore
				            }
				            this.resizeRaf = null;
				          }
					          if (!this.isEnabled()) {
					            this.root.style.display = 'none';
					            this.menu.closeAll();
					            try {
					              this.cellOutline.style.display = 'none';
					            } catch {
					              // ignore
					            }
					            return;
					          }
					          const ctx = getActiveTableContext(view.state);
					          const activeCellEl = getActiveTableCellDom(view);
					          const tableEl = activeCellEl?.closest?.('table') || getActiveTableDom(view);
					          const wrapper = tableEl?.closest?.('.tableWrapper') || null;
					          if (!ctx || !tableEl || !wrapper || !activeCellEl) {
					            this.root.style.display = 'none';
					            // Keep menu open while the cursor is interacting with it (editor may temporarily lose focus).
					            if (!this.menu.isOpen()) this.menu.closeAll();
					            try {
					              this.cellOutline.style.display = 'none';
					            } catch {
					              // ignore
					            }
					            return;
					          }
				          this.ensureAttached(wrapper);
				          this.table = tableEl;
				          try {
				            if (typeof ResizeObserver === 'function') {
				              if (!this.resizeObserver) {
				                this.resizeObserver = new ResizeObserver(() => this.scheduleLayout());
				              }
				              if (this.observedTable !== tableEl) {
				                this.resizeObserver.disconnect();
				                this.resizeObserver.observe(tableEl);
				                this.observedTable = tableEl;
				              }
				            }
				          } catch {
				            // ignore
				          }
				          this.root.style.display = '';

				          const rows = Array.from(tableEl.querySelectorAll('tbody tr'));
				          const rowCount = Number(ctx.map?.height || rows.length || 0);
				          const colCount = Number(ctx.map?.width || 0);
				          this.buildRowHandles(Math.max(0, rowCount));
				          this.buildColHandles(Math.max(0, colCount));

				          const wrapperRect = wrapper.getBoundingClientRect();
				          const tableRect = tableEl.getBoundingClientRect();
				          const tableTop = tableRect.top - wrapperRect.top;
				          const tableLeft = tableRect.left - wrapperRect.left;
				          const handleThickness = 14;
				          const handleGap = 4;
				          const handleMinCenter = handleThickness / 2;
				          const activeRowIndex = Math.max(0, Math.min(Math.max(0, rowCount - 1), Number(ctx.rowIndex || 0)));
				          const activeColIndex = Math.max(0, Math.min(Math.max(0, colCount - 1), Number(ctx.colIndex || 0)));
				          const colHandleTop = Math.max(handleMinCenter, tableTop - (handleThickness / 2 + handleGap));
				          const rowHandleLeft = Math.max(handleMinCenter, tableLeft - (handleThickness / 2 + handleGap));
				          const activeCellRect = activeCellEl.getBoundingClientRect();
				          const activeCellX = activeCellRect.left - wrapperRect.left + activeCellRect.width / 2;
				          const activeCellY = activeCellRect.top - wrapperRect.top + activeCellRect.height / 2;
				          const activeCellLeft = activeCellRect.left - wrapperRect.left;
				          const activeCellTop = activeCellRect.top - wrapperRect.top;

				          // Determine selection type (cell/row/col/range).
				          let selectionKind = 'cell';
				          try {
				            const sel = view.state.selection;
				            const anchorPos = sel?.$anchorCell?.pos;
				            const headPos = sel?.$headCell?.pos;
				            if (typeof anchorPos === 'number' && typeof headPos === 'number' && anchorPos !== headPos) {
				              const anchorRel = anchorPos - (ctx.tablePos + 1);
				              const headRel = headPos - (ctx.tablePos + 1);
				              const rect = ctx.map?.rectBetween?.(anchorRel, headRel) || null;
				              if (rect) {
				                const w = Number(rect.right) - Number(rect.left);
				                const h = Number(rect.bottom) - Number(rect.top);
				                if (w === 1 && h > 1) selectionKind = 'col';
				                else if (h === 1 && w > 1) selectionKind = 'row';
				                else selectionKind = 'range';
				              } else {
				                selectionKind = 'range';
				              }
				            }
				          } catch {
				            selectionKind = 'cell';
				          }

				          // Active cell outline (overlay to avoid DOM mutations inside the editor)
				          try {
				            if (selectionKind === 'cell') {
				              this.cellOutline.style.display = '';
				              this.cellOutline.style.left = `${Math.round(activeCellLeft)}px`;
				              this.cellOutline.style.top = `${Math.round(activeCellTop)}px`;
				              this.cellOutline.style.width = `${Math.max(0, Math.round(activeCellRect.width))}px`;
				              this.cellOutline.style.height = `${Math.max(0, Math.round(activeCellRect.height))}px`;
				            } else {
				              this.cellOutline.style.display = 'none';
				            }
				          } catch {
				            try {
				              this.cellOutline.style.display = 'none';
				            } catch {
				              // ignore
				            }
				          }

				          // Column handles at top
				          for (let i = 0; i < this.colHandles.length; i += 1) {
				            const btn = this.colHandles[i];
				            if (!btn) continue;
				            btn.dataset.idx = String(i);
				            if (i !== activeColIndex) {
				              btn.style.display = 'none';
				              continue;
				            }
				            btn.style.display = '';
				            btn.style.width = `${Math.max(18, Math.round(activeCellRect.width))}px`;
				            btn.style.height = `${handleThickness}px`;
				            btn.style.left = `${Math.round(activeCellX)}px`;
				            btn.style.top = `${Math.round(colHandleTop)}px`;
				          }

				          // Row handles at left
				          for (let i = 0; i < this.rowHandles.length; i += 1) {
				            const btn = this.rowHandles[i];
				            if (!btn) continue;
				            btn.dataset.idx = String(i);
				            if (i !== activeRowIndex) {
				              btn.style.display = 'none';
				              continue;
				            }
				            btn.style.display = '';
				            btn.style.width = `${handleThickness}px`;
				            btn.style.height = `${Math.max(18, Math.round(activeCellRect.height))}px`;
				            btn.style.left = `${Math.round(rowHandleLeft)}px`;
				            btn.style.top = `${Math.round(activeCellY)}px`;
				          }

				          // Cell handle near active cell
				          try {
				            if (selectionKind !== 'cell') {
				              this.cellHandle.style.display = 'none';
				            } else {
				              // Anchor on the right border of the actual selected cell.
				              const x = activeCellRect.right - wrapperRect.left;
				              this.cellHandle.style.display = '';
				              this.cellHandle.style.left = `${Math.round(x)}px`;
				              this.cellHandle.style.top = `${Math.round(activeCellY)}px`;
				            }
				          } catch {
				            this.cellHandle.style.display = 'none';
				          }
				          if (tableResizeActive) this.scheduleResizeLoop();
				        }

					        openCellMenu(anchorRect) {
					          const restoreFocus = () => {
					            try {
					              editor?.chain?.().focus?.().run?.();
					            } catch {
					              // ignore
					            }
					          };
					          const items = [
					            {
					              label: 'Color',
					              submenu: () => [
					                {
					                  label: 'text',
					                  submenu: () =>
					                    TABLE_TEXT_COLORS.map((c) => ({
					                      label: c.label,
					                      swatch: true,
					                      swatchValue: c.value,
					                      onClick: () => {
					                        restoreFocus();
					                        editor.commands.setNodeTextColor(c.value);
					                      },
					                    })),
					                },
					                {
					                  label: 'Background color',
					                  submenu: () =>
					                    TABLE_BG_COLORS.map((c) => ({
					                      label: c.label,
					                      swatch: true,
					                      swatchValue: c.value,
					                      onClick: () => {
					                        restoreFocus();
					                        editor.commands.setNodeBackground(c.value);
					                      },
					                    })),
					                },
					              ],
					            },
					            {
					              label: 'Alignment',
					              submenu: () => [
					                ...TABLE_ALIGN_TEXT.map((a) => ({
					                  label: a.label,
					                  onClick: () => {
					                    restoreFocus();
					                    editor.commands.setNodeTextAlign(a.value);
					                  },
					                })),
					                { type: 'separator' },
					                ...TABLE_ALIGN_VERTICAL.map((a) => ({
					                  label: a.label,
					                  onClick: () => {
					                    restoreFocus();
					                    editor.commands.setNodeVAlign(a.value);
					                  },
					                })),
					              ],
					            },
					            { type: 'separator' },
					            {
					              label: 'Clear contents',
					              onClick: () => {
					                restoreFocus();
					                editor.commands.clearNodeContents();
					              },
					            },
					          ];
					          this.menu.openPanel({ anchorRect, items, level: 0 });
					        }

					        openRowMenu(anchorRect, rowIndex, tablePos) {
					          const restoreFocusAndRowSelection = () => {
					            try {
					              editor?.chain?.().focus?.().run?.();
					            } catch {
					              // ignore
					            }
					            if (Number.isFinite(Number(tablePos))) {
					              selectOutlineTableRowAt(editor, tablePos, rowIndex);
					            }
					          };
					          const runRowCellAttr = (attr, value) => {
					            try {
					              editor?.chain?.().focus?.().run?.();
					            } catch {
					              // ignore
					            }
					            return editor.commands.command(({ state: pmState, dispatch }) => {
					              const tp = Number.isFinite(Number(tablePos))
					                ? Number(tablePos)
					                : getActiveTableContext(pmState)?.tablePos;
					              const r =
					                Number.isFinite(Number(rowIndex)) ? Number(rowIndex) : getActiveTableContext(pmState)?.rowIndex;
					              if (!Number.isFinite(Number(tp)) || !Number.isFinite(Number(r))) return false;
					              return applyAttrToTableRowAt({ pmState, dispatch }, { tablePos: tp, rowIndex: r, attr, value });
					            });
					          };
					          const withRowSelection = (fn) => () => {
					            restoreFocusAndRowSelection();
					            return fn?.();
					          };
					          const runTableCmd = (cmd) => {
					            try {
					              if (typeof cmd !== 'function') return false;
					              restoreFocusAndRowSelection();
					              return editor.commands.command(({ state, dispatch }) => {
					                const wrappedDispatch =
					                  typeof dispatch === 'function'
				                    ? (tr) => {
				                        try {
				                          tr = tr.setMeta(OUTLINE_ALLOW_META, true);
				                        } catch {
				                          // ignore
				                        }
				                        dispatch(tr);
				                      }
				                    : undefined;
				                return cmd(state, wrappedDispatch);
				              });
				            } catch {
					              return false;
					            }
					          };
					          const items = [
					            {
					              label: 'Color',
					              submenu: () => [
					                {
					                  label: 'text',
					                  submenu: () =>
					                    TABLE_TEXT_COLORS.map((c) => ({
					                      label: c.label,
					                      swatch: true,
					                      swatchValue: c.value,
					                      onClick: () => runRowCellAttr('nodeTextColor', c.value),
					                    })),
					                },
					                {
					                  label: 'Background color',
					                  submenu: () =>
					                    TABLE_BG_COLORS.map((c) => ({
					                      label: c.label,
					                      swatch: true,
					                      swatchValue: c.value,
					                      onClick: () => runRowCellAttr('nodeBackground', c.value),
					                    })),
					                },
					              ],
					            },
					            {
					              label: 'Alignment',
					              submenu: () => [
					                ...TABLE_ALIGN_TEXT.map((a) => ({
					                  label: a.label,
					                  onClick: () => runRowCellAttr('nodeTextAlign', a.value),
					                })),
					                { type: 'separator' },
					                ...TABLE_ALIGN_VERTICAL.map((a) => ({
					                  label: a.label,
					                  onClick: () => runRowCellAttr('nodeVerticalAlign', a.value),
					                })),
					              ],
					            },
					            { type: 'separator' },
					            { label: 'Insert row above', onClick: () => runTableCmd(outlineTableApi?.addRowBefore) },
					            { label: 'Insert row below', onClick: () => runTableCmd(outlineTableApi?.addRowAfter) },
					            {
					              label: 'Sort ',
					              submenu: () => [
					                {
					                  label: 'Sort column A-Z',
					                  onClick: withRowSelection(() =>
					                    sortOutlineTableColumnsByRow(editor, { direction: 'asc' }),
					                  ),
					                },
					                {
					                  label: 'Sort column Z-A',
					                  onClick: withRowSelection(() =>
					                    sortOutlineTableColumnsByRow(editor, { direction: 'desc' }),
					                  ),
					                },
					              ],
					            },
					            { label: 'Header row', onClick: () => runTableCmd(outlineTableApi?.toggleHeaderRow) },
					            {
					              label: 'Move ',
					              submenu: () => [
					                { label: 'Move row up', onClick: withRowSelection(() => moveTableRowBy(editor, -1)) },
					                { label: 'Move row down', onClick: withRowSelection(() => moveTableRowBy(editor, +1)) },
					                { label: 'Move row left', disabled: true, onClick: () => {} },
					                { label: 'Move row right', disabled: true, onClick: () => {} },
					              ],
					            },
					            { label: 'Duplicate row', onClick: withRowSelection(() => duplicateOutlineTableRow(editor)) },
					            { label: 'Delete row', onClick: () => runTableCmd(outlineTableApi?.deleteRow) },
					            { type: 'separator' },
					            {
					              label: 'Clear row contents',
					              onClick: () => {
					                restoreFocusAndRowSelection();
					                editor.commands.clearNodeContents();
					              },
					            },
					          ];
					          this.menu.openPanel({ anchorRect, items, level: 0 });
					        }

					        openColumnMenu(anchorRect, colIndex, tablePos) {
					          const restoreFocusAndColSelection = () => {
					            try {
					              editor?.chain?.().focus?.().run?.();
					            } catch {
					              // ignore
					            }
					            if (Number.isFinite(Number(tablePos))) {
					              selectOutlineTableColumnAt(editor, tablePos, colIndex);
					            }
					          };
					          const runColCellAttr = (attr, value) => {
					            try {
					              editor?.chain?.().focus?.().run?.();
					            } catch {
					              // ignore
					            }
					            return editor.commands.command(({ state: pmState, dispatch }) => {
					              const tp = Number.isFinite(Number(tablePos))
					                ? Number(tablePos)
					                : getActiveTableContext(pmState)?.tablePos;
					              const col =
					                Number.isFinite(Number(colIndex)) ? Number(colIndex) : getActiveTableContext(pmState)?.colIndex;
					              if (!Number.isFinite(Number(tp)) || !Number.isFinite(Number(col))) return false;
					              return applyAttrToTableColumnAt(
					                { pmState, dispatch },
					                { tablePos: tp, colIndex: col, attr, value },
					              );
					            });
					          };
					          const withColSelection = (fn) => () => {
					            restoreFocusAndColSelection();
					            return fn?.();
					          };
					          const runTableCmd = (cmd) => {
					            try {
					              if (typeof cmd !== 'function') return false;
					              restoreFocusAndColSelection();
					              return editor.commands.command(({ state, dispatch }) => {
					                const wrappedDispatch =
					                  typeof dispatch === 'function'
				                    ? (tr) => {
				                        try {
				                          tr = tr.setMeta(OUTLINE_ALLOW_META, true);
				                        } catch {
				                          // ignore
				                        }
				                        dispatch(tr);
				                      }
				                    : undefined;
				                return cmd(state, wrappedDispatch);
				              });
				            } catch {
					              return false;
					            }
					          };
					          const items = [
					            {
					              label: 'Color',
					              submenu: () => [
					                {
					                  label: 'text',
					                  submenu: () =>
					                    TABLE_TEXT_COLORS.map((c) => ({
					                      label: c.label,
					                      swatch: true,
					                      swatchValue: c.value,
					                      onClick: () => runColCellAttr('nodeTextColor', c.value),
					                    })),
					                },
					                {
					                  label: 'Background color',
					                  submenu: () =>
					                    TABLE_BG_COLORS.map((c) => ({
					                      label: c.label,
					                      swatch: true,
					                      swatchValue: c.value,
					                      onClick: () => runColCellAttr('nodeBackground', c.value),
					                    })),
					                },
					              ],
					            },
					            {
					              label: 'Alignment',
					              submenu: () => [
					                ...TABLE_ALIGN_TEXT.map((a) => ({
					                  label: a.label,
					                  onClick: () => runColCellAttr('nodeTextAlign', a.value),
					                })),
					                { type: 'separator' },
					                ...TABLE_ALIGN_VERTICAL.map((a) => ({
					                  label: a.label,
					                  onClick: () => runColCellAttr('nodeVerticalAlign', a.value),
					                })),
					              ],
					            },
					            { type: 'separator' },
					            {
					              label: 'Insert column left',
					              onClick: () => {
					                restoreFocusAndColSelection();
					                const insertIndex = Math.max(0, Number(colIndex || 0));
					                const ok = runTableCmd(outlineTableApi?.addColumnBefore);
					                if (ok) {
					                  window.requestAnimationFrame(() => {
				                    try {
				                      rebalanceTableColumnPercentsAfterInsert(editor, { insertIndex, newColPct: 10 });
				                    } catch {
				                      const tableEl = getActiveTableDom(editor.view);
				                      captureTableColumnPercentsFromDom(tableEl);
				                    }
				                  });
				                }
				              },
				            },
				            {
					              label: 'Insert column right',
					              onClick: () => {
					                restoreFocusAndColSelection();
					                const insertIndex = Math.max(0, Number(colIndex || 0) + 1);
					                const ok = runTableCmd(outlineTableApi?.addColumnAfter);
					                if (ok) {
					                  window.requestAnimationFrame(() => {
				                    try {
				                      rebalanceTableColumnPercentsAfterInsert(editor, { insertIndex, newColPct: 10 });
				                    } catch {
				                      const tableEl = getActiveTableDom(editor.view);
				                      captureTableColumnPercentsFromDom(tableEl);
				                    }
				                  });
				                }
				              },
				            },
					            {
					              label: 'Sort ',
					              submenu: () => [
					                {
					                  label: 'Sort row A-Z',
					                  onClick: withColSelection(() =>
					                    sortOutlineTableRowsByColumn(editor, { direction: 'asc' }),
					                  ),
					                },
					                {
					                  label: 'Sort row Z-A',
					                  onClick: withColSelection(() =>
					                    sortOutlineTableRowsByColumn(editor, { direction: 'desc' }),
					                  ),
					                },
					              ],
					            },
					            { label: 'Header column', onClick: () => runTableCmd(outlineTableApi?.toggleHeaderColumn) },
					            {
					              label: 'Move ',
					              submenu: () => [
					                { label: 'Move column up', disabled: true, onClick: () => {} },
					                { label: 'Move column down', disabled: true, onClick: () => {} },
					                { label: 'Move column left', onClick: withColSelection(() => moveTableColumnBy(editor, -1)) },
					                { label: 'Move column right', onClick: withColSelection(() => moveTableColumnBy(editor, +1)) },
					              ],
					            },
					            { label: 'Duplicate column', onClick: withColSelection(() => duplicateOutlineTableColumn(editor)) },
					            {
					              label: 'Delete column',
					              onClick: () => {
					                restoreFocusAndColSelection();
					                const tableElBefore = getActiveTableDom(editor.view);
					                const widthsBefore = readTableColPercentsFromDom(tableElBefore);
					                const deletedIndex = Number.isFinite(Number(colIndex)) ? Number(colIndex) : null;
					                const widthsAfter =
					                  widthsBefore && deletedIndex != null
					                    ? rebalanceTableColumnPercentsAfterDeleteFromSnapshot(widthsBefore, deletedIndex)
				                    : null;
				                const ok = runTableCmd(outlineTableApi?.deleteColumn);
				                if (ok && Array.isArray(widthsAfter)) {
				                  window.requestAnimationFrame(() => {
				                    const tableEl = getActiveTableDom(editor.view);
				                    applyTableColPercentsToDom(tableEl, widthsAfter);
				                  });
					                }
					              },
					            },
					            { type: 'separator' },
					            {
					              label: 'Clear column contents',
					              onClick: () => {
					                restoreFocusAndColSelection();
					                editor.commands.clearNodeContents();
					              },
					            },
					          ];
					          this.menu.openPanel({ anchorRect, items, level: 0 });
					        }
				      }

				      return [
				        new Plugin({
				          view(view) {
				            const ui = new TableUiView(view);
				            ui.update(view);
				            return {
				              update(nextView) {
				                ui.update(nextView);
				              },
				              destroy() {
				                ui.destroy();
				              },
				            };
				          },
				        }),
				      ];
				    },
				  });

				  // Plugin/extension order matters: paste handlers should run before generic keymaps where possible.
				  const createStart = perfEnabled() ? performance.now() : 0;
		  outlineEditorInstance = new Editor({
			    element: contentRoot,
					    extensions: [
		      OutlineDocument,
		      OutlineSection,
		      OutlineHeading,
		      OutlineBody,
		      OutlineChildren,
	        OutlineTag,
	        OutlineTagHighlighter,
			      OutlineActiveSection,
			      OutlineEditMode,
			      OutlineImageUpload,
			      OutlineAttachmentUpload,
			      OutlineImageResize,
		      OutlineImagePreview,
			      OutlineStructuredSectionPaste,
			      OutlineMarkdownTablePaste,
			      OutlineFormattedPaste,
			      UniqueID.configure({
			        types: ['outlineSection'],
			        attributeName: 'id',
			        generateID: () => safeUuid(),
		      }),
      StarterKit.configure({
        document: false,
        heading: false,
        link: false,
      }),
		      Link.configure({
		        openOnClick: false,
		        protocols: OUTLINE_ALLOWED_LINK_PROTOCOLS,
		      }),
		      markdownExtension,
		      ResizableImage,
			      OutlineCommands,
			      OutlineTableCellStyling,
			      TableKit.configure({ table: { resizable: true } }),
			      OutlineTableNodeUi,
			      OutlineTableSmartMouseSelection,
			      OutlineTableResizeCapture,
			      OutlineTablePercentWidths,
			      OutlineMarkdown,
		    ].filter(Boolean),
	    content,
		    editorProps: {
	      attributes: {
	        class: 'outline-prosemirror',
	      },
		      handleKeyDown(view, event) {
		          outlineDebug('editorProps.keydown', {
			            key: event?.key || null,
		            repeat: Boolean(event?.repeat),
		            selection: {
	              empty: Boolean(view.state?.selection?.empty),
	              parent: view.state?.selection?.$from?.parent?.type?.name || null,
	              parentOffset: view.state?.selection?.$from?.parentOffset ?? null,
	              pos: view.state?.selection?.$from?.pos ?? null,
	            },
	          });
			        // Ctrl/Cmd+Enter in view-mode: create a new block above/below and enter edit mode in its body.
			        try {
			          const TextSelection = tiptap?.pmStateMod?.TextSelection;
			          if (TextSelection) {
			            const st = outlineEditModeKey?.getState?.(view.state) || null;
			            const editingSectionId = st?.editingSectionId || null;
			            const isCtrlEnter =
			              (event.key === 'Enter' || event.code === 'Enter' || event.code === 'NumpadEnter') &&
			              (event.ctrlKey || event.metaKey) &&
			              !event.shiftKey &&
			              !event.altKey;
			            if (!state.isPublicView && !editingSectionId && isCtrlEnter) {
			              const sel = view.state.selection;
			              const $from = sel?.$from || null;
			              if ($from) {
			                const sectionPos = findOutlineSectionPosAtSelection(view.state.doc, $from);
			                const sectionNode = typeof sectionPos === 'number' ? view.state.doc.nodeAt(sectionPos) : null;
			                if (typeof sectionPos === 'number' && sectionNode?.type?.name === 'outlineSection') {
			                  const isCaret = Boolean(sel && sel.empty);
			                  const inHeading = $from.parent?.type?.name === 'outlineHeading';
			                  const atHeadingStart = isCaret && inHeading && $from.parentOffset === 0;
			                  const insertPos = atHeadingStart ? sectionPos : sectionPos + sectionNode.nodeSize;
			                  const schema = view.state.schema;
			                  const newId = safeUuid();
			                  const newSection = schema.nodes.outlineSection.create(
			                    { id: newId, collapsed: false },
			                    [
			                      schema.nodes.outlineHeading.create({}, []),
			                      schema.nodes.outlineBody.create({}, [schema.nodes.paragraph.create({}, [])]),
			                      schema.nodes.outlineChildren.create({}, []),
			                    ],
			                  );
			                  let tr = view.state.tr.insert(insertPos, newSection);
			                  try {
			                    const inserted = tr.doc.nodeAt(insertPos);
			                    const heading = inserted?.child?.(0) || newSection.child(0);
			                    const bodyStart = insertPos + 1 + heading.nodeSize;
			                    tr = tr.setSelection(TextSelection.near(tr.doc.resolve(bodyStart + 2), 1));
			                  } catch {
			                    tr = tr.setSelection(TextSelection.create(tr.doc, insertPos + 2));
			                  }
			                  tr = tr.setMeta(OUTLINE_ALLOW_META, true);
			                  if (outlineEditModeKey) tr = tr.setMeta(outlineEditModeKey, { type: 'enter', sectionId: newId });
			                  view.dispatch(tr.scrollIntoView());
			                  try {
			                    view.focus();
			                  } catch {
			                    // ignore
			                  }
			                  event.preventDefault();
			                  event.stopPropagation();
			                  return true;
			                }
			              }
			            }
			          }
			        } catch {
			          // ignore
			        }
				        // Alt+Arrow: our custom table moves are disabled; keep TipTap defaults in tables.
				        try {
				          const isAltOnly = event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
				          const key = String(event.key || '');
			          if (isAltOnly && (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown')) {
			            const st = outlineEditModeKey?.getState?.(view.state) || null;
			            if (st?.editingSectionId && outlineEditorInstance) {
		              const isSelectionInsideTable = () => {
		                try {
		                  const $from = view?.state?.selection?.$from || null;
		                  if (!$from) return false;
		                  for (let d = $from.depth; d > 0; d -= 1) {
		                    const name = $from.node(d)?.type?.name;
		                    if (
		                      name === 'table' ||
		                      name === 'tableRow' ||
		                      name === 'tableCell' ||
		                      name === 'tableHeader'
		                    ) {
		                      return true;
		                    }
		                  }
		                  return false;
		                } catch {
		                  return false;
		                }
				              };

				              // Alt+Arrows: list indent/outdent + "move paragraph up/down" in outline body and in table cells.
				              if (key === 'ArrowLeft' || key === 'ArrowRight') {
				                const chain = outlineEditorInstance.chain().focus();
			                chain.command(({ tr }) => {
			                  tr.setMeta(OUTLINE_ALLOW_META, true);
		                  return true;
		                });
		                let handled = false;
		                if (outlineEditorInstance.isActive('bulletList') || outlineEditorInstance.isActive('orderedList')) {
		                  if (key === 'ArrowRight') handled = chain.sinkListItem('listItem').run();
		                  else {
		                    handled = chain.liftListItem('listItem').run();
		                    if (!handled && outlineEditorInstance.isActive('bulletList')) handled = chain.toggleBulletList().run();
		                    if (!handled && outlineEditorInstance.isActive('orderedList')) handled = chain.toggleOrderedList().run();
		                  }
		                } else {
		                  // Create a bullet list (first step), then allow further indent with Alt+Right.
		                  if (key === 'ArrowRight') handled = chain.toggleBulletList().run();
		                }
		                if (handled) {
		                  event.preventDefault();
		                  event.stopPropagation();
				                  return true;
				                }
				              } else if (key === 'ArrowUp' || key === 'ArrowDown') {
				                const handled =
				                  key === 'ArrowUp'
				                    ? moveOutlineListItemBy(outlineEditorInstance, -1) || moveOutlineTextParagraphBy(outlineEditorInstance, -1)
				                    : moveOutlineListItemBy(outlineEditorInstance, +1) || moveOutlineTextParagraphBy(outlineEditorInstance, +1);
				                if (handled) {
				                  event.preventDefault();
				                  event.stopPropagation();
				                  return true;
				                }
		              }
		            }
		          }
		        } catch {
		          // ignore
		        }
		        // Ctrl/⌘+A внутри блока должен выделять весь блок (заголовок+тело).
		        // Повторное Ctrl/⌘+A на заголовке — выделяет всю статью (дефолтное поведение).
		        try {
		          // IMPORTANT: `event.key` depends on keyboard layout (e.g. RU layout -> 'ф'),
		          // so detect Mod+A primarily via `event.code === 'KeyA'`.
		          const isModA =
		            (event.ctrlKey || event.metaKey) &&
		            !event.altKey &&
		            !event.shiftKey &&
		            (event.code === 'KeyA' || String(event.key || '').toLowerCase() === 'a');
		          if (isModA) {
		            const TextSelection = tiptap?.pmStateMod?.TextSelection;
		            if (!TextSelection) {
		              outlineDebug('editorProps.modA', { handled: false, reason: 'no-TextSelection' });
		              return false;
		            }
		            const pmState = view.state;
		            const sel = pmState.selection;
		            const $from = sel?.$from || null;
		            if (!$from) {
		              outlineDebug('editorProps.modA', { handled: false, reason: 'no-$from' });
		              return false;
		            }

		            const sectionPos = findOutlineSectionPosAtSelection(pmState.doc, $from);
		            if (typeof sectionPos !== 'number') {
		              outlineDebug('editorProps.modA', { handled: false, reason: 'no-sectionPos' });
		              return false;
		            }
		            const sectionNode = pmState.doc.nodeAt(sectionPos);
		            if (!sectionNode || sectionNode.type?.name !== 'outlineSection') {
		              outlineDebug('editorProps.modA', { handled: false, reason: 'not-outlineSection' });
		              return false;
		            }

		            const headingNode = sectionNode.child(0);
		            const bodyNode = sectionNode.child(1);
		            if (!headingNode || !bodyNode) {
		              outlineDebug('editorProps.modA', { handled: false, reason: 'missing-heading/body' });
		              return false;
		            }

		            const headingPos = sectionPos + 1;
		            const headingFrom = headingPos + 1;
		            const headingTo = headingPos + headingNode.nodeSize - 1;
		            const bodyStart = sectionPos + 1 + headingNode.nodeSize;
		            const bodyFrom = bodyStart + 1;
		            const bodyTo = bodyStart + bodyNode.nodeSize - 1;

		            // Find a safe "to" position inside the last textblock in body.
		            let blockTo = bodyTo;
		            try {
		              let last = null;
		              pmState.doc.nodesBetween(bodyFrom, Math.min(pmState.doc.content.size, bodyTo), (node, pos) => {
		                if (node?.isTextblock) last = pos + node.nodeSize - 1;
		              });
		              if (typeof last === 'number') blockTo = last;
		            } catch {
		              // ignore
		            }
		            if (blockTo < bodyFrom) {
		              // No textblocks in body; fall back to end of heading.
		              blockTo = headingTo;
		            }

		            const blockFrom = headingFrom;
		            const isInHeading = (() => {
		              try {
		                for (let d = $from.depth; d > 0; d -= 1) {
		                  if ($from.node(d)?.type?.name === 'outlineHeading') return true;
		                }
		              } catch {
		                // ignore
		              }
		              return false;
		            })();

		            const alreadySelectedBlock =
		              Boolean(sel) &&
		              typeof sel.from === 'number' &&
		              typeof sel.to === 'number' &&
		              Math.min(sel.from, sel.to) === blockFrom &&
		              Math.max(sel.from, sel.to) === blockTo;

		            if (isInHeading && alreadySelectedBlock) {
		              // Let default Mod+A select the whole document.
		              outlineDebug('editorProps.modA', { handled: false, reason: 'pass-through-doc-select' });
		              return false;
		            }

		            event.preventDefault();
		            event.stopPropagation();
		            const nextSel = TextSelection.create(pmState.doc, blockFrom, blockTo);
		            view.dispatch(pmState.tr.setSelection(nextSel));
		            outlineDebug('editorProps.modA', { handled: true, blockFrom, blockTo, isInHeading, alreadySelectedBlock });
		            return true;
		          }
		        } catch {
		          // ignore
		        }

	        // В view-mode Enter/F2 должны ВСЕГДА включать режим редактирования текущей секции,
	        // даже когда курсор стоит внутри listItem (иначе list keymap "съедает" Enter).
	        try {
	          if (!outlineEditModeKey) return false;
	          const st = outlineEditModeKey.getState(view.state) || {};
          const editingSectionId = st.editingSectionId || null;

	          if (!editingSectionId) {
	            const isModDelete =
	              (event.ctrlKey || event.metaKey) &&
	              !event.altKey &&
	              !event.shiftKey &&
	              (event.key === 'Delete' || event.key === 'Del' || event.key === 'Backspace');
	            const isDelete = event.key === 'Backspace' || event.key === 'Delete';
	            const isTextInput = event.key && event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey;
	            const isSpace =
	              !event.metaKey &&
	              !event.ctrlKey &&
	              !event.altKey &&
	              !event.shiftKey &&
	              (event.key === ' ' || event.key === 'Spacebar');

	            if (isModDelete) {
	              // View-mode: Ctrl/Cmd+Delete deletes the current section (same as outlineDeleteBtn).
	              const sectionPos = findOutlineSectionPosAtSelection(view.state.doc, view.state.selection.$from);
	              let ok = false;
	              try {
	                if (typeof sectionPos === 'number') ok = outlineDeleteCurrentSectionForView(view.state, view.dispatch, sectionPos);
	              } catch {
	                ok = false;
	              }
	              outlineDebug('editorProps.modDelete', { ok, sectionPos });
	              event.preventDefault();
	              event.stopPropagation();
	              return true;
	            }

	            if (isSpace) {
	              // View-mode: Space toggles collapsed state of the current section.
	              // Do not allow Space to scroll the page; do not show read-only toast.
	              const active = document.activeElement;
              const inOutline =
                Boolean(active && active.closest && active.closest('.outline-editor')) ||
                Boolean(event?.target && event.target.closest && event.target.closest('.outline-editor'));

              if (!inOutline) return false;
              if (event.repeat) {
                event.preventDefault();
                event.stopPropagation();
                return true;
              }
              // Don't hijack Space on interactive controls (a11y: Space "clicks" buttons).
              const target = event?.target || null;
              const tag = String(target?.tagName || '').toLowerCase();
              if (tag === 'button' || tag === 'input' || tag === 'textarea' || tag === 'select') return false;
              if (target?.closest?.('button, a[href], input, textarea, select')) return false;
              // ProseMirror root is contenteditable even in view-mode; allow Space there.
              const isOutlineProseMirror = Boolean(target?.closest?.('.outline-prosemirror'));
              if (!isOutlineProseMirror && target?.closest?.('[contenteditable="true"]')) return false;

              const sectionPos = findOutlineSectionPosAtSelection(view.state.doc, view.state.selection.$from);
              if (typeof sectionPos !== 'number') {
                event.preventDefault();
                event.stopPropagation();
                return true;
              }
              const sectionNode = view.state.doc.nodeAt(sectionPos);
              if (!sectionNode) {
                event.preventDefault();
                event.stopPropagation();
                return true;
              }
              const next = !Boolean(sectionNode.attrs?.collapsed);
              let tr = view.state.tr.setNodeMarkup(sectionPos, undefined, { ...sectionNode.attrs, collapsed: next });
              tr = tr.setMeta(OUTLINE_ALLOW_META, true);

              // Put selection into heading so it doesn't end up inside hidden body after collapse.
              try {
                const heading = sectionNode.child(0);
                const headingStart = sectionPos + 1;
                const headingEnd = headingStart + heading.nodeSize - 1;
                const { TextSelection } = tiptap?.pmStateMod || {};
                if (TextSelection) tr = tr.setSelection(TextSelection.near(tr.doc.resolve(headingEnd), -1));
              } catch {
                // ignore
              }

              event.preventDefault();
              event.stopPropagation();
              view.dispatch(tr.scrollIntoView());
              return true;
            }
            if (isDelete) {
              // View-mode: allow merge with Backspace at the very start of a section heading.
              if (event.key === 'Backspace') {
                try {
                  const pmState = view.state;
                  const sel = pmState.selection;
                  const $from = sel?.$from || null;
                  let headingDepth = null;
                  try {
                    for (let d = $from?.depth || 0; d > 0; d -= 1) {
                      if ($from.node(d)?.type?.name === 'outlineHeading') {
                        headingDepth = d;
                        break;
                      }
                    }
                  } catch {
                    headingDepth = null;
                  }
                  const headingStart =
                    headingDepth !== null && $from ? $from.start(headingDepth) : null;
                  const atHeadingStart =
                    Boolean(sel && sel.empty) &&
                    Boolean($from) &&
                    headingDepth !== null &&
                    typeof headingStart === 'number' &&
                    $from.pos === headingStart;
                  outlineDebug('editorProps.backspace.check', {
                    empty: Boolean(sel?.empty),
                    headingDepth,
                    headingStart,
                    pos: $from?.pos ?? null,
                    parent: $from?.parent?.type?.name || null,
                    parentOffset: $from?.parentOffset ?? null,
                    atHeadingStart,
                  });
                  if (atHeadingStart) {
                    const sectionPos = findOutlineSectionPosAtSelection(pmState.doc, $from);
                    const sectionNode = typeof sectionPos === 'number' ? pmState.doc.nodeAt(sectionPos) : null;
                    outlineDebug('editorProps.backspace.sectionPos', { sectionPos, hasNode: Boolean(sectionNode) });
                    if (typeof sectionPos === 'number' && sectionNode) {
                      const currentSectionId = String(sectionNode.attrs?.id || '');

                      // Determine merge target id in advance (prev sibling, or parent section if no prev).
                      let targetSectionId = null;
                      try {
                        const $pos = pmState.doc.resolve(sectionPos);
                        const idx = $pos.index();
                        const parent = $pos.parent;
                        if (parent && idx > 0) {
                          const prevNode = parent.child(idx - 1);
                          const prevStart = sectionPos - prevNode.nodeSize;
                          const prevSection = pmState.doc.nodeAt(prevStart);
                          targetSectionId = String(prevSection?.attrs?.id || '') || null;
                        } else {
                          for (let d = $from.depth - 1; d > 0; d -= 1) {
                            const n = $from.node(d);
                            if (n?.type?.name === 'outlineSection') {
                              const pid = String(n.attrs?.id || '');
                              if (pid && pid !== currentSectionId) {
                                targetSectionId = pid;
                                break;
                              }
                            }
                          }
                        }
                      } catch {
                        targetSectionId = null;
                      }

                      outlineDebug('editorProps.backspace.mergeCandidate', {
                        sectionPos,
                        currentSectionId,
                        targetSectionId,
                      });

                      // Execute merge/delete.
                      let ok = false;
                    if (outlineIsSectionEmptyForView(sectionNode)) {
                      ok = outlineDeleteCurrentSectionForView(pmState, view.dispatch, sectionPos);
                    } else {
                      try {
                        const $pos = pmState.doc.resolve(sectionPos);
                        const idx = $pos.index();
                        if (idx <= 0) ok = outlineMergeSectionIntoParentBodyForView(pmState, view.dispatch, sectionPos);
                        else ok = outlineMergeSectionIntoPreviousForView(pmState, view.dispatch, sectionPos);
                      } catch {
                        ok = outlineMergeSectionIntoPreviousForView(pmState, view.dispatch, sectionPos);
                      }
                    }

                      outlineDebug('editorProps.backspace.mergeDone', { ok, targetSectionId });

                      if (ok && targetSectionId && outlineEditModeKey) {
                        window.setTimeout(() => {
                          try {
                            const stNow = outlineEditModeKey.getState(view.state) || {};
                            if (stNow.editingSectionId) return;
                            const currentPos = findSectionPosById(view.state.doc, targetSectionId);
                            const currentNode = typeof currentPos === 'number' ? view.state.doc.nodeAt(currentPos) : null;
                            if (!currentNode) return;

                            let tr = view.state.tr;
                            if (Boolean(currentNode?.attrs?.collapsed)) {
                              tr = tr.setNodeMarkup(currentPos, undefined, { ...currentNode.attrs, collapsed: false });
                              tr = tr.setMeta(OUTLINE_ALLOW_META, true);
                            }

                            tr = tr.setMeta(outlineEditModeKey, { type: 'enter', sectionId: targetSectionId });

	                          try {
	                            const nodeAfter = tr.doc.nodeAt(currentPos);
	                            if (nodeAfter && nodeAfter.type?.name === 'outlineSection') {
	                              const heading = nodeAfter.child(0);
	                              const body = nodeAfter.child(1);
	                              const bodyStart = currentPos + 1 + heading.nodeSize;
	                              const bodyEnd = bodyStart + body.nodeSize - 1;
	                              tr = tr.setSelection(TextSelection.near(tr.doc.resolve(bodyEnd), -1));
	                            }
	                          } catch {
	                            // ignore
	                          }

                            view.dispatch(tr.scrollIntoView());
                            try {
                              view.focus();
                            } catch {
                              // ignore
                            }
                            outlineDebug('editorProps.backspace.enterEdit.done', { targetSectionId });
                          } catch {
                            // ignore
                          }
                        }, 0);
                      }

                      event.preventDefault();
                      event.stopPropagation();
                      return true;
                    }
                  }
                } catch {
                  // ignore
                }
              }

              event.preventDefault();
              event.stopPropagation();
              return true;
            }
            if (isTextInput) {
              event.preventDefault();
              event.stopPropagation();
              notifyReadOnlyGlobal();
              return true;
            }
          }

		          if (
		            state.isPublicView &&
		            !editingSectionId &&
		            ((event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) ||
		              (event.key === 'F2' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey))
		          ) {
		            event.preventDefault();
		            event.stopPropagation();
		            return true;
		          }

		          if (
		            !editingSectionId &&
		            ((event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) ||
		              (event.key === 'F2' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey))
		          ) {
		            const sectionPos = findOutlineSectionPosAtSelection(view.state.doc, view.state.selection.$from);
		            if (typeof sectionPos !== 'number') return false;
		            const sectionNode = view.state.doc.nodeAt(sectionPos);
	            const sectionId = String(sectionNode?.attrs?.id || '');
	            if (!sectionId) return false;
            event.preventDefault();
            event.stopPropagation();
            // Collapsed sections must not enter edit mode; expand instead.
            if (Boolean(sectionNode?.attrs?.collapsed)) {
              const tr = view.state.tr.setNodeMarkup(sectionPos, undefined, { ...sectionNode.attrs, collapsed: false });
              tr.setMeta(OUTLINE_ALLOW_META, true);
              view.dispatch(tr.scrollIntoView());
              return true;
            }
            view.dispatch(view.state.tr.setMeta(outlineEditModeKey, { type: 'enter', sectionId }));
            return true;
          }

		          if (editingSectionId && event.key === 'Escape') {
		            event.preventDefault();
		            event.stopPropagation();
		            const sectionId = editingSectionId;
		            view.dispatch(view.state.tr.setMeta(outlineEditModeKey, { type: 'exit' }));
		            // Выход из режима редактирования тоже считаем "уходом" из секции
		            // для proofreading (заголовок генерируем только после сохранения).
		            try {
		              const tiptapEditor = outlineEditorInstance;
		              if (tiptapEditor && !tiptapEditor.isDestroyed) {
		                const changed = markSectionDirtyIfChanged(view.state.doc, sectionId);
		                // Proofread is versioned by hash; calling it here keeps spellcheck working
		                // even if autosave already committed the section before the user pressed Esc.
		                maybeProofreadOnLeave(tiptapEditor, view.state.doc, sectionId);
	                if (changed) scheduleAutosave({ delayMs: 350 });
	              }
	            } catch {
	              // ignore
	            }
	            return true;
	          }
        } catch {
          // ignore
        }
        return false;
      },
      handleDOMEvents: {
	        click(view, event) {
	          try {
	            const anchor = event.target?.closest?.('a[href]');
	            if (!anchor) return false;
	            if (!outlineEditModeKey) return false;
	            const st = outlineEditModeKey.getState(view.state) || {};
	            const editingSectionId = st.editingSectionId || null;
	            if (editingSectionId) return false;

		            const href = String(anchor.getAttribute('href') || '').trim();
		            if (!href) return false;

		            if (state.isPublicView) {
		              const relRaw = String(anchor.getAttribute('rel') || '');
		              const relParts = relRaw.split(/\s+/).filter(Boolean);
		              const isUnpublished =
		                anchor.getAttribute('data-unpublished') === '1' ||
		                relParts.includes('unpublished') ||
		                href === '#';
		              if (isUnpublished) {
		                alert('Эта страница пока не опубликована');
		                event.preventDefault();
		                event.stopPropagation();
		                return true;
		              }
		            }

	            if (href.startsWith('app:/') || href.startsWith('disk:/')) {
	              event.preventDefault();
	              event.stopPropagation();
	              const resolved = resolveYandexDiskHref(href);
	              if (resolved) {
	                window.open(resolved, '_blank', 'noopener,noreferrer');
	                return true;
	              }
	            }

	            const looksLikeBareDomain = (value) => {
	              const s = String(value || '').trim();
	              if (!s) return false;
	              if (s.startsWith('/') || s.startsWith('#')) return false;
	              if (/\s/.test(s)) return false;
	              if (s.includes('://')) return false;
	              // Exclude custom schemes like app:/, disk:/, mailto:, tel:
	              if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return false;
	              // Must contain a dot in the hostname part.
	              const host = s.split(/[/?#]/, 1)[0];
	              if (!host || !host.includes('.')) return false;
	              // Avoid cases like ".com" or "a..b"
	              if (host.startsWith('.') || host.endsWith('.') || host.includes('..')) return false;
	              return true;
	            };

            const normalizeExternalHref = (value) => {
              const s = String(value || '').trim();
              if (!s) return s;
              // protocol-relative URL
              if (s.startsWith('//')) return `https:${s}`;
              if (looksLikeBareDomain(s)) return `https://${s}`;
              return s;
            };

            // В view-mode клики по ссылкам должны открывать их.
            event.preventDefault();
            event.stopPropagation();

	            if (href.startsWith('/')) {
	              // Internal routes.
	              if (state.isPublicView) {
	                window.location.href = href;
	                return true;
	              }
	              // SPA navigation for internal routes.
	              navigate(href);
	              return true;
	            }
            const normalized = normalizeExternalHref(href);
            if (/^https?:\/\//i.test(normalized) || /^mailto:/i.test(normalized) || /^tel:/i.test(normalized)) {
              window.open(normalized, '_blank', 'noopener,noreferrer');
              return true;
            }
            // Fallback: allow whatever user stored (may be relative).
            window.open(normalized, '_blank', 'noopener,noreferrer');
            return true;
          } catch {
            return false;
          }
        },
        beforeinput(view, event) {
          try {
            if (!outlineEditModeKey) return false;
            const st = outlineEditModeKey.getState(view.state) || {};
            const editingSectionId = st.editingSectionId || null;
            if (editingSectionId) return false;
            const inputType = String(event?.inputType || '');
            if (inputType.startsWith('history')) return false;
            outlineDebug('beforeinput', {
              inputType,
              key: event?.data ?? null,
              editingSectionId: editingSectionId || null,
              selection: {
                empty: Boolean(view.state?.selection?.empty),
                parent: view.state?.selection?.$from?.parent?.type?.name || null,
                parentOffset: view.state?.selection?.$from?.parentOffset ?? null,
              },
            });

            // View-mode: allow "merge into previous" by Backspace at the start of heading,
            // even if the browser triggers deletion via beforeinput (common on some platforms).
            if (inputType === 'deleteContentBackward') {
              try {
                const pmState = view.state;
                const sel = pmState.selection;
                const $from = sel?.$from || null;
                let headingDepth = null;
                try {
                  for (let d = $from?.depth || 0; d > 0; d -= 1) {
                    if ($from.node(d)?.type?.name === 'outlineHeading') {
                      headingDepth = d;
                      break;
                    }
                  }
                } catch {
                  headingDepth = null;
                }
                const headingStart =
                  headingDepth !== null && $from ? $from.start(headingDepth) : null;
                const atHeadingStart =
                  Boolean(sel && sel.empty) &&
                  Boolean($from) &&
                  headingDepth !== null &&
                  typeof headingStart === 'number' &&
                  $from.pos === headingStart;
                outlineDebug('beforeinput.deleteContentBackward.check', {
                  empty: Boolean(sel?.empty),
                  headingDepth,
                  headingStart,
                  pos: $from?.pos ?? null,
                  parent: $from?.parent?.type?.name || null,
                  parentOffset: $from?.parentOffset ?? null,
                  atHeadingStart,
                });
                if (atHeadingStart) {
                  const sectionPos = findOutlineSectionPosAtSelection(pmState.doc, $from);
                  const sectionNode = typeof sectionPos === 'number' ? pmState.doc.nodeAt(sectionPos) : null;
                  if (typeof sectionPos === 'number' && sectionNode) {
                    const currentSectionId = String(sectionNode.attrs?.id || '');
                    outlineDebug('beforeinput.deleteContentBackward.candidate', {
                      sectionPos,
                      currentSectionId,
                    });

                    // Determine merge target id in advance (prev sibling, or parent section if no prev).
                    let targetSectionId = null;
                    try {
                      const $pos = pmState.doc.resolve(sectionPos);
                      const idx = $pos.index();
                      const parent = $pos.parent;
                      if (parent && idx > 0) {
                        const prevNode = parent.child(idx - 1);
                        const prevStart = sectionPos - prevNode.nodeSize;
                        const prevSection = pmState.doc.nodeAt(prevStart);
                        targetSectionId = String(prevSection?.attrs?.id || '') || null;
                      } else {
                        for (let d = $from.depth - 1; d > 0; d -= 1) {
                          const n = $from.node(d);
                          if (n?.type?.name === 'outlineSection') {
                            const pid = String(n.attrs?.id || '');
                            if (pid && pid !== currentSectionId) {
                              targetSectionId = pid;
                              break;
                            }
                          }
                        }
                      }
                    } catch {
                      targetSectionId = null;
                    }

                    // Execute merge/delete.
                    let ok = false;
                    if (outlineIsSectionEmptyForView(sectionNode)) {
                      outlineDebug('beforeinput.merge', { kind: 'deleteEmpty', sectionPos });
                      ok = outlineDeleteCurrentSectionForView(pmState, view.dispatch, sectionPos);
                    } else {
                      try {
                        const $pos = pmState.doc.resolve(sectionPos);
                        const idx = $pos.index();
                        if (idx <= 0) {
                          outlineDebug('beforeinput.merge', { kind: 'intoParent', sectionPos, targetSectionId });
                          ok = outlineMergeSectionIntoParentBodyForView(pmState, view.dispatch, sectionPos);
                        } else {
                          outlineDebug('beforeinput.merge', { kind: 'intoPrev', sectionPos, targetSectionId });
                          ok = outlineMergeSectionIntoPreviousForView(pmState, view.dispatch, sectionPos);
                        }
                      } catch {
                        outlineDebug('beforeinput.merge', { kind: 'intoPrev.catch', sectionPos, targetSectionId });
                        ok = outlineMergeSectionIntoPreviousForView(pmState, view.dispatch, sectionPos);
                      }
                    }
                    outlineDebug('beforeinput.merge.done', { ok, targetSectionId });

                    if (ok && targetSectionId) {
                      window.setTimeout(() => {
                        try {
                          const stNow = outlineEditModeKey.getState(view.state) || {};
                          if (stNow.editingSectionId) return;
                          const currentPos = findSectionPosById(view.state.doc, targetSectionId);
                          const currentNode = typeof currentPos === 'number' ? view.state.doc.nodeAt(currentPos) : null;
                          if (!currentNode) return;

                          let tr = view.state.tr;
                          if (Boolean(currentNode?.attrs?.collapsed)) {
                            tr = tr.setNodeMarkup(currentPos, undefined, { ...currentNode.attrs, collapsed: false });
                            tr = tr.setMeta(OUTLINE_ALLOW_META, true);
                          }

                          tr = tr.setMeta(outlineEditModeKey, { type: 'enter', sectionId: targetSectionId });

                          try {
                            const nodeAfter = view.state.doc.nodeAt(currentPos);
                            if (nodeAfter && nodeAfter.type?.name === 'outlineSection') {
                              const heading = nodeAfter.child(0);
                              const bodyStart = currentPos + 1 + heading.nodeSize;
                              const posInBody = Math.min(tr.doc.content.size, bodyStart + 2);
                              tr = tr.setSelection(TextSelection.create(tr.doc, posInBody));
                            }
                          } catch {
                            // ignore
                          }

                          view.dispatch(tr.scrollIntoView());
                          try {
                            view.focus();
                          } catch {
                            // ignore
                          }
                          outlineDebug('beforeinput.enterEdit.done', { targetSectionId });
                        } catch {
                          // ignore
                        }
                      }, 0);
                    }

                    event.preventDefault();
                    event.stopPropagation();
                    return true;
                  }
                }
              } catch {
                // ignore
              }
              // Silent block (no toast) for Backspace in view-mode when we didn't merge.
              outlineDebug('beforeinput.deleteContentBackward.block', { inputType });
              event.preventDefault();
              event.stopPropagation();
              return true;
            }

            // Silent block for any deletes in view-mode (no toast on Backspace/Delete).
            if (inputType.startsWith('delete')) {
              outlineDebug('beforeinput.delete.block', { inputType });
              event.preventDefault();
              event.stopPropagation();
              return true;
            }

            // В view-mode не даём менять документ никакими beforeinput.
            event.preventDefault();
            event.stopPropagation();
            notifyReadOnlyGlobal();
            return true;
          } catch {
            return false;
          }
        },
        dblclick(view, event) {
          try {
            if (state.isPublicView) return false;
            if (!outlineEditModeKey) return false;
            const st = outlineEditModeKey.getState(view.state) || {};
            const editingSectionId = st.editingSectionId || null;
            if (editingSectionId) return false;

            // Включаем edit-mode по dblclick по заголовку или по телу секции.
            const inHeading =
              (event?.target && event.target.closest && event.target.closest('[data-outline-heading="true"]')) ||
              (event?.target && event.target.closest && event.target.closest('.outline-heading'));
            const inBody =
              (event?.target && event.target.closest && event.target.closest('[data-outline-body="true"]')) ||
              (event?.target && event.target.closest && event.target.closest('.outline-body'));
            if (!inHeading && !inBody) return false;

            const coords = { left: event.clientX, top: event.clientY };
            const hit = view.posAtCoords(coords);
            const pos = hit && typeof hit.pos === 'number' ? hit.pos : null;
            if (typeof pos !== 'number') return false;

            const $from = view.state.doc.resolve(Math.max(0, Math.min(view.state.doc.content.size, pos)));
            const sectionPos = findOutlineSectionPosAtSelection(view.state.doc, $from);
            if (typeof sectionPos !== 'number') return false;
            const sectionNode = view.state.doc.nodeAt(sectionPos);
            const sectionId = String(sectionNode?.attrs?.id || '');
            if (!sectionId) return false;

            // Не мешаем стандартному выделению слова по dblclick:
            // включаем edit-mode сразу после того, как ProseMirror обработает событие.
            window.setTimeout(() => {
              try {
                const st2 = outlineEditModeKey.getState(view.state) || {};
                if (st2.editingSectionId) return;
                const currentPos = findSectionPosById(view.state.doc, sectionId);
                const currentNode = typeof currentPos === 'number' ? view.state.doc.nodeAt(currentPos) : null;
                const shouldExpand = Boolean(currentNode?.attrs?.collapsed);

                let tr = view.state.tr;
                if (shouldExpand && typeof currentPos === 'number' && currentNode) {
                  tr = tr.setNodeMarkup(currentPos, undefined, { ...currentNode.attrs, collapsed: false });
                  tr = tr.setMeta(OUTLINE_ALLOW_META, true);
                }

                // Collapsed sections must not enter edit mode.
                if (shouldExpand) {
                  view.dispatch(tr.scrollIntoView());
                  try {
                    view.focus();
                  } catch {
                    // ignore
                  }
                  return;
                }

                tr = tr.setMeta(outlineEditModeKey, { type: 'enter', sectionId });

                // Ставим курсор в начало body секции (внутрь paragraph).
                try {
                  const { TextSelection } = tiptap?.pmStateMod || {};
                  const nodeAfter = typeof currentPos === 'number' ? tr.doc.nodeAt(currentPos) : null;
                  if (nodeAfter && nodeAfter.type?.name === 'outlineSection') {
                    const heading = nodeAfter.child(0);
                    const bodyStart = currentPos + 1 + heading.nodeSize;
                    const posInBody = Math.min(tr.doc.content.size, bodyStart + 2);
                    if (TextSelection) tr = tr.setSelection(TextSelection.near(tr.doc.resolve(posInBody), 1));
                  }
                } catch {
                  // ignore
                }

                view.dispatch(tr.scrollIntoView());
                try {
                  view.focus();
                } catch {
                  // ignore
                }
              } catch {
                // ignore
              }
            }, 0);
          } catch {
            // ignore
          }
          return false;
        },
      },
    },
	    onCreate: ({ editor }) => {
      // Если docJson ещё не хранится на сервере (статья была создана/редактировалась
      // только в блочном режиме), сохраняем docJson отдельно, не трогая blocks.
      if (shouldBootstrapDocJson && state.articleId && state.article && !state.article.encrypted) {
        try {
          const docJson = editor.getJSON();
          state.article.docJson = docJson;
          updateArticleDocJson(state.articleId, docJson).catch(() => {});
        } catch {
          // ignore
        }
      }
      try {
        rebuildCommittedIndexTextMap(editor.state.doc);
      } catch {
        // ignore
      }
      dirtySectionIds.clear();
      docDirty = false;
      outlineLastSavedAt = null;
      lastActiveSectionId = null;
	      try {
	        lastStructureHash = computeOutlineStructureHash(editor.state.doc);
	        structureDirty = false;
	        try {
	          explicitlyDeletedSectionIds.clear();
	        } catch {
	          explicitlyDeletedSectionIds.clear();
	        }
	        if (structureSnapshotTimer) {
	          clearTimeout(structureSnapshotTimer);
	          structureSnapshotTimer = null;
	        }
	      } catch {
        // ignore
      }
      setOutlineStatus('');
    },
	    onUpdate: () => {
      // Любое изменение документа считается изменением текущей секции (или нескольких),
      // но “коммит секции” мы делаем при уходе из неё (onSelectionUpdate).
      docDirty = true;
	      // Spellcheck should run only for sections that were actually edited.
	      // Mark the currently edited section as dirty on any doc update while in edit-mode.
	      try {
	        const st = outlineEditModeKey?.getState?.(outlineEditorInstance?.state) || null;
	        const editingSectionId = String(st?.editingSectionId || '').trim();
	        if (editingSectionId) dirtySectionIds.add(editingSectionId);
	      } catch {
	        // ignore
	      }
	      try {
	        const pmDoc = outlineEditorInstance?.state?.doc || null;
	        if (pmDoc) {
	          const h = computeOutlineStructureHash(pmDoc);
	          if (h && h !== lastStructureHash) {
	            lastStructureHash = h;
	            scheduleStructureSnapshot({ articleId: outlineArticleId || state.articleId, editor: outlineEditorInstance });
	          }
	        }
	      } catch {
	        // ignore
	      }
	      // Keep last-active snapshot in sync with collapsed toggles (view-mode collapse doesn't exit edit-mode).
	      try {
	        maybeWriteActiveOutlineSnapshotFromEditor(outlineEditorInstance);
	      } catch {
	        // ignore
	      }
	      scheduleAutosave({ delayMs: 1500 });
	    },
	    onSelectionUpdate: ({ editor }) => {
      const { state: pmState } = editor;
      const { selection } = pmState;
      if (!selection) return;
      const sectionPos = findOutlineSectionPosAtSelection(pmState.doc, selection.$from);
      if (typeof sectionPos !== 'number') return;
      const sectionNode = pmState.doc.nodeAt(sectionPos);
      const sectionId = String(sectionNode?.attrs?.id || '');
      if (!sectionId) return;

      // Если были в режиме редактирования и ушли в другую секцию — выходим в просмотр.
      try {
        const st = outlineEditModeKey?.getState?.(pmState) || null;
        const editingSectionId = st?.editingSectionId || null;
        if (editingSectionId && editingSectionId !== sectionId) {
          editor.view.dispatch(pmState.tr.setMeta(outlineEditModeKey, { type: 'exit' }));
        }
      } catch {
        // ignore
      }

		      if (lastActiveSectionId && lastActiveSectionId !== sectionId) {
		        const changed = markSectionDirtyIfChanged(pmState.doc, lastActiveSectionId);
		        try {
		          proofreadDebug('leave_section', { from: lastActiveSectionId, to: sectionId, changed });
		        } catch {
		          // ignore
		        }
		        // Only proofread when the section was edited (i.e. marked dirty).
		        try {
		          if (dirtySectionIds.has(lastActiveSectionId)) {
		            maybeProofreadOnLeave(editor, pmState.doc, lastActiveSectionId);
		          }
		        } catch {
		          // ignore
		        }
		        if (changed) {
		          // Ушли из секции — стараемся сохранить быстрее, чтобы история “секции” была естественной.
		          scheduleAutosave({ delayMs: 350 });
		        }
		      }
		      lastActiveSectionId = sectionId;
		      try {
		        maybeWriteActiveOutlineSnapshotFromEditor(editor);
		      } catch {
		        // ignore
		      }
		    },
			  });
			  if (createStart) perfLog('new Editor()', { ms: Math.round(performance.now() - createStart) });

	  try {
	    if (outlineArticleId || state.articleId) {
	      void hydratePendingImagesFromIdbForArticle(outlineArticleId || state.articleId);
	      if (navigator.onLine) void flushPendingImageUploadsForArticle(outlineArticleId || state.articleId);
	    }
	  } catch {
	    // ignore
	  }

	  contentRoot.focus?.({ preventScroll: true });

  // Tags: compute initial index and wire toolbar interactions.
  outlineSetActiveTagKey = (activeKey) => {
    try {
      if (!outlineEditorInstance) return;
      const tr = outlineEditorInstance.state.tr.setMeta(outlineTagHighlighterKey, { activeKey: activeKey || null });
      outlineEditorInstance.view.dispatch(tr);
    } catch {
      // ignore
    }
  };
  try {
    refreshOutlineTagsFromEditor();
  } catch {
    // ignore
  }

  // Миграция: markdown-таблицы текстом → настоящие table nodes.
  try {
    const convertStart = perfEnabled() ? performance.now() : 0;
    convertMarkdownTablesInOutlineDoc(outlineEditorInstance);
    if (convertStart) perfLog('convertMarkdownTablesInOutlineDoc()', { ms: Math.round(performance.now() - convertStart) });
  } catch {
    // ignore
  }
  if (mountStart) perfLog('mountOutlineEditor() total', { ms: Math.round(performance.now() - mountStart) });
  })();

  try {
    await mountPromise;
  } finally {
    mountPromise = null;
  }
}

function escapeHtml(value = '') {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function generateTitleFromBodyPlain(plain = '') {
  const text = (plain || '').replace(/\u00a0/g, ' ').trim();
  if (!text) return 'Без названия';
  const firstLine = text.split('\n').map((s) => s.trim()).find(Boolean) || '';
  const trimmed = firstLine.length > 120 ? `${firstLine.slice(0, 120).trim()}…` : firstLine;
  return trimmed || 'Без названия';
}

function serializeOutlineToBlocks() {
  if (!outlineEditorInstance || !tiptap) return [];
  const { starterKitMod, htmlMod } = tiptap;
  const StarterKit = starterKitMod.default || starterKitMod.StarterKit || starterKitMod;
  const { generateHTML } = htmlMod;
  const Link = tiptap.linkMod.default || tiptap.linkMod.Link || tiptap.linkMod;
  const Image = tiptap.imageMod.default || tiptap.imageMod.Image || tiptap.imageMod;
  const TableKit = tiptap.tableMod.TableKit || tiptap.tableMod.tableKit;

  const htmlExtensions = [
    StarterKit.configure({ heading: false, link: false }),
    Link.configure({ openOnClick: false, protocols: OUTLINE_ALLOWED_LINK_PROTOCOLS }),
    Image,
    TableKit.configure({ table: { resizable: true } }),
  ];

  const bodyNodeToHtml = (bodyNode) => {
    const content = [];
    bodyNode?.content?.forEach?.((child) => {
      content.push(child.toJSON());
    });
    const doc = { type: 'doc', content };
    const html = generateHTML(doc, htmlExtensions) || '';
    return (html || '').trim();
  };

  const sectionNodeToBlock = (sectionNode) => {
    const id = String(sectionNode?.attrs?.id || safeUuid());
    const collapsed = Boolean(sectionNode?.attrs?.collapsed);
    const headingNode = sectionNode.child(0);
    const bodyNode = sectionNode.child(1);
    const childrenNode = sectionNode.child(2);

    const bodyHtml = bodyNodeToHtml(bodyNode);
    const bodyPlain = stripHtml(bodyHtml);
    const titleTextRaw = (headingNode?.textContent || '').trim();
    const titleText = titleTextRaw || generateTitleFromBodyPlain(bodyPlain);
    const titleHtml = `<p>${escapeHtml(titleText)}</p>`;
    const text = `${titleHtml}<p><br /></p>${bodyHtml || ''}`.trim();

    const children = [];
    childrenNode?.content?.forEach?.((child) => {
      children.push(sectionNodeToBlock(child));
    });
    return { id, text, collapsed, children };
  };

  const blocks = [];
  outlineEditorInstance.state.doc.content.forEach((child) => {
    blocks.push(sectionNodeToBlock(child));
  });
  return blocks;
}

async function saveOutlineEditor(options = {}) {
  if (state.isPublicView) return;
  if (!state.articleId || !state.article) return;
  if (!outlineEditorInstance) return;
  const targetArticleId = outlineArticleId || state.articleId;
  if (!targetArticleId) return;
  const silent = Boolean(options.silent);
	    const mode = options && typeof options.mode === 'string' ? options.mode : 'network'; // network | queue
	    const postSaveTitleSectionIds = Array.from(new Set([...(dirtySectionIds || []), lastActiveSectionId].filter(Boolean)));
	    try {
    if (!silent) showPersistentToast('Сохраняем outline…');
    if (state.article.encrypted) {
      if (!silent) {
        hideToast();
        showToast('Outline-сохранение docJson недоступно для зашифрованных статей');
      }
      return;
	    }
		    const docJsonRaw = outlineEditorInstance.getJSON();
		    const docJson = normalizeDocJsonForSave(docJsonRaw);
	    // Guard: if state.articleId already switched to another article, never write inbox docJson into it.
		    if (state.articleId && targetArticleId !== state.articleId) {
		      try {
		        await updateCachedDocJson(targetArticleId, docJson, state.article?.updatedAt || null);
	      } catch {
	        // ignore
	      }
      if (!silent) hideToast();
      setOutlineStatus('Оффлайн: черновик сохранён локально');
      return;
    }
			    if (mode === 'queue') {
			      const clientQueuedAt = Date.now();
		      try {
		        // Keep server updatedAt (do not bump it locally), to avoid confusing meta checks.
		        await updateCachedDocJson(targetArticleId, docJson, state.article?.updatedAt || null);
		      } catch {
		        // ignore
		      }

		      // Structural changes must be persisted even if the user only moved blocks (no content edits).
		      // Enqueue snapshot here (autosave runs sooner than the debounce, and Ctrl-F5 can happen any time).
		      try {
		        if (structureDirty && !explicitlyDeletedSectionIds.size) {
		          const nodes = computeOutlineStructureNodesFromDoc(outlineEditorInstance.state.doc);
		          if (nodes.length) {
		            await enqueueOp('structure_snapshot', {
		              articleId: targetArticleId,
		              payload: { nodes, clientQueuedAt },
		              coalesceKey: `structure:${targetArticleId}`,
		            });
		          }
		          structureDirty = false;
		          if (structureSnapshotTimer) {
		            clearTimeout(structureSnapshotTimer);
		            structureSnapshotTimer = null;
		          }
		        }
		      } catch {
		        // ignore
		      }

		      // Structural deletions must be saved as full docJson so the server actually removes blocks
		      // (structure snapshots alone can only reorder/parent existing blocks).
		      if (explicitlyDeletedSectionIds.size) {
		        explicitlyDeletedSectionIds.clear();
		        try {
		          if (navigator.onLine) {
		            const result = await saveArticleDocJson(targetArticleId, docJson, { createVersionIfStaleHours: 12 });
		            if (state.article) {
		              state.article.docJson = docJson;
		              if (result?.updatedAt) state.article.updatedAt = result.updatedAt;
		            }
		            try {
		              rebuildCommittedIndexTextMap(outlineEditorInstance.state.doc);
		              dirtySectionIds.clear();
		            } catch {
		              // ignore
		            }
		            docDirty = false;
		            outlineLastSavedAt = new Date();
		            setOutlineStatus(`Сохранено ${formatTimeShort(outlineLastSavedAt)}`);
		            try {
		              refreshOutlineTagsFromEditor();
		            } catch {
		              // ignore
		            }
		            return;
		          }
		        } catch {
		          // fall back to outbox
		        }
		        try {
		          await enqueueOp('save_doc_json', {
		            articleId: targetArticleId,
		            payload: { docJson, createVersionIfStaleHours: 12, clientQueuedAt },
		            coalesceKey: targetArticleId,
		          });
		        } catch {
		          // ignore
		        }
		        try {
		          rebuildCommittedIndexTextMap(outlineEditorInstance.state.doc);
		          dirtySectionIds.clear();
		        } catch {
		          // ignore
		        }
		        docDirty = false;
		        outlineLastSavedAt = new Date();
		        setOutlineStatus('Оффлайн: в очереди на синхронизацию');
		        try {
		          refreshOutlineTagsFromEditor();
		        } catch {
		          // ignore
		        }
		        return;
		      }

			      // Persist only changed section contents (never overwrite the whole article docJson on the server).
			      try {
			        try {
			          if (lastActiveSectionId) markSectionDirtyIfChanged(outlineEditorInstance.state.doc, lastActiveSectionId);
			        } catch {
			          // ignore
			        }
			        const sectionIds = Array.from(new Set([...(dirtySectionIds || [])].filter(Boolean)));
		        for (const sid of sectionIds) {
		          try {
		            const pos = findSectionPosById(outlineEditorInstance.state.doc, sid);
		            if (typeof pos !== 'number') continue;
		            const node = outlineEditorInstance.state.doc.nodeAt(pos);
		            if (!node || node.type?.name !== 'outlineSection') continue;
		            const heading = node.child(0);
		            const body = node.child(1);
		            const headingJson = heading?.toJSON ? heading.toJSON() : null;
		            const bodyJson = body?.toJSON ? body.toJSON() : null;
		            if (!headingJson || !bodyJson) continue;
		            const seq = getNextSectionSeq(targetArticleId, sid);
		            await enqueueOp('section_upsert_content', {
		              articleId: targetArticleId,
		              payload: {
		                sectionId: sid,
		                headingJson,
		                bodyJson,
		                seq,
		                clientQueuedAt,
		              },
		              coalesceKey: `content:${targetArticleId}:${sid}`,
		            });
		          } catch {
		            // ignore this section
		          }
		        }
		      } catch {
		        // ignore
		      }
	      if (!silent) hideToast();
	      if (state.article) {
	        state.article.docJson = docJson;
	      }
	      try {
	        rebuildCommittedIndexTextMap(outlineEditorInstance.state.doc);
	        dirtySectionIds.clear();
	      } catch {
	        // ignore
	      }
	      docDirty = false;
	      outlineLastSavedAt = new Date();
	      setOutlineStatus('Оффлайн: в очереди на синхронизацию');
	      try {
	        refreshOutlineTagsFromEditor();
	      } catch {
	        // ignore
	      }
	      try {
	        maybeGenerateTitlesAfterSave(outlineEditorInstance, outlineEditorInstance.state.doc, postSaveTitleSectionIds);
	      } catch {
	        // ignore
	      }
		      return;
		    }
    const result = await saveArticleDocJson(targetArticleId, docJson, { createVersionIfStaleHours: 12 });
    if (!silent) hideToast();
    const isQueued = Boolean(result?.offline) || String(result?.status || '') === 'queued';
    if (state.article) {
      state.article.docJson = docJson;
      if (result?.updatedAt) {
        state.article.updatedAt = result.updatedAt;
      }
      if (Array.isArray(result?.historyEntriesAdded) && result.historyEntriesAdded.length) {
        state.article.history = [...(state.article.history || []), ...result.historyEntriesAdded];
        state.article.redoHistory = [];
        hydrateUndoRedoFromArticle(state.article);
      }
    }
    try {
      rebuildCommittedIndexTextMap(outlineEditorInstance.state.doc);
      dirtySectionIds.clear();
    } catch {
      // ignore
    }
	    docDirty = false;
	    outlineLastSavedAt = new Date();
		    setOutlineStatus(isQueued ? 'Оффлайн: в очереди на синхронизацию' : `Сохранено ${formatTimeShort(outlineLastSavedAt)}`);
	      try {
	        refreshOutlineTagsFromEditor();
	      } catch {
	        // ignore
	      }
	      try {
	        if (!isQueued) {
	          maybeGenerateTitlesAfterSave(outlineEditorInstance, outlineEditorInstance.state.doc, postSaveTitleSectionIds);
	        }
	      } catch {
	        // ignore
	      }
		    // Run spellcheck after a successful save, so it doesn't depend on "leaving the section".
		    try {
		      if (!isQueued && outlineEditorInstance && !outlineEditorInstance.isDestroyed) {
		        const sid = lastActiveSectionId || null;
		        if (sid) maybeProofreadOnLeave(outlineEditorInstance, outlineEditorInstance.state.doc, sid);
		      }
		    } catch {
		      // ignore
	    }
	  } catch (error) {
    if (!silent) {
      hideToast();
      showToast(error?.message || 'Не удалось сохранить outline');
    } else {
      setOutlineStatus('Ошибка сохранения');
    }
	    // Сохраняем в локальную очередь, чтобы догнать позже.
	    try {
	      const docJson = outlineEditorInstance.getJSON();
	      if (docJson && typeof docJson === 'object') {
	        try {
	          await updateCachedDocJson(targetArticleId, docJson, state.article?.updatedAt || null);
	        } catch {
	          // ignore
	        }
	      }
	    } catch {
	      // ignore
	    }
    // Ретрай чуть позже.
    scheduleAutosave({ delayMs: 5000 });
  }
}

export function getOutlineActiveSectionId() {
  return lastActiveSectionId || null;
}

export function getOutlineActiveSectionSnapshot() {
  try {
    if (!outlineEditorInstance || outlineEditorInstance.isDestroyed) return null;
    const pmState = outlineEditorInstance.state;
    const pos = findOutlineSectionPosAtSelection(pmState.doc, pmState.selection.$from);
    if (typeof pos !== 'number') return null;
    const node = pmState.doc.nodeAt(pos);
    if (!node || node.type?.name !== 'outlineSection') return null;
    const id = String(node.attrs?.id || '').trim();
    if (!id) return null;
    return { sectionId: id, collapsed: Boolean(node.attrs?.collapsed) };
  } catch {
    return null;
  }
}

function findOutlineSectionPathById(doc, targetId) {
  try {
    const tid = String(targetId || '');
    if (!doc || !tid) return null;
    const visitSection = (node, pos, stack) => {
      if (!node || node.type?.name !== 'outlineSection') return null;
      const id = String(node.attrs?.id || '');
      const nextStack = [...stack, pos];
      if (id === tid) return nextStack;
      const heading = node.child(0);
      const body = node.child(1);
      const children = node.child(2);
      if (!children || children.type?.name !== 'outlineChildren') return null;
      const childrenPos = pos + 1 + heading.nodeSize + body.nodeSize;
      let offset = childrenPos + 1;
      for (let i = 0; i < children.childCount; i += 1) {
        const child = children.child(i);
        const childPos = offset;
        offset += child.nodeSize;
        const found = visitSection(child, childPos, nextStack);
        if (found) return found;
      }
      return null;
    };
    let offset = 0;
    for (let i = 0; i < doc.childCount; i += 1) {
      const child = doc.child(i);
      const pos = offset;
      offset += child.nodeSize;
      const found = visitSection(child, pos, []);
      if (found) return found;
    }
    return null;
  } catch {
    return null;
  }
}

export function revealOutlineSection(sectionId, options = {}) {
  try {
    if (!outlineEditorInstance || outlineEditorInstance.isDestroyed) return false;
    const sid = String(sectionId || '');
    if (!sid) return false;
    const { state: pmState, view } = outlineEditorInstance;
    const TextSelection = tiptap?.pmStateMod?.TextSelection;
    const path = findOutlineSectionPathById(pmState.doc, sid);
    if (!Array.isArray(path) || !path.length) return false;

    let tr = pmState.tr;
    for (const pos of path) {
      const node = tr.doc.nodeAt(pos);
      if (!node || node.type?.name !== 'outlineSection') continue;
      if (Boolean(node.attrs?.collapsed)) {
        tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, collapsed: false });
      }
    }
    tr = tr.setMeta(OUTLINE_ALLOW_META, true);

    // Put selection on the target section (body start) so onSelectionUpdate marks it active.
    try {
      const targetPos = findSectionPosById(tr.doc, sid);
      const targetNode = typeof targetPos === 'number' ? tr.doc.nodeAt(targetPos) : null;
      if (typeof targetPos === 'number' && targetNode?.type?.name === 'outlineSection') {
        const heading = targetNode.child(0);
        const bodyStart = targetPos + 1 + heading.nodeSize;
        const posInBody = Math.min(tr.doc.content.size, bodyStart + 2);
        if (TextSelection) {
          tr = tr.setSelection(TextSelection.create(tr.doc, posInBody));
        }
      }
    } catch {
      // ignore
    }

    view.dispatch(tr.scrollIntoView());

    // Extra safety: ProseMirror's `scrollIntoView()` sometimes doesn't move the scroll container
    // enough (especially after layout changes). Ensure the actual section DOM is visible.
    try {
      const escaped =
        typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(sid) : sid.replace(/"/g, '\\"');
      window.requestAnimationFrame(() => {
        try {
          const el =
            view.dom?.querySelector?.(`[data-outline-section][data-section-id="${escaped}"]`) ||
            view.dom?.querySelector?.(`[data-section-id="${escaped}"]`);
          if (el && typeof el.scrollIntoView === 'function') {
            el.scrollIntoView({ block: 'center', inline: 'nearest' });
          }
        } catch {
          // ignore
        }
      });
    } catch {
      // ignore
    }

    if (options && options.focus) {
      try {
        view.focus();
      } catch {
        // ignore
      }
    }
    return true;
  } catch {
    return false;
  }
}

export function restoreOutlineSectionFromBlockHtml(sectionId, htmlText) {
  if (!outlineEditorInstance) return false;
  const sid = String(sectionId || '');
  if (!sid) return false;
  const pos = findSectionPosById(outlineEditorInstance.state.doc, sid);
  if (typeof pos !== 'number') return false;
  const sectionNode = outlineEditorInstance.state.doc.nodeAt(pos);
  if (!sectionNode) return false;
  const schema = outlineEditorInstance.state.doc.type.schema;

  const parts = extractBlockSections(String(htmlText || ''));
  const titleText = stripHtml(parts.titleHtml || '') || stripHtml(parts.bodyHtml || '').slice(0, 80) || 'Без названия';
  const bodyNodesJson = outlineParseHtmlToNodes ? outlineParseHtmlToNodes(parts.bodyHtml || '') : [];
  const bodyNodes = [];
  for (const n of bodyNodesJson || []) {
    try {
      bodyNodes.push(schema.nodeFromJSON(n));
    } catch {
      // ignore invalid nodes
    }
  }
  if (!bodyNodes.length) {
    bodyNodes.push(schema.nodes.paragraph.create({}, []));
  }

  const headingNode = schema.nodes.outlineHeading.create({}, titleText ? [schema.text(titleText)] : []);
  const bodyNode = schema.nodes.outlineBody.create({}, bodyNodes);
  const childrenNode = sectionNode.child(2);
  const nextSection = schema.nodes.outlineSection.create(sectionNode.attrs, [headingNode, bodyNode, childrenNode]);

  let tr = outlineEditorInstance.state.tr.replaceWith(pos, pos + sectionNode.nodeSize, nextSection);
  try {
    const TextSelection = tiptap?.pmStateMod?.TextSelection;
    if (TextSelection) {
      tr = tr.setSelection(TextSelection.create(tr.doc, pos + 2));
    }
  } catch {
    // ignore
  }
  outlineEditorInstance.view.dispatch(tr);
  outlineEditorInstance.view.focus();
  docDirty = true;
  scheduleAutosave({ delayMs: 200 });
  return true;
}

export function restoreOutlineSectionFromSectionFragments(sectionId, fragments) {
  if (!outlineEditorInstance) return false;
  const sid = String(sectionId || '');
  if (!sid) return false;
  const pos = findSectionPosById(outlineEditorInstance.state.doc, sid);
  if (typeof pos !== 'number') return false;
  const sectionNode = outlineEditorInstance.state.doc.nodeAt(pos);
  if (!sectionNode) return false;

  const frag = fragments && typeof fragments === 'object' ? fragments : {};
  const schema = outlineEditorInstance.state.doc.type.schema;

  let headingNode = null;
  let bodyNode = null;
  try {
    if (frag.heading && typeof frag.heading === 'object') {
      headingNode = schema.nodeFromJSON(frag.heading);
    }
  } catch {
    headingNode = null;
  }
  try {
    if (frag.body && typeof frag.body === 'object') {
      bodyNode = schema.nodeFromJSON(frag.body);
    }
  } catch {
    bodyNode = null;
  }

  if (!headingNode || headingNode.type?.name !== 'outlineHeading') {
    headingNode = schema.nodes.outlineHeading.create({}, []);
  }
  if (!bodyNode || bodyNode.type?.name !== 'outlineBody') {
    bodyNode = schema.nodes.outlineBody.create({}, [schema.nodes.paragraph.create({}, [])]);
  }
  if (!bodyNode.childCount) {
    bodyNode = schema.nodes.outlineBody.create({}, [schema.nodes.paragraph.create({}, [])]);
  }

  const childrenNode = sectionNode.child(2);
  const nextSection = schema.nodes.outlineSection.create(sectionNode.attrs, [headingNode, bodyNode, childrenNode]);

  let tr = outlineEditorInstance.state.tr.replaceWith(pos, pos + sectionNode.nodeSize, nextSection);
  try {
    const TextSelection = tiptap?.pmStateMod?.TextSelection;
    if (TextSelection) {
      tr = tr.setSelection(TextSelection.create(tr.doc, pos + 2));
    }
  } catch {
    // ignore
  }
  outlineEditorInstance.view.dispatch(tr);
  outlineEditorInstance.view.focus();
  docDirty = true;
  scheduleAutosave({ delayMs: 200 });
  return true;
}

export function insertOutlineSectionFromSectionFragmentsAtEnd(sectionId, fragments) {
  if (!outlineEditorInstance) return false;
  const sid = String(sectionId || '').trim();
  if (!sid) return false;
  const exists = findSectionPosById(outlineEditorInstance.state.doc, sid);
  if (typeof exists === 'number') return false;

  const frag = fragments && typeof fragments === 'object' ? fragments : {};
  const schema = outlineEditorInstance.state.doc.type.schema;

  let headingNode = null;
  let bodyNode = null;
  try {
    if (frag.heading && typeof frag.heading === 'object') {
      headingNode = schema.nodeFromJSON(frag.heading);
    }
  } catch {
    headingNode = null;
  }
  try {
    if (frag.body && typeof frag.body === 'object') {
      bodyNode = schema.nodeFromJSON(frag.body);
    }
  } catch {
    bodyNode = null;
  }

  if (!headingNode || headingNode.type?.name !== 'outlineHeading') {
    headingNode = schema.nodes.outlineHeading.create({}, []);
  }
  if (!bodyNode || bodyNode.type?.name !== 'outlineBody') {
    bodyNode = schema.nodes.outlineBody.create({}, [schema.nodes.paragraph.create({}, [])]);
  }
  if (!bodyNode.childCount) {
    bodyNode = schema.nodes.outlineBody.create({}, [schema.nodes.paragraph.create({}, [])]);
  }

  const childrenNode = schema.nodes.outlineChildren.create({}, []);
  const sectionNode = schema.nodes.outlineSection.create({ id: sid, collapsed: false }, [
    headingNode,
    bodyNode,
    childrenNode,
  ]);

  const insertPos = outlineEditorInstance.state.doc.content.size;
  let tr = outlineEditorInstance.state.tr.insert(insertPos, sectionNode);
  try {
    const TextSelection = tiptap?.pmStateMod?.TextSelection;
    if (TextSelection) {
      const nextPos = Math.min(tr.doc.content.size, insertPos + 2);
      tr = tr.setSelection(TextSelection.near(tr.doc.resolve(Math.max(0, nextPos)), 1));
    }
  } catch {
    // ignore
  }
  tr = tr.setMeta(OUTLINE_ALLOW_META, true);
  outlineEditorInstance.view.dispatch(tr.scrollIntoView());
  outlineEditorInstance.view.focus();
  docDirty = true;
  scheduleAutosave({ delayMs: 200 });
  return true;
}

export function insertNewOutlineSectionAtEnd({ enterEditMode = true } = {}) {
  if (!outlineEditorInstance) return null;
  const schema = outlineEditorInstance.state.doc.type.schema;
  const insertPos = outlineEditorInstance.state.doc.content.size;
  const sectionId = safeUuid();

  const sectionNode = schema.nodes.outlineSection.create(
    { id: sectionId, collapsed: false },
    [
      schema.nodes.outlineHeading.create({}, []),
      schema.nodes.outlineBody.create({}, [schema.nodes.paragraph.create({}, [])]),
      schema.nodes.outlineChildren.create({}, []),
    ],
  );

  let tr = outlineEditorInstance.state.tr.insert(insertPos, sectionNode);
  try {
    const TextSelection = tiptap?.pmStateMod?.TextSelection;
    if (TextSelection) {
      const sectionPos = findSectionPosById(tr.doc, sectionId);
      const bodyStart = typeof sectionPos === 'number' ? findOutlineSectionBodyStartPos(tr.doc, sectionPos) : null;
      if (typeof bodyStart === 'number') {
        tr = tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(tr.doc.content.size, bodyStart + 2)), 1));
      } else {
        tr = tr.setSelection(TextSelection.create(tr.doc, insertPos + 2));
      }
    }
  } catch {
    // ignore
  }
  tr = tr.setMeta(OUTLINE_ALLOW_META, true);
  if (enterEditMode && outlineEditModeKey) {
    tr = tr.setMeta(outlineEditModeKey, { type: 'enter', sectionId });
  }
  outlineEditorInstance.view.dispatch(tr.scrollIntoView());
  outlineEditorInstance.view.focus();
  docDirty = true;
  scheduleAutosave({ delayMs: 200 });
  return sectionId;
}

function findOutlineSectionBodyStartPos(doc, sectionPos) {
  try {
    const sectionNode = doc.nodeAt(sectionPos);
    if (!sectionNode || sectionNode.type?.name !== 'outlineSection') return null;
    const headingNode = sectionNode.child(0);
    return sectionPos + 1 + headingNode.nodeSize;
  } catch {
    return null;
  }
}

export function enterOutlineSectionEditMode(sectionId, { focusBody = true } = {}) {
  if (!outlineEditorInstance) return false;
  if (!outlineEditModeKey) return false;
  const sid = String(sectionId || '').trim();
  if (!sid) return false;
  const sectionPos = findSectionPosById(outlineEditorInstance.state.doc, sid);
  if (typeof sectionPos !== 'number') return false;
  const sectionNode = outlineEditorInstance.state.doc.nodeAt(sectionPos);
  // Do not enter edit mode for collapsed sections (must be expanded first by user action).
  if (Boolean(sectionNode?.attrs?.collapsed)) return false;

  let tr = outlineEditorInstance.state.tr;
  if (focusBody) {
    try {
      const TextSelection = tiptap?.pmStateMod?.TextSelection;
      const bodyStart = findOutlineSectionBodyStartPos(tr.doc, sectionPos);
      if (TextSelection && typeof bodyStart === 'number') {
        tr = tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(tr.doc.content.size, bodyStart + 2)), 1));
      }
    } catch {
      // ignore
    }
  }
  tr = tr.setMeta(OUTLINE_ALLOW_META, true);
  tr = tr.setMeta(outlineEditModeKey, { type: 'enter', sectionId: sid });
  outlineEditorInstance.view.dispatch(tr.scrollIntoView());
  outlineEditorInstance.view.focus();
  return true;
}

export function insertNewOutlineSectionAtStart({ enterEditMode = true } = {}) {
  if (!outlineEditorInstance) return null;
  const schema = outlineEditorInstance.state.doc.type.schema;
  const insertPos = 0;
  const sectionId = safeUuid();

  const sectionNode = schema.nodes.outlineSection.create(
    { id: sectionId, collapsed: false },
    [
      schema.nodes.outlineHeading.create({}, []),
      schema.nodes.outlineBody.create({}, [schema.nodes.paragraph.create({}, [])]),
      schema.nodes.outlineChildren.create({}, []),
    ],
  );

  let tr = outlineEditorInstance.state.tr.insert(insertPos, sectionNode);
  try {
    const TextSelection = tiptap?.pmStateMod?.TextSelection;
    if (TextSelection) {
      const sectionPos = findSectionPosById(tr.doc, sectionId);
      const bodyStart = typeof sectionPos === 'number' ? findOutlineSectionBodyStartPos(tr.doc, sectionPos) : null;
      if (typeof bodyStart === 'number') {
        tr = tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(tr.doc.content.size, bodyStart + 2)), 1));
      } else {
        tr = tr.setSelection(TextSelection.create(tr.doc, insertPos + 2));
      }
    }
  } catch {
    // ignore
  }
  tr = tr.setMeta(OUTLINE_ALLOW_META, true);
  if (enterEditMode && outlineEditModeKey) {
    tr = tr.setMeta(outlineEditModeKey, { type: 'enter', sectionId });
  }
  outlineEditorInstance.view.dispatch(tr.scrollIntoView());
  outlineEditorInstance.view.focus();
  docDirty = true;
  scheduleAutosave({ delayMs: 200 });
  return sectionId;
}

export function insertOutlineSectionFromPlainTextAtStart(sectionId, text, { enterEditMode = false } = {}) {
  if (!outlineEditorInstance) return false;
  const sid = String(sectionId || '').trim();
  if (!sid) return false;
  const exists = findSectionPosById(outlineEditorInstance.state.doc, sid);
  if (typeof exists === 'number') return false;

  const schema = outlineEditorInstance.state.doc.type.schema;
  const paragraphType = schema.nodes.paragraph;
  const hardBreakType = schema.nodes.hardBreak || schema.nodes.hard_break || null;
  const raw = String(text || '').replace(/\r\n/g, '\n').trimEnd();

  const buildParagraphNodes = () => {
    if (!paragraphType) return [];
    if (!raw.trim()) return [paragraphType.create({}, [])];
    const parts = raw.split(/\n{2,}/);
    const out = [];
    for (const p of parts) {
      const lines = String(p || '').split('\n');
      const content = [];
      for (let i = 0; i < lines.length; i += 1) {
        const t = lines[i];
        if (i > 0 && hardBreakType) content.push(hardBreakType.create());
        if (t) content.push(schema.text(t));
      }
      out.push(paragraphType.create({}, content));
    }
    return out.length ? out : [paragraphType.create({}, [])];
  };

  const headingNode = schema.nodes.outlineHeading.create({}, []);
  const bodyNode = schema.nodes.outlineBody.create({}, buildParagraphNodes());
  const childrenNode = schema.nodes.outlineChildren.create({}, []);
  const sectionNode = schema.nodes.outlineSection.create({ id: sid, collapsed: false }, [
    headingNode,
    bodyNode,
    childrenNode,
  ]);

  const insertPos = 0;
  let tr = outlineEditorInstance.state.tr.insert(insertPos, sectionNode);
  try {
    const TextSelection = tiptap?.pmStateMod?.TextSelection;
    if (TextSelection) {
      const sectionPos = findSectionPosById(tr.doc, sid);
      const bodyStart = typeof sectionPos === 'number' ? findOutlineSectionBodyStartPos(tr.doc, sectionPos) : null;
      if (typeof bodyStart === 'number') {
        tr = tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(tr.doc.content.size, bodyStart + 2)), 1));
      } else {
        tr = tr.setSelection(TextSelection.create(tr.doc, insertPos + 2));
      }
    }
  } catch {
    // ignore
  }
  tr = tr.setMeta(OUTLINE_ALLOW_META, true);
  if (enterEditMode && outlineEditModeKey) {
    tr = tr.setMeta(outlineEditModeKey, { type: 'enter', sectionId: sid });
  }
  outlineEditorInstance.view.dispatch(tr.scrollIntoView());
  outlineEditorInstance.view.focus();
  docDirty = true;
  scheduleAutosave({ delayMs: 200 });
  return true;
}

export async function openOutlineEditor() {
  if (state.isPublicView || state.isRagView) {
    showToast('Outline-редактор недоступен в этом режиме');
    return;
  }
  if (!state.articleId || !state.article) {
    showToast('Сначала откройте статью');
    return;
  }
  outlineArticleId = state.articleId;
  if (!refs.outlineEditor || !refs.blocksContainer) {
    showToast('Не удалось открыть outline-редактор');
    return;
  }
  state.isOutlineEditing = true;
  if (refs.articleToolbar) refs.articleToolbar.classList.add('hidden');
  if (refs.outlineToolbar) refs.outlineToolbar.classList.remove('hidden');
  if (refs.outlineTagsBar) refs.outlineTagsBar.classList.remove('hidden');
  refs.outlineEditor.classList.remove('hidden');
  refs.blocksContainer.classList.add('hidden');
  renderOutlineShell({ loading: true });

  // Drafts are stored in IndexedDB cache (`updateCachedDocJson`), not in localStorage.

  // Restore last-active section/collapsed state on open (only for normal navigation; search deep-links override this).
  try {
    if (!state.scrollTargetBlockId && outlineArticleId) {
      const snap = readOutlineLastActiveSnapshot(outlineArticleId);
      if (snap?.sectionId) {
        // Make sure we open the last active section, and keep it in the same collapsed state.
        // Apply to docJson before TipTap mounts so it doesn't count as an edit/autosave.
        try {
          if (state.article?.docJson && typeof state.article.docJson === 'object') {
            patchDocJsonCollapsedForPath(state.article.docJson, snap.sectionId, snap.collapsed);
          }
        } catch {
          // ignore
        }
        state.currentBlockId = snap.sectionId;
      }
    }
  } catch {
    // ignore
  }

	  try {
	    await mountOutlineEditor();
	    try {
	      mountOutlineToolbar(outlineEditorInstance);
	    } catch {
	      // ignore
	    }
	    // If navigation/search requested a specific block, reveal it (expand ancestors) and scroll into view.
	    try {
	      const explicitTarget = state.scrollTargetBlockId || null;
	      if (explicitTarget) {
	        revealOutlineSection(explicitTarget, { focus: false });
	        state.scrollTargetBlockId = null;
	        state.currentBlockId = explicitTarget;
	      }
	    } catch {
	      // ignore
	    }
	    // Place cursor inside the current section (heading if collapsed, body otherwise) and ensure it's visible.
	    try {
	      const targetId = state.currentBlockId || null;
	      if (targetId) {
	        moveCursorToSectionPreferredStart(outlineEditorInstance, targetId);
	      }
	    } catch {
	      // ignore
	    }
    const loading = refs.outlineEditor.querySelector('.outline-editor__loading');
    if (loading) loading.classList.add('hidden');
    setOutlineStatus('Сохраняется автоматически');

	    if (!onlineHandlerAttached) {
      onlineHandlerAttached = true;
	      window.addEventListener('online', () => {
	        if (!state.isOutlineEditing) return;
	        try {
	          void flushPendingImageUploadsForArticle(outlineArticleId || state.articleId);
	        } catch {
	          // ignore
	        }
	        void runAutosave({ force: true });
	      });
      window.addEventListener('blur', () => {
        if (!state.isOutlineEditing) return;
        void runAutosave({ force: true });
      });
      document.addEventListener('visibilitychange', () => {
        if (!state.isOutlineEditing) return;
        if (document.visibilityState !== 'visible') {
          void runAutosave({ force: true });
        }
      });
	    }

	    // Guard: prevent browser navigation when user drops a file outside the editor.
	    if (!dropGuardCleanup) {
	      const onDragOver = (event) => {
	        if (!state.isOutlineEditing) return;
	        const dt = event?.dataTransfer;
	        const hasFiles = dt && ((dt.files && dt.files.length) || (dt.items && dt.items.length));
	        if (!hasFiles) return;
	        const target = event?.target;
	        if (refs.outlineEditor && target && refs.outlineEditor.contains(target)) return;
	        event.preventDefault();
	      };
	      const onDrop = (event) => {
	        if (!state.isOutlineEditing) return;
	        const dt = event?.dataTransfer;
	        const hasFiles = dt && dt.files && dt.files.length;
	        if (!hasFiles) return;
	        const target = event?.target;
	        if (refs.outlineEditor && target && refs.outlineEditor.contains(target)) return;
	        event.preventDefault();
	        event.stopPropagation();
	      };
	      window.addEventListener('dragover', onDragOver, { passive: false });
	      window.addEventListener('drop', onDrop, { passive: false });
	      dropGuardCleanup = () => {
	        window.removeEventListener('dragover', onDragOver);
	        window.removeEventListener('drop', onDrop);
	        dropGuardCleanup = null;
	      };
	    }

		    // No localStorage queued docJson sync: outbox handles background sync.
	  } catch (error) {
	    showToast(error?.message || 'Не удалось загрузить outline-редактор');
	    closeOutlineEditor();
	  }
}

export function closeOutlineEditor() {
  state.isOutlineEditing = false;
  unmountOutlineToolbar();
  outlineEditModeKey = null;
  outlineArticleId = null;
  outlineActiveTagKey = null;
  outlineSetActiveTagKey = null;
  outlineTagsIndex = {
    counts: new Map(),
    labelByKey: new Map(),
    sectionIdsByKey: new Map(),
    sectionPosById: new Map(),
  };
	  try {
	    if (refs.outlineTagsBar) {
	      refs.outlineTagsBar.innerHTML = '';
	      refs.outlineTagsBar.classList.add('hidden');
	    }
	  } catch {
	    // ignore
	  }
	  setOutlineSelectionMode(false);
	  if (dropGuardCleanup) dropGuardCleanup();
  if (refs.outlineToolbar) refs.outlineToolbar.classList.add('hidden');
  if (refs.articleToolbar) refs.articleToolbar.classList.remove('hidden');
  if (autosaveTimer) {
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
  }
  if (structureSnapshotTimer) {
    clearTimeout(structureSnapshotTimer);
    structureSnapshotTimer = null;
  }
	  structureDirty = false;
	  lastStructureHash = '';
	  try {
	    explicitlyDeletedSectionIds.clear();
	  } catch {
	    // ignore
	  }
	  autosaveInFlight = false;
  dirtySectionIds.clear();
  committedSectionIndexText.clear();
  lastActiveSectionId = null;
  docDirty = false;
  if (outlineEditorInstance) {
    try {
      outlineEditorInstance.destroy();
    } catch {
      // ignore
    }
    outlineEditorInstance = null;
  }
  tiptap = null;
  if (refs.outlineEditor) refs.outlineEditor.classList.add('hidden');
  if (refs.blocksContainer) refs.blocksContainer.classList.remove('hidden');
}

export async function flushOutlineAutosave(options = {}) {
  const mode = options && typeof options.mode === 'string' ? options.mode : 'network';
  const timeoutMs =
    options && typeof options.timeoutMs === 'number' ? Math.max(0, Math.floor(options.timeoutMs)) : 0;
  if (!outlineEditorInstance) return;
  if (autosaveTimer) {
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
  }

  // Queue current draft locally first (fast, no network), so navigation won't lose edits.
  try {
    const targetArticleId = outlineArticleId || state.articleId;
    if (targetArticleId && !state.article?.encrypted) {
      const docJson = outlineEditorInstance.getJSON();
      if (docJson && typeof docJson === 'object') {
        try {
          await updateCachedDocJson(targetArticleId, docJson, state.article?.updatedAt || null);
        } catch {
          // ignore
        }
      }
      // If structure changed, enqueue a snapshot immediately on navigation (debounce may not fire).
      try {
        if (structureDirty && !explicitlyDeletedSectionIds.size) {
          const nodes = computeOutlineStructureNodesFromDoc(outlineEditorInstance.state.doc);
          if (nodes.length) {
            void enqueueOp('structure_snapshot', {
              articleId: targetArticleId,
              payload: { nodes },
              coalesceKey: `structure:${targetArticleId}`,
            });
            structureDirty = false;
          }
        }
      } catch {
        // ignore
      }
      // If user deleted sections, we need a full save (queue it locally so navigation doesn't lose it).
      try {
        if (explicitlyDeletedSectionIds.size) {
          explicitlyDeletedSectionIds.clear();
          await enqueueOp('save_doc_json', {
            articleId: targetArticleId,
            payload: { docJson, createVersionIfStaleHours: 12 },
            coalesceKey: targetArticleId,
          });
        }
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }

  // Navigation path: don't block on slow network saves; outbox will sync later.
  if (mode === 'queue') return;

  const p = runAutosave({ force: true, silent: true });
  if (timeoutMs > 0) {
    await Promise.race([p, new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
    return;
  }
  await p;
}

export async function openPublicOutlineViewer({ docJson } = {}) {
  if (!refs.outlineEditor) return;
  if (!docJson || typeof docJson !== 'object') {
    showToast('Публичная статья: нет документа');
    return;
  }

  state.isPublicView = true;
  state.isRagView = false;
  state.isOutlineEditing = false;
  state.articleId = null;
  state.article = { docJson, encrypted: false };

  // Важно: CSS-переменные outline (цвета/рамки) объявлены на `.outline-editor`,
  // поэтому в публичном просмотре принудительно добавляем этот класс.
  try {
    refs.outlineEditor.classList.add('outline-editor');
  } catch {
    // ignore
  }

  refs.outlineEditor.classList.remove('hidden');
  if (!refs.outlineEditor.querySelector('#outlineEditorContent')) {
    renderOutlineShell({ loading: true });
  }

  try {
    await mountOutlineEditor();
    const loading = refs.outlineEditor.querySelector('.outline-editor__loading');
    if (loading) loading.classList.add('hidden');
    setOutlineStatus('Только просмотр');
  } catch (error) {
    showToast(error?.message || 'Не удалось открыть публичную статью');
  }
}
  const OUTLINE_DEBUG_KEY = 'ttree_debug_outline_keys_v1';
  const outlineDebugEnabled = () => {
    try {
      return window?.localStorage?.getItem?.(OUTLINE_DEBUG_KEY) === '1';
    } catch {
      return false;
    }
  };
  const outlineDebug = (label, data = {}) => {
    try {
      if (!outlineDebugEnabled()) return;
      // eslint-disable-next-line no-console
      console.log('[outline][keys]', label, data);
    } catch {
      // ignore
    }
  };
