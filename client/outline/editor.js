import { state } from '../state.js';
import { refs } from '../refs.js';
import { showToast, showPersistentToast, hideToast } from '../toast.js';
import { extractBlockSections } from '../block.js';
import { replaceArticleBlocksTree, updateArticleDocJson } from '../api.js?v=5';
import { encryptBlockTree } from '../encryption.js';
import { hydrateUndoRedoFromArticle } from '../undo.js';

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

const OUTLINE_QUEUE_KEY = 'ttree_outline_autosave_queue_v1';

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

function setQueuedBlocks(articleId, blocksPlain) {
  if (!articleId) return;
  if (state.article?.encrypted) return; // не сохраняем plaintext зашифрованных статей в localStorage
  const queue = readAutosaveQueue();
  queue[String(articleId)] = {
    blocks: Array.isArray(blocksPlain) ? blocksPlain : [],
    queuedAt: Date.now(),
  };
  writeAutosaveQueue(queue);
}

function getQueuedBlocks(articleId) {
  const queue = readAutosaveQueue();
  const entry = queue && articleId ? queue[String(articleId)] : null;
  if (!entry || !Array.isArray(entry.blocks)) return null;
  return entry.blocks;
}

function clearQueuedBlocks(articleId) {
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

function safeUuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `sec-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function renderOutlineShell({ loading = false } = {}) {
  if (!refs.outlineEditor) return;
  refs.outlineEditor.innerHTML = `
    <div class="outline-editor__bar">
      <div class="outline-editor__title">Outline редактор</div>
      <div class="outline-editor__status" data-outline-status="true"></div>
    </div>
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

function formatTimeShort(date) {
  try {
    return new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date);
  } catch {
    return '';
  }
}

function setOutlineStatus(text = '') {
  const el = refs.outlineEditor?.querySelector?.('[data-outline-status="true"]');
  if (!el) return;
  el.textContent = text || '';
}

async function loadTiptap() {
  if (tiptap) return tiptap;
  if (typeof window === 'undefined') {
    throw new Error('Outline editor is browser-only');
  }
  // Важно: не используем `?bundle` в esm.sh, иначе можно получить несколько копий
  // prosemirror-* и ошибку вида "Adding different instances of a keyed plugin (plugin$)".
  const [
    core,
    starterKitMod,
    htmlMod,
    pmStateMod,
    linkMod,
    imageMod,
    tableMod,
    tableRowMod,
    tableCellMod,
    tableHeaderMod,
    uniqueIdMod,
  ] = await Promise.all([
    import('https://esm.sh/@tiptap/core'),
    import('https://esm.sh/@tiptap/starter-kit'),
    import('https://esm.sh/@tiptap/html'),
    import('https://esm.sh/@tiptap/pm/state'),
    import('https://esm.sh/@tiptap/extension-link'),
    import('https://esm.sh/@tiptap/extension-image'),
    import('https://esm.sh/@tiptap/extension-table'),
    import('https://esm.sh/@tiptap/extension-table-row'),
    import('https://esm.sh/@tiptap/extension-table-cell'),
    import('https://esm.sh/@tiptap/extension-table-header'),
    import('https://esm.sh/@tiptap/extension-unique-id'),
  ]);

  tiptap = {
    core,
    starterKitMod,
    htmlMod,
    pmStateMod,
    linkMod,
    imageMod,
    tableMod,
    tableRowMod,
    tableCellMod,
    tableHeaderMod,
    uniqueIdMod,
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
    const titleText = stripHtml(sections.titleHtml) || stripHtml(sections.bodyHtml).slice(0, 80) || 'Без названия';
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
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    autosaveTimer = null;
    void runAutosave();
  }, Math.max(200, delayMs));
}

async function runAutosave({ force = false } = {}) {
  if (!state.isOutlineEditing) return;
  if (!outlineEditorInstance) return;
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
  const { core, starterKitMod, htmlMod, pmStateMod } = await loadTiptap();
  const { Editor, Node, Extension, mergeAttributes } = core;
  const StarterKit = starterKitMod.default || starterKitMod.StarterKit || starterKitMod;
  const { generateJSON, generateHTML } = htmlMod;
  const { TextSelection } = pmStateMod;
  const { Plugin } = pmStateMod;
  const Link = tiptap.linkMod.default || tiptap.linkMod.Link || tiptap.linkMod;
  const Image = tiptap.imageMod.default || tiptap.imageMod.Image || tiptap.imageMod;
  const Table = tiptap.tableMod.default || tiptap.tableMod.Table || tiptap.tableMod;
  const TableRow = tiptap.tableRowMod.default || tiptap.tableRowMod.TableRow || tiptap.tableRowMod;
  const TableCell = tiptap.tableCellMod.default || tiptap.tableCellMod.TableCell || tiptap.tableCellMod;
  const TableHeader = tiptap.tableHeaderMod.default || tiptap.tableHeaderMod.TableHeader || tiptap.tableHeaderMod;
  const UniqueID = tiptap.uniqueIdMod.default || tiptap.uniqueIdMod.UniqueID || tiptap.uniqueIdMod;

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
          const tr = pmState.tr.replaceWith(sectionPos, sectionPos + sectionNode.nodeSize, newSection);
          dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(sectionPos + 2), 1)).scrollIntoView());
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
            const bodyEnd = bodyStart + prevBody.nodeSize - 1;
            tr = tr.setSelection(TextSelection.near(tr.doc.resolve(bodyEnd), -1));
          }
        } else {
          const nextSection = tr.doc.nodeAt(sectionPos < tr.doc.content.size ? sectionPos : nextStart);
          if (nextSection) {
            tr = tr.setSelection(TextSelection.near(tr.doc.resolve(sectionPos + 2), 1));
          }
        }
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
        const currentBody = sectionNode.child(1);
        const currentChildren = sectionNode.child(2);

        let tr = pmState.tr.delete(sectionPos, sectionPos + sectionNode.nodeSize);
        const prevSection = tr.doc.nodeAt(prevStart);
        if (!prevSection) {
          dispatch(tr.scrollIntoView());
          return true;
        }
        const schema = tr.doc.type.schema;
        const prevHeading = prevSection.child(0);
        const prevBody = prevSection.child(1);
        const prevChildren = prevSection.child(2);

        const mergedBodyContent = prevBody.content.append(currentBody.content);
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
            const tr = pmState.tr.delete(sectionPos, sectionPos + sectionNode.nodeSize).insert(prevStart, sectionNode);
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
            const tr = pmState.tr.delete(sectionPos, sectionPos + sectionNode.nodeSize);
            const insertPos = sectionPos + nextNode.nodeSize;
            tr.insert(insertPos, sectionNode);
            const sel = TextSelection.near(tr.doc.resolve(insertPos + 2), 1);
            tr.setSelection(sel);
            dispatch(tr.scrollIntoView());
            return true;
          }
          return false;
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
          let tr = pmState.tr.delete(sectionPos, sectionPos + sectionNode.nodeSize).insert(insertPos, sectionNode);
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
          const tr = pmState.tr.delete(sectionPos, sectionPos + sectionNode.nodeSize);
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
          const tr = pmState.tr.setNodeMarkup(sectionPos, undefined, { ...sectionNode.attrs, collapsed: next });
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
        Backspace: () =>
          this.editor.commands.command(({ state: pmState, dispatch }) => {
            const { selection } = pmState;
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
            return mergeSectionIntoPrevious(pmState, dispatch, sectionPos);
          }),
        Delete: () =>
          this.editor.commands.command(({ state: pmState, dispatch }) => {
            const { selection } = pmState;
            if (clampCrossSectionDeletionToBody(pmState, dispatch)) return true;
            if (!selection?.empty) return false;
            const { $from } = selection;
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

            // Enter в начале заголовка: вставляем новый блок выше текущего
            // и ставим курсор в начало нового заголовка.
            if ($from.parentOffset === 0) {
              const schema = pmState.doc.type.schema;
              const newSection = schema.nodes.outlineSection.create(
                { id: safeUuid(), collapsed: false },
                [
                  schema.nodes.outlineHeading.create({}, []),
                  schema.nodes.outlineBody.create({}, [schema.nodes.paragraph.create({}, [])]),
                  schema.nodes.outlineChildren.create({}, []),
                ],
              );
              let tr = pmState.tr.insert(sectionPos, newSection);
              tr = tr.setSelection(TextSelection.create(tr.doc, sectionPos + 2));
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
              view.dispatch(tr.scrollIntoView());
              return true;
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
      }),
      Image,
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
    ]);
    return Array.isArray(tmp?.content) ? tmp.content : [];
  };
  outlineParseHtmlToNodes = parseHtmlToNodes;

  let shouldBootstrapDocJson = false;
  let content = null;
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

  if (outlineEditorInstance) {
    try {
      outlineEditorInstance.destroy();
    } catch {
      // ignore
    }
    outlineEditorInstance = null;
  }

  outlineEditorInstance = new Editor({
    element: contentRoot,
    extensions: [
      OutlineDocument,
      OutlineSection,
      OutlineHeading,
      OutlineBody,
      OutlineChildren,
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
      }),
      Image,
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
      OutlineCommands,
    ],
    content,
    editorProps: {
      attributes: {
        class: 'outline-prosemirror',
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
      if (lastActiveSectionId && lastActiveSectionId !== sectionId) {
        const changed = markSectionDirtyIfChanged(pmState.doc, lastActiveSectionId);
        if (changed) {
          // Ушли из секции — стараемся сохранить быстрее, чтобы история “секции” была естественной.
          scheduleAutosave({ delayMs: 350 });
        }
      }
      lastActiveSectionId = sectionId;
    },
  });

  contentRoot.focus?.({ preventScroll: true });
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
  const Table = tiptap.tableMod.default || tiptap.tableMod.Table || tiptap.tableMod;
  const TableRow = tiptap.tableRowMod.default || tiptap.tableRowMod.TableRow || tiptap.tableRowMod;
  const TableCell = tiptap.tableCellMod.default || tiptap.tableCellMod.TableCell || tiptap.tableCellMod;
  const TableHeader = tiptap.tableHeaderMod.default || tiptap.tableHeaderMod.TableHeader || tiptap.tableHeaderMod;

  const htmlExtensions = [
    StarterKit.configure({ heading: false, link: false }),
    Link.configure({ openOnClick: false }),
    Image,
    Table.configure({ resizable: true }),
    TableRow,
    TableHeader,
    TableCell,
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
  if (!state.articleId || !state.article) return;
  if (!outlineEditorInstance) return;
  const silent = Boolean(options.silent);
  try {
    if (!silent) showPersistentToast('Сохраняем outline…');
    const blocksPlain = serializeOutlineToBlocks();
    if (!blocksPlain.length) {
      if (!silent) {
        hideToast();
        showToast('Нечего сохранять');
      }
      return;
    }
    const blocksForServer = JSON.parse(JSON.stringify(blocksPlain));
    if (state.article.encrypted) {
      const key = state.articleEncryptionKeys?.[state.articleId] || null;
      if (!key) {
        if (!silent) {
          hideToast();
          showToast('Не найден ключ шифрования для статьи');
        }
        return;
      }
      await encryptBlockTree(blocksForServer, key);
    }
    const result = await replaceArticleBlocksTree(state.articleId, blocksForServer, {
      createVersionIfStaleHours: 12,
      // Никогда не отправляем plaintext docJson для зашифрованных статей.
      docJson: state.article.encrypted ? null : outlineEditorInstance.getJSON(),
    });
    if (!silent) hideToast();
    if (state.article) {
      state.article.blocks = blocksPlain;
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
    clearQueuedBlocks(state.articleId);
    outlineLastSavedAt = new Date();
    setOutlineStatus(`Сохранено ${formatTimeShort(outlineLastSavedAt)}`);
  } catch (error) {
    if (!silent) {
      hideToast();
      showToast(error?.message || 'Не удалось сохранить outline');
    } else {
      setOutlineStatus('Ошибка сохранения');
    }
    // Сохраняем в локальную очередь, чтобы догнать позже.
    try {
      const blocksPlain = serializeOutlineToBlocks();
      if (blocksPlain?.length) setQueuedBlocks(state.articleId, blocksPlain);
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

export async function openOutlineEditor() {
  if (state.isPublicView || state.isRagView) {
    showToast('Outline-редактор недоступен в этом режиме');
    return;
  }
  if (!state.articleId || !state.article) {
    showToast('Сначала откройте статью');
    return;
  }
  if (!refs.outlineEditor || !refs.blocksContainer) {
    showToast('Не удалось открыть outline-редактор');
    return;
  }
  state.isOutlineEditing = true;
  refs.outlineEditor.classList.remove('hidden');
  refs.blocksContainer.classList.add('hidden');
  renderOutlineShell({ loading: true });

  // Если есть отложенный черновик (предыдущий автосейв не ушёл) — подхватываем.
  const queued = getQueuedBlocks(state.articleId);
  if (queued && Array.isArray(queued) && queued.length && state.article && !state.article.encrypted) {
    state.article.blocks = queued;
  }

  try {
    await mountOutlineEditor();
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

    // Если есть очередь, пробуем сохранить сразу.
    if (getQueuedBlocks(state.articleId)) {
      void runAutosave({ force: true });
    }
  } catch (error) {
    showToast(error?.message || 'Не удалось загрузить outline-редактор');
    closeOutlineEditor();
  }
}

export function closeOutlineEditor() {
  state.isOutlineEditing = false;
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

export async function flushOutlineAutosave() {
  if (!state.isOutlineEditing) return;
  if (!outlineEditorInstance) return;
  if (autosaveTimer) {
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
  }
  await runAutosave({ force: true });
}
