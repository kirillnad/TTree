import { state } from '../state.js';
import { refs } from '../refs.js';
import { showToast, showPersistentToast, hideToast } from '../toast.js';
import { extractBlockSections } from '../block.js';
import { showImagePreview } from '../modal.js?v=10';
import {
  replaceArticleBlocksTree,
  updateArticleDocJson,
  saveArticleDocJson,
  generateOutlineTitle,
  proofreadOutlineHtml,
  fetchArticlesIndex,
  uploadImageFile,
  uploadFileToYandexDisk,
} from '../api.js?v=11';
import { encryptBlockTree } from '../encryption.js';
import { hydrateUndoRedoFromArticle } from '../undo.js';
import { navigate, routing } from '../routing.js';
import { OUTLINE_ALLOWED_LINK_PROTOCOLS } from './linkProtocols.js';

let mounted = false;
let tiptap = null;
let outlineEditorInstance = null;
let mountPromise = null;
let autosaveTimer = null;
let autosaveInFlight = false;
let outlineLastSavedAt = null;
let lastActiveSectionId = null;
const committedSectionIndexText = new Map();
const dirtySectionIds = new Set();
let docDirty = false;
let onlineHandlerAttached = false;
let outlineParseHtmlToNodes = null;
let outlineGenerateHTML = null;
let outlineHtmlExtensions = null;
const titleGenState = new Map(); // sectionId -> { bodyHash: string, inFlight: boolean }
const proofreadState = new Map(); // sectionId -> { htmlHash: string, inFlight: boolean }
let outlineToolbarCleanup = null;
let outlineEditModeKey = null;
let dropGuardCleanup = null;
let outlineArticleId = null;

const OUTLINE_QUEUE_KEY = 'ttree_outline_autosave_queue_docjson_v1';
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
    const raw = window.localStorage.getItem(OUTLINE_QUEUE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeAutosaveQueue(queue) {
  try {
    window.localStorage.setItem(OUTLINE_QUEUE_KEY, JSON.stringify(queue || {}));
  } catch {
    // ignore
  }
}

function setQueuedDocJson(articleId, docJson) {
  if (!articleId) return;
  if (state.article?.encrypted) return; // не сохраняем plaintext зашифрованных статей в localStorage
  const queue = readAutosaveQueue();
  queue[String(articleId)] = {
    docJson: docJson && typeof docJson === 'object' ? docJson : null,
    queuedAt: Date.now(),
  };
  writeAutosaveQueue(queue);
}

function getQueuedDocJson(articleId) {
  const queue = readAutosaveQueue();
  const entry = queue && articleId ? queue[String(articleId)] : null;
  if (!entry || !entry.docJson || typeof entry.docJson !== 'object') return null;
  return { docJson: entry.docJson, queuedAt: Number(entry.queuedAt || 0) || 0 };
}

function clearQueuedDocJson(articleId) {
  if (!articleId) return;
  const queue = readAutosaveQueue();
  if (queue && Object.prototype.hasOwnProperty.call(queue, String(articleId))) {
    delete queue[String(articleId)];
    writeAutosaveQueue(queue);
  }
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
    textMenuBtn: root.querySelector('#outlineTextMenuBtn'),
    listsMenuBtn: root.querySelector('#outlineListsMenuBtn'),
    tableMenuBtn: root.querySelector('#outlineTableMenuBtn'),
  };
  const dropdownBtns = Array.from(root.querySelectorAll('.outline-toolbar__dropdown-btn'));
  const menus = Array.from(root.querySelectorAll('.outline-toolbar__menu'));
  const actionButtons = Array.from(root.querySelectorAll('[data-outline-action]'));

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

  const markActive = (el, active) => {
    if (!el) return;
    el.classList.toggle('is-active', Boolean(active));
    el.setAttribute('aria-pressed', active ? 'true' : 'false');
  };

  const closeAllMenus = () => {
    for (const menu of menus) menu.classList.add('hidden');
    for (const btn of dropdownBtns) btn.setAttribute('aria-expanded', 'false');
  };

  const toggleMenu = (btn) => {
    if (!btn) return;
    const menuId = btn.getAttribute('aria-controls');
    const menu = menuId ? root.querySelector(`#${menuId}`) : null;
    if (!menu) return;
    const isOpen = !menu.classList.contains('hidden');
    closeAllMenus();
    if (!isOpen) {
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
      if (action === 'addColumnBefore') return chain.addColumnBefore().run();
      if (action === 'addColumnAfter') return chain.addColumnAfter().run();
      if (action === 'deleteColumn') return chain.deleteColumn().run();
      if (action === 'mergeCells') return chain.mergeCells().run();
      if (action === 'splitCell') return chain.splitCell().run();
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
	      const mod = await import('../modal.js?v=10');
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
	      const mod = await import('../modal.js?v=10');
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
    for (const el of actionButtons) {
      const action = el.dataset.outlineAction || '';
      if (!action) continue;

      let isActive = false;
      let isDisabled = false;

      if (action === 'toggleBold') {
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
      } else if (action === 'mergeCells') {
        isActive = false;
        isDisabled = !canRun((c) => c.mergeCells());
      } else if (action === 'splitCell') {
        isActive = false;
        isDisabled = !canRun((c) => c.splitCell());
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
          if (idx <= 0) return false;
          const prevNode = parent.child(idx - 1);
          const prevStart = sectionPos - prevNode.nodeSize;
          let tr = pmState.tr.delete(sectionPos, sectionPos + sectionNode.nodeSize).insert(prevStart, sectionNode);
          tr = tr.setMeta(OUTLINE_ALLOW_META, true);
          tr = tr.setSelection(TextSelection.near(tr.doc.resolve(prevStart + 2), 1));
          dispatch(tr.scrollIntoView());
          return true;
        }
        if (dir === 'down') {
          if (idx >= parent.childCount - 1) return false;
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
    cleanups.push(click(btn, () => toggleMenu(btn)));
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
    editor.view.dispatch(tr);
    editor.view.focus?.({ preventScroll: true });
    return true;
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
  const mod = await import('./tiptap.bundle.js?v=3');
  if (t0) perfLog('import tiptap.bundle.js', { ms: Math.round(performance.now() - t0) });
  tiptap = {
    core: mod.core,
    starterKitMod: mod.starterKitMod,
    htmlMod: mod.htmlMod,
    pmStateMod: mod.pmStateMod,
    pmViewMod: mod.pmViewMod,
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

function findOutlineSectionPosAtSelection(doc, $from) {
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

function maybeProofreadOnLeave(editor, doc, sectionId) {
  if (!editor || !doc || !sectionId) return;
  if (state.article?.encrypted) return;

  const pos = findSectionPosById(doc, sectionId);
  const sectionNode = typeof pos === 'number' ? doc.nodeAt(pos) : null;
  if (!sectionNode) return;
  const bodyNode = sectionNode.child(1);
  const bodyHtml = bodyNodeToHtml(bodyNode);
  if (!bodyHtml) return;

  const htmlHash = hashTextForProofread(bodyHtml);
  const prev = proofreadState.get(sectionId) || null;
  if (prev?.inFlight) return;
  if (prev?.htmlHash === htmlHash) return;

  proofreadState.set(sectionId, { htmlHash, inFlight: true });
  proofreadOutlineHtml(bodyHtml)
    .then((res) => {
      const correctedHtml = String(res?.html || '').trim();
      if (!correctedHtml) return;
      const currentDoc = editor.state.doc;
      const currentPos = findSectionPosById(currentDoc, sectionId);
      const currentNode = typeof currentPos === 'number' ? currentDoc.nodeAt(currentPos) : null;
      if (!currentNode) return;
      const currentBodyHtml = bodyNodeToHtml(currentNode.child(1));
      if (hashTextForProofread(currentBodyHtml) !== htmlHash) return;
      if (hashTextForProofread(correctedHtml) === htmlHash) return;
      const applied = applyBodyHtmlToSection(editor, sectionId, correctedHtml);
      if (!applied) return;
      docDirty = true;
      scheduleAutosave({ delayMs: 900 });
    })
    .catch(() => {})
    .finally(() => {
      proofreadState.set(sectionId, { htmlHash, inFlight: false });
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
    await saveOutlineEditor({ silent: true });
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
  const { Editor, Node, Extension, mergeAttributes } = core;
  const StarterKit = starterKitMod.default || starterKitMod.StarterKit || starterKitMod;
  const { generateJSON, generateHTML } = htmlMod;
  const { TextSelection } = pmStateMod;
  const { Plugin, PluginKey } = pmStateMod;
		  const { Decoration, DecorationSet } = pmViewMod;
	  const Link = tiptap.linkMod.default || tiptap.linkMod.Link || tiptap.linkMod;
	  const Image = tiptap.imageMod.default || tiptap.imageMod.Image || tiptap.imageMod;
	  const TableKit = tiptap.tableMod.TableKit || tiptap.tableMod.tableKit;
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

	  const findImagePosByUploadToken = (doc, token) => {
	    let found = null;
	    if (!token) return null;
	    doc.descendants((node, pos) => {
	      if (found !== null) return false;
	      if (node?.type?.name !== 'image') return;
	      if (String(node.attrs?.uploadToken || '') !== String(token)) return;
	      found = pos;
	    });
	    return found;
	  };

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

	        uploadImageFile(file)
	          .then((res) => {
	            const url = String(res?.url || '').trim();
	            try {
	              URL.revokeObjectURL(objectUrl);
	            } catch {
	              // ignore
	            }
	            if (!url) throw new Error('Upload failed');
	            const pos = findImagePosByUploadToken(view.state.doc, token);
	            if (typeof pos !== 'number') return;
	            const node = view.state.doc.nodeAt(pos);
	            if (!node || node.type?.name !== 'image') return;
	            const nextAttrs = { ...node.attrs, src: url, uploadToken: null };
	            let tr2 = view.state.tr.setNodeMarkup(pos, undefined, nextAttrs);
	            tr2 = tr2.setMeta(OUTLINE_ALLOW_META, true);
	            view.dispatch(tr2);
	          })
	          .catch((err) => {
	            try {
	              URL.revokeObjectURL(objectUrl);
	            } catch {
	              // ignore
	            }
	            showToast(err?.message || 'Не удалось загрузить изображение');
	            // Remove placeholder if still present.
	            try {
	              const pos = findImagePosByUploadToken(view.state.doc, token);
	              if (typeof pos !== 'number') return;
	              let tr2 = view.state.tr.delete(pos, pos + 1);
	              tr2 = tr2.setMeta(OUTLINE_ALLOW_META, true);
	              view.dispatch(tr2);
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
  });

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

        const updateUi = () => {
          const headingPos = typeof getPos === 'function' ? getPos() : null;
          if (typeof headingPos !== 'number') return;
          const sectionPos = headingPos - 1;
          const sectionNode = editor.state.doc.nodeAt(sectionPos);
          dom.dataset.empty = node.content.size === 0 ? 'true' : 'false';
          const $pos = editor.state.doc.resolve(Math.max(0, sectionPos + 1));
          let depth = 0;
          for (let d = $pos.depth; d >= 0; d -= 1) {
            if ($pos.node(d)?.type?.name === 'outlineSection') depth += 1;
          }
          dom.dataset.depth = String(Math.min(6, Math.max(1, depth || 1)));
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
          const tr = editor.state.tr.setNodeMarkup(sectionPos, undefined, {
            ...sectionNode.attrs,
            collapsed: next,
          });
          tr.setMeta(OUTLINE_ALLOW_META, true);
          editor.view.dispatch(tr);
          editor.view.focus();
        });

        dom.appendChild(toggle);
        dom.appendChild(contentDOM);
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
        const $pos = pmState.doc.resolve(sectionPos);
        const idx = $pos.index();
        const parent = $pos.parent;
        if (!parent) return false;
        if (parent.childCount <= 1) {
          // Нельзя удалить последнюю секцию — просто очищаем.
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
            if (idx <= 0) return false;
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
          if (dir === 'down') {
            if (idx >= parent.childCount - 1) return false;
            const nextStart = sectionPos + sectionNode.nodeSize;
            const nextNode = pmState.doc.nodeAt(nextStart);
            if (!nextNode) return false;
            const tr = pmState.tr.delete(sectionPos, sectionPos + sectionNode.nodeSize).setMeta(OUTLINE_ALLOW_META, true);
            const insertPos = sectionPos + nextNode.nodeSize;
            tr.insert(insertPos, sectionNode);
            const sel = TextSelection.near(tr.doc.resolve(insertPos + 2), 1);
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
          const tr = pmState.tr
            .setNodeMarkup(sectionPos, undefined, { ...sectionNode.attrs, collapsed: next })
            .setMeta(OUTLINE_ALLOW_META, true);
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
        'Alt-ArrowUp': () => moveSection('up'),
        'Alt-ArrowDown': () => moveSection('down'),
        'Alt-ArrowRight': () => indentSection(),
        'Alt-ArrowLeft': () => outdentSection(),
        'Mod-ArrowRight': () => toggleCollapsed(false),
        'Mod-ArrowLeft': () => toggleCollapsed(true),
        // Ctrl+↑: схлопнуть родителя (и всё внутри него)
        'Mod-ArrowUp': () => collapseParentSubtree(),
        // Ctrl+↓: развернуть текущую секцию (и всех её детей)
        'Mod-ArrowDown': () => expandCurrentSubtree(),
        // Ctrl+Enter: split секции в позиции курсора (children → в новую секцию)
        'Mod-Enter': () => splitSectionAtCaret(),
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
          if ($from.parent?.type?.name !== 'outlineHeading') return false;
          if ($from.parentOffset !== 0) return false;

          const sectionPos = findOutlineSectionPosAtSelection(pmState.doc, $from);
          if (typeof sectionPos !== 'number') return false;
          const $pos = pmState.doc.resolve(sectionPos);
          const idx = $pos.index();
          if (idx > 0) return true; // есть previous sibling

          // Нет previous sibling — merge в body родителя (если есть родитель-секция)
          for (let d = $from.depth - 1; d > 0; d -= 1) {
            if ($from.node(d)?.type?.name === 'outlineSection') return true;
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
              const activeSectionId = getActiveSectionId(pmState);

              // Сбрасываем pending merge при смене секции/любой другой клавише.
              if (!pendingMerge || pendingMerge.sectionId !== activeSectionId || pendingMerge.key !== event.key) {
                pendingMerge = null;
              }

	              if (state.isPublicView && !editingSectionId && (event.key === 'Enter' || event.key === 'F2')) {
	                event.preventDefault();
	                event.stopPropagation();
	                return true;
	              }

	              if (!editingSectionId && (event.key === 'Enter' || event.key === 'F2')) {
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
		      OutlineActiveSection,
		      OutlineEditMode,
		      OutlineImageUpload,
		      OutlineAttachmentUpload,
		      OutlineImageResize,
	      OutlineImagePreview,
	      OutlineMarkdownTablePaste,
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
	      TableKit.configure({ table: { resizable: true } }),
	      OutlineMarkdown,
    ].filter(Boolean),
    content,
    editorProps: {
      attributes: {
        class: 'outline-prosemirror',
      },
      handleKeyDown(view, event) {
        // В view-mode Enter/F2 должны ВСЕГДА включать режим редактирования текущей секции,
        // даже когда курсор стоит внутри listItem (иначе list keymap "съедает" Enter).
        try {
          if (!outlineEditModeKey) return false;
          const st = outlineEditModeKey.getState(view.state) || {};
          const editingSectionId = st.editingSectionId || null;

          if (!editingSectionId) {
            const isDelete = event.key === 'Backspace' || event.key === 'Delete';
            const isTextInput = event.key && event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey;
            if (isDelete || isTextInput) {
              event.preventDefault();
              event.stopPropagation();
              notifyReadOnlyGlobal();
              return true;
            }
          }

	          if (state.isPublicView && !editingSectionId && (event.key === 'Enter' || event.key === 'F2')) {
	            event.preventDefault();
	            event.stopPropagation();
	            return true;
	          }

	          if (!editingSectionId && (event.key === 'Enter' || event.key === 'F2')) {
	            const sectionPos = findOutlineSectionPosAtSelection(view.state.doc, view.state.selection.$from);
	            if (typeof sectionPos !== 'number') return false;
	            const sectionNode = view.state.doc.nodeAt(sectionPos);
            const sectionId = String(sectionNode?.attrs?.id || '');
            if (!sectionId) return false;
            event.preventDefault();
            event.stopPropagation();
            view.dispatch(view.state.tr.setMeta(outlineEditModeKey, { type: 'enter', sectionId }));
            return true;
          }

          if (editingSectionId && event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            const sectionId = editingSectionId;
            view.dispatch(view.state.tr.setMeta(outlineEditModeKey, { type: 'exit' }));
            // Выход из режима редактирования тоже считаем "уходом" из секции
            // для автозаголовка и proofreading (если были изменения).
            try {
              const tiptapEditor = outlineEditorInstance;
              if (tiptapEditor && !tiptapEditor.isDestroyed) {
                maybeGenerateTitleOnLeave(tiptapEditor, view.state.doc, sectionId);
                const changed = markSectionDirtyIfChanged(view.state.doc, sectionId);
                if (changed) {
                  maybeProofreadOnLeave(tiptapEditor, view.state.doc, sectionId);
                  scheduleAutosave({ delayMs: 350 });
                }
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

            // Включаем edit-mode по dblclick только по заголовку секции.
            const inHeading =
              (event?.target && event.target.closest && event.target.closest('[data-outline-heading="true"]')) ||
              (event?.target && event.target.closest && event.target.closest('.outline-heading'));
            if (!inHeading) return false;

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

                tr = tr.setMeta(outlineEditModeKey, { type: 'enter', sectionId });

                // Ставим курсор в начало body секции.
                try {
                  const nodeAfter = typeof currentPos === 'number' ? tr.doc.nodeAt(currentPos) : null;
                  if (nodeAfter && nodeAfter.type?.name === 'outlineSection') {
                    const heading = nodeAfter.child(0);
                    const bodyStart = currentPos + 1 + heading.nodeSize;
                    const posInBody = Math.min(tr.doc.content.size, bodyStart + 1);
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
      setOutlineStatus('');
    },
    onUpdate: () => {
      // Любое изменение документа считается изменением текущей секции (или нескольких),
      // но “коммит секции” мы делаем при уходе из неё (onSelectionUpdate).
      docDirty = true;
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
        try {
          maybeGenerateTitleOnLeave(editor, pmState.doc, lastActiveSectionId);
        } catch {
          // ignore
        }
        const changed = markSectionDirtyIfChanged(pmState.doc, lastActiveSectionId);
        if (changed) {
          try {
            maybeProofreadOnLeave(editor, pmState.doc, lastActiveSectionId);
          } catch {
            // ignore
          }
          // Ушли из секции — стараемся сохранить быстрее, чтобы история “секции” была естественной.
          scheduleAutosave({ delayMs: 350 });
        }
      }
      lastActiveSectionId = sectionId;
    },
	  });
		  if (createStart) perfLog('new Editor()', { ms: Math.round(performance.now() - createStart) });

  contentRoot.focus?.({ preventScroll: true });

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
  try {
    if (!silent) showPersistentToast('Сохраняем outline…');
    if (state.article.encrypted) {
      if (!silent) {
        hideToast();
        showToast('Outline-сохранение docJson недоступно для зашифрованных статей');
      }
      return;
    }
    const docJson = outlineEditorInstance.getJSON();
    // Guard: if state.articleId already switched to another article, never write inbox docJson into it.
    if (state.articleId && targetArticleId !== state.articleId) {
      try {
        setQueuedDocJson(targetArticleId, docJson);
      } catch {
        // ignore
      }
      if (!silent) hideToast();
      setOutlineStatus('Оффлайн: черновик сохранён локально');
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
    clearQueuedDocJson(targetArticleId);
    outlineLastSavedAt = new Date();
    setOutlineStatus(isQueued ? 'Оффлайн: в очереди на синхронизацию' : `Сохранено ${formatTimeShort(outlineLastSavedAt)}`);
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
      if (docJson && typeof docJson === 'object') setQueuedDocJson(targetArticleId, docJson);
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
  refs.outlineEditor.classList.remove('hidden');
  refs.blocksContainer.classList.add('hidden');
  renderOutlineShell({ loading: true });

  // Если есть отложенный черновик (предыдущий автосейв не ушёл) — подхватываем.
  const queued = getQueuedDocJson(outlineArticleId);
  if (queued && state.article && !state.article.encrypted) {
    const serverUpdatedAt = Date.parse(state.article.updatedAt || '') || 0;
    const hasServerDoc =
      state.article.docJson &&
      typeof state.article.docJson === 'object' &&
      Array.isArray(state.article.docJson.content) &&
      state.article.docJson.content.length > 0;
    const shouldApply =
      !hasServerDoc || (queued.queuedAt && serverUpdatedAt && queued.queuedAt > serverUpdatedAt);
    if (shouldApply && queued.docJson && typeof queued.docJson === 'object') {
      state.article.docJson = queued.docJson;
    } else if (queued.queuedAt && serverUpdatedAt && queued.queuedAt <= serverUpdatedAt) {
      // Stale local draft: don't let it override server content.
      clearQueuedDocJson(outlineArticleId);
    }
  }

	  try {
	    await mountOutlineEditor();
    try {
      mountOutlineToolbar(outlineEditorInstance);
    } catch {
      // ignore
    }
    // При входе в outline ставим курсор в начало body текущей секции,
    // чтобы не приходилось "тыкать мышкой".
    try {
      moveCursorToActiveSectionBodyStart(outlineEditorInstance);
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

	    // Если есть очередь, пробуем сохранить сразу.
		    if (outlineArticleId && getQueuedDocJson(outlineArticleId)) {
		      void runAutosave({ force: true });
		    }
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
  if (dropGuardCleanup) dropGuardCleanup();
  if (refs.outlineToolbar) refs.outlineToolbar.classList.add('hidden');
  if (refs.articleToolbar) refs.articleToolbar.classList.remove('hidden');
  if (autosaveTimer) {
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
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
        setQueuedDocJson(targetArticleId, docJson);
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
