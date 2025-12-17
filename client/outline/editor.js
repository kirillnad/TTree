import { state } from '../state.js';
import { refs } from '../refs.js';
import { showToast, showPersistentToast, hideToast } from '../toast.js';
import { extractBlockSections } from '../block.js';
import { replaceArticleBlocksTree } from '../api.js?v=2';
import { renderArticle } from '../article.js';
import { encryptBlockTree } from '../encryption.js';

let mounted = false;
let tiptap = null;
let outlineEditorInstance = null;

function stripHtml(html = '') {
  const tmp = document.createElement('div');
  tmp.innerHTML = html || '';
  return (tmp.textContent || '').replace(/\u00a0/g, ' ').trim();
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
      <div class="outline-editor__actions">
        <button type="button" class="ghost small" data-outline-action="save" ${loading ? 'disabled' : ''}>Сохранить</button>
        <button type="button" class="ghost small" data-outline-action="cancel">Закрыть</button>
      </div>
    </div>
    <div class="outline-editor__body">
      <div class="outline-editor__content" id="outlineEditorContent"></div>
      <div class="outline-editor__loading ${loading ? '' : 'hidden'}">Загружаем редактор…</div>
    </div>
  `;
  if (!mounted) {
    mounted = true;
    refs.outlineEditor.addEventListener('click', (event) => {
      const btn = event.target?.closest?.('button[data-outline-action]');
      if (!btn) return;
      const action = btn.dataset.outlineAction;
      if (action === 'cancel') {
        closeOutlineEditor();
        return;
      }
      if (action === 'save') {
        saveOutlineEditor();
      }
    });
  }
}

async function loadTiptap() {
  if (tiptap) return tiptap;
  if (typeof window === 'undefined') {
    throw new Error('Outline editor is browser-only');
  }
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
  ] = await Promise.all([
    import('https://esm.sh/@tiptap/core?bundle'),
    import('https://esm.sh/@tiptap/starter-kit?bundle'),
    import('https://esm.sh/@tiptap/html?bundle'),
    import('https://esm.sh/@tiptap/pm/state?bundle'),
    import('https://esm.sh/@tiptap/extension-link?bundle'),
    import('https://esm.sh/@tiptap/extension-image?bundle'),
    import('https://esm.sh/@tiptap/extension-table?bundle'),
    import('https://esm.sh/@tiptap/extension-table-row?bundle'),
    import('https://esm.sh/@tiptap/extension-table-cell?bundle'),
    import('https://esm.sh/@tiptap/extension-table-header?bundle'),
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

async function mountOutlineEditor() {
  if (!refs.outlineEditor) return;
  const contentRoot = refs.outlineEditor.querySelector('#outlineEditorContent');
  if (!contentRoot) {
    showToast('Не удалось смонтировать outline-редактор');
    return;
  }

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
        toggle.title = 'Свернуть/развернуть (Shift+←/→)';
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
        id: { default: null },
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
          const tr = pmState.tr.delete(sectionPos, sectionPos + sectionNode.nodeSize).insert(insertPos, sectionNode);
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

      return {
        'Mod-ArrowUp': () => moveSection('up'),
        'Mod-ArrowDown': () => moveSection('down'),
        'Mod-ArrowRight': () => indentSection(),
        'Mod-ArrowLeft': () => outdentSection(),
        'Shift-ArrowRight': () => toggleCollapsed(false),
        'Shift-ArrowLeft': () => toggleCollapsed(true),
        Backspace: () =>
          this.editor.commands.command(({ state: pmState, dispatch }) => {
            const { selection } = pmState;
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
              tr = tr.setSelection(TextSelection.near(tr.doc.resolve(bodyStart + 1), 1));
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

            let tr = pmState.tr;
            if (!bodyNode.childCount) {
              const schema = pmState.doc.type.schema;
              tr = tr.insert(bodyStart + 1, schema.nodes.paragraph.create({}, []));
            }
            tr = tr.setSelection(TextSelection.near(tr.doc.resolve(bodyStart + 1), 1));
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
            const $pos = pmState.doc.resolve(sectionPos);
            const idx = $pos.index();
            const parent = $pos.parent;
            if (!parent || idx <= 0) return false;
            const prevNode = parent.child(idx - 1);
            const prevStart = sectionPos - prevNode.nodeSize;
            const prevSection = pmState.doc.nodeAt(prevStart);
            if (!prevSection) return false;
            const prevHeading = prevSection.child(0);
            const prevBody = prevSection.child(1);
            const bodyStart = prevStart + 1 + prevHeading.nodeSize;
            const bodyEnd = bodyStart + prevBody.nodeSize - 1;
            const tr = pmState.tr.setSelection(TextSelection.near(pmState.doc.resolve(bodyEnd), -1));
            dispatch(tr.scrollIntoView());
            return true;
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
              tr = tr.setSelection(TextSelection.near(tr.doc.resolve(insertPos + 2), 1));
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

  const content = buildOutlineDocFromBlocks({
    blocks: state.article?.blocks || [],
    parseHtmlToNodes,
  });

  outlineEditorInstance = new Editor({
    element: contentRoot,
    extensions: [
      OutlineDocument,
      OutlineSection,
      OutlineHeading,
      OutlineBody,
      OutlineChildren,
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
  });

  contentRoot.focus?.({ preventScroll: true });
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

async function saveOutlineEditor() {
  if (!state.articleId || !state.article) return;
  if (!outlineEditorInstance) return;
  try {
    showPersistentToast('Сохраняем outline…');
    const blocksPlain = serializeOutlineToBlocks();
    if (!blocksPlain.length) {
      hideToast();
      showToast('Нечего сохранять');
      return;
    }
    const blocksForServer = JSON.parse(JSON.stringify(blocksPlain));
    if (state.article.encrypted) {
      const key = state.articleEncryptionKeys?.[state.articleId] || null;
      if (!key) {
        hideToast();
        showToast('Не найден ключ шифрования для статьи');
        return;
      }
      await encryptBlockTree(blocksForServer, key);
    }
    const result = await replaceArticleBlocksTree(state.articleId, blocksForServer);
    hideToast();
    if (state.article) {
      state.article.blocks = blocksPlain;
      if (result?.updatedAt) {
        state.article.updatedAt = result.updatedAt;
      }
    }
    closeOutlineEditor();
    renderArticle();
    showToast('Статья сохранена');
  } catch (error) {
    hideToast();
    showToast(error?.message || 'Не удалось сохранить outline');
  }
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
  try {
    await mountOutlineEditor();
    const loading = refs.outlineEditor.querySelector('.outline-editor__loading');
    if (loading) loading.classList.add('hidden');
    const saveBtn = refs.outlineEditor.querySelector('button[data-outline-action="save"]');
    if (saveBtn) saveBtn.disabled = false;
  } catch (error) {
    showToast(error?.message || 'Не удалось загрузить outline-редактор');
    closeOutlineEditor();
  }
}

export function closeOutlineEditor() {
  state.isOutlineEditing = false;
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
