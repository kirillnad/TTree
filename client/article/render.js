// Вынесено из `article.js`: отрисовка блоков статьи и DOM-утилиты.

import { state } from '../state.js';
import { refs } from '../refs.js';
import { apiRequest, fetchArticlesIndex } from '../api.js?v=12';
import { showToast } from '../toast.js';
import { showPrompt } from '../modal.js?v=10';
import { startEditing, saveEditing, cancelEditing, createSibling } from '../actions.js';
import { placeCaretAtEnd, placeCaretAtStart } from '../utils.js';
import {
  findBlock,
  flattenVisible,
  extractBlockSections,
  buildEditableBlockHtml,
  toggleCollapse,
  setCurrentBlock,
  insertFilesIntoEditable,
} from '../block.js';
import { attachRichContentHandlers } from '../block.js';
import { renderSidebarArticleList } from '../sidebar.js';
import { applyPendingPreviewMarkup } from '../undo.js';
import { navigate, routing } from '../routing.js';
import { updateArticleHeaderUi } from './header.js';
import { registerBlockDragSource, updateDragModeUi, clearDragLayer, ensureDragLayer } from './dnd.js';

let moveBlockFromInboxHandler = null;

export function setMoveBlockFromInboxHandler(handler) {
  moveBlockFromInboxHandler = typeof handler === 'function' ? handler : null;
}

function dedupeBlocksById(blocks) {
  const seen = new Set();
  const visit = (list) => {
    if (!Array.isArray(list)) return;
    for (let i = 0; i < list.length; i += 1) {
      const block = list[i];
      if (!block || !block.id) {
        list.splice(i, 1);
        i -= 1;
        continue;
      }
      if (seen.has(block.id)) {
        list.splice(i, 1);
        i -= 1;
        continue;
      }
      seen.add(block.id);
      if (Array.isArray(block.children) && block.children.length) {
        visit(block.children);
      }
    }
  };
  visit(blocks);
}

function cleanupDomBlockDuplicates() {
  if (!refs.blocksContainer) return;
  const seen = new Set();
  const blocks = refs.blocksContainer.querySelectorAll('.block[data-block-id]');
  blocks.forEach((el) => {
    const id = el.getAttribute('data-block-id');
    if (!id) return;
    if (seen.has(id)) {
      const parent = el.parentNode;
      if (parent) {
        parent.removeChild(el);
      }
    } else {
      seen.add(id);
    }
  });
}

function cleanupOrphanDomBlocks() {
  if (!refs.blocksContainer) return;
  if (!state.article || !Array.isArray(state.article.blocks)) return;
  const visible = flattenVisible(state.article.blocks);
  const allowed = new Set(visible.map((b) => b.id));
  const blocks = refs.blocksContainer.querySelectorAll('.block[data-block-id]');
  blocks.forEach((el) => {
    const id = el.getAttribute('data-block-id');
    if (!id) return;
    if (!allowed.has(id)) {
      const parent = el.parentNode;
      if (parent) {
        parent.removeChild(el);
      }
    }
  });
}

export function pushLocalBlockTrashEntry(block, parentId, index, deletedAtIso) {
  if (!state.article || !block || !block.id) return;
  const list = Array.isArray(state.article.blockTrash) ? state.article.blockTrash : [];
  const deletedAt = deletedAtIso || new Date().toISOString();
  list.push({
    id: block.id,
    block,
    parentId: parentId || null,
    index: typeof index === 'number' ? index : null,
    deletedAt,
  });
  state.article.blockTrash = list;
}

export function removeDomBlockById(blockId) {
  if (!blockId || !refs.blocksContainer) return;
  const blocks = refs.blocksContainer.querySelectorAll(`.block[data-block-id="${blockId}"]`);
  blocks.forEach((blockEl) => {
    const container = blockEl.parentElement;
    if (!container) return;
    let cursor = blockEl.nextElementSibling;
    if (cursor && cursor.classList.contains('block-children')) {
      const extra = cursor;
      cursor = cursor.nextElementSibling;
      if (extra.parentNode === container) {
        container.removeChild(extra);
      }
    }
    if (blockEl.parentNode === container) {
      container.removeChild(blockEl);
    }
  });
}

async function renderBlocks(blocks, container, depth = 1) {
  for (const block of blocks) {
    const blockEl = document.createElement('div');
    blockEl.className = 'block';
    blockEl.dataset.blockId = block.id;
    if (typeof block.collapsed === 'boolean') {
      blockEl.dataset.collapsed = block.collapsed ? 'true' : 'false';
    }
    const isSelected =
      block.id === state.currentBlockId ||
      (Array.isArray(state.selectedBlockIds) && state.selectedBlockIds.includes(block.id));
    if (isSelected) blockEl.classList.add('selected');
    if (block.id === state.editingBlockId) blockEl.classList.add('editing');
    const surface = document.createElement('div');
    surface.className = 'block-surface';
    const content = document.createElement('div');
    content.className = 'block-content';

    let sections = extractBlockSections(block.text || '');
    let hasTitle = Boolean(sections.titleHtml);
    let hasBodyContent = Boolean(sections.bodyHtml && sections.bodyHtml.trim());
    const hasChildren = Boolean(block.children?.length);

    // Если у блока явно нет заголовка, но есть дети и в содержимом
    // всего одна непустая строка, считаем её заголовком при отрисовке.
    if (!hasTitle && hasChildren) {
      const tmp = document.createElement('div');
      tmp.innerHTML = sections.bodyHtml || block.text || '';
      const meaningful = Array.from(tmp.childNodes || []).filter((node) => {
        if (node.nodeType === Node.TEXT_NODE) {
          return (node.textContent || '').trim().length > 0;
        }
        if (node.nodeType === Node.ELEMENT_NODE) {
          if (node.tagName === 'BR') return false;
          if (node.tagName === 'P') {
            const inner = (node.innerHTML || '')
              .replace(/&nbsp;/gi, '')
              .replace(/<br\s*\/?>/gi, '')
              .trim();
            return inner.length > 0;
          }
          return true;
        }
        return false;
      });
      if (meaningful.length === 1) {
        const only = meaningful[0];
        if (only.nodeType === Node.ELEMENT_NODE && only.tagName === 'P') {
          sections = {
            titleHtml: only.outerHTML,
            bodyHtml: '',
          };
          hasTitle = true;
          hasBodyContent = false;
        }
      }
    }

    const canCollapse = hasTitle || hasChildren;
    const hasNoTitleNoChildren = !hasTitle && !hasChildren;
    blockEl.classList.toggle('block--no-title', !hasTitle);

    const isEditingThisBlock = state.mode === 'edit' && state.editingBlockId === block.id;

    let header = null;
    if (canCollapse || hasNoTitleNoChildren) {
      const collapseBtn = document.createElement('button');
      collapseBtn.className = 'collapse-btn';
      if (hasNoTitleNoChildren) {
        collapseBtn.classList.add('collapse-btn--placeholder');
        collapseBtn.setAttribute('aria-hidden', 'true');
        collapseBtn.removeAttribute('aria-expanded');
        collapseBtn.removeAttribute('title');
      } else {
        collapseBtn.setAttribute('aria-expanded', block.collapsed ? 'false' : 'true');
        collapseBtn.title = block.collapsed ? 'Развернуть' : 'Свернуть';
      }
      header = document.createElement('div');
      header.className = 'block-header';
      if (!hasTitle) header.classList.add('block-header--no-title');
      const headerLeft = document.createElement('div');
      headerLeft.className = 'block-header__left';
      headerLeft.appendChild(collapseBtn);
      if (hasTitle) {
        // Раньше заголовки блоков рендерились как h1-h6 в зависимости от уровня вложенности.
        // Это влияет и на типографику, и на визуальную иерархию.
        const level = Math.min(Math.max(depth, 1), 6);
        const titleEl = document.createElement(`h${level}`);
        titleEl.className = 'block-title';
        titleEl.innerHTML = sections.titleHtml || '';
        headerLeft.appendChild(titleEl);
      } else {
        const spacer = document.createElement('div');
        spacer.className = 'block-title-spacer';
        spacer.style.flex = '1';
        spacer.style.minWidth = '0';
        headerLeft.appendChild(spacer);
      }
      header.appendChild(headerLeft);
    }

    const body = document.createElement('div');
    body.className = 'block-text block-body';
    const bodyHtml = isEditingThisBlock ? buildEditableBlockHtml(block.text || '') : sections.bodyHtml || '';
    body.innerHTML = bodyHtml;
    if (!bodyHtml || !bodyHtml.trim()) {
      body.classList.add('block-body--empty');
      if (isEditingThisBlock) {
        body.innerHTML = '<p><br /></p>';
      }
    }

    body.classList.toggle('block-body--no-title', !hasTitle);

    if (isEditingThisBlock) {
      body.setAttribute('contenteditable', 'true');
      body.setAttribute('spellcheck', 'false');
      body.dataset.placeholder = 'Введите текст';
    } else {
      body.removeAttribute('contenteditable');
    }

    if (header) content.appendChild(header);
    // В режиме просмотра не рисуем пустое тело для блоков с заголовком,
    // чтобы не занимать лишнее место. В режиме редактирования и для
    // блоков без заголовка тело нужно всегда.
    const shouldRenderBody = isEditingThisBlock || !hasTitle || Boolean(bodyHtml);
    if (shouldRenderBody) {
      content.appendChild(body);
    }

    if (state.articleId === 'inbox' && !isEditingThisBlock) {
      const footer = document.createElement('div');
      footer.className = 'block-footer';
      const moveBtn = document.createElement('button');
      moveBtn.type = 'button';
      moveBtn.className = 'ghost small move-block-btn';
      moveBtn.innerHTML = '&#10140;';
      moveBtn.title = 'Перенести блок в другую статью';
      moveBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        if (moveBlockFromInboxHandler) {
          moveBlockFromInboxHandler(block.id);
        } else {
          showToast('Перенос блока временно недоступен');
        }
      });
      footer.appendChild(moveBtn);
      content.appendChild(footer);
    }

    surface.appendChild(content);

    if (isEditingThisBlock) {
      const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
      if (isTouchDevice) {
        content.addEventListener('click', (event) => {
          const editable = content.querySelector('.block-text[contenteditable="true"]');
          if (!editable) return;
          if (editable.contains(event.target)) return;
          event.stopPropagation();
          editable.focus();
          if (state.editingCaretPosition === 'start') {
            editable.scrollTop = 0;
            placeCaretAtStart(editable);
          } else {
            placeCaretAtEnd(editable);
          }
        });
      }
    }
    registerBlockDragSource(surface, block.id);

    if (isEditingThisBlock) {
      const actions = document.createElement('div');
      actions.className = 'block-edit-actions';

      const attachBtn = document.createElement('button');
      attachBtn.type = 'button';
      attachBtn.className = 'ghost small block-attach-btn';
      attachBtn.innerHTML =
        '<span class="block-attach-btn__icon">&#xE723;</span><span class="block-attach-btn__label">Файл</span>';
      attachBtn.title = 'Прикрепить файл или картинку';
      attachBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const editable = blockEl.querySelector('.block-text[contenteditable="true"]');
        if (!editable) return;
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.style.display = 'none';
        input.addEventListener('change', () => {
          const files = Array.from(input.files || []);
          if (files.length) {
            insertFilesIntoEditable(editable, files, block.id);
          }
          input.remove();
        });
        document.body.appendChild(input);
        input.click();
      });

      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'ghost small';
      saveBtn.textContent = 'Сохранить';
      saveBtn.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        await saveEditing();
      });

      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'ghost small';
      cancelBtn.textContent = 'Отмена';
      cancelBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        cancelEditing();
      });

      actions.appendChild(attachBtn);
      actions.appendChild(saveBtn);
      actions.appendChild(cancelBtn);

      content.appendChild(actions);
    }

    attachRichContentHandlers(body, block.id);

    blockEl.appendChild(surface);

    blockEl.addEventListener('click', (event) => {
      event.stopPropagation();
      if (state.isRagView && state.ragBlockMap && state.ragBlockMap[block.id]) {
        const target = state.ragBlockMap[block.id];
        if (target && target.articleId && target.blockId) {
          state.scrollTargetBlockId = target.blockId;
          state.currentBlockId = target.blockId;
          navigate(routing.article(target.articleId));
          return;
        }
      }
      const interactive = event.target.closest('button, a, [contenteditable="true"], .block-edit-actions');
      const headerEl = blockEl.querySelector('.block-header');
      const bodyEl = blockEl.querySelector('.block-text.block-body');
      const hasHeader = Boolean(headerEl);
      const headerHasTitle = Boolean(headerEl && !headerEl.classList.contains('block-header--no-title'));
      const clickedInHeader = hasHeader && headerEl.contains(event.target);
      const clickedInBody = bodyEl && bodyEl.contains(event.target);
      const hasLogicalTitle = headerHasTitle;
      const isAlreadyCurrent = state.currentBlockId === block.id;

      let shouldToggle = false;
      if (hasLogicalTitle && clickedInHeader) {
        // Клик по заголовку всегда переключает collapse,
        // даже если внутри заголовка есть ссылка или другой интерактив.
        shouldToggle = true;
      } else if (!hasLogicalTitle && isAlreadyCurrent && clickedInBody && !interactive) {
        // Для блоков без заголовка collapse вешаем на тело,
        // но только если блок уже текущий и клик не по интерактиву.
        shouldToggle = true;
      }
      if (shouldToggle) {
        toggleCollapse(block.id);
      }
      setCurrentBlock(block.id);
    });

    surface.addEventListener('dblclick', (event) => {
      if (state.mode !== 'view') return;
      if (state.isPublicView || state.isRagView) return;
      const interactive = event.target.closest('button, a, [contenteditable="true"]');
      if (interactive && !interactive.matches('.block-text[contenteditable="true"]')) return;
      event.stopPropagation();
      setCurrentBlock(block.id);
      startEditing();
    });

    const shouldHideBody = block.collapsed && block.id !== state.editingBlockId && hasTitle;
    if (!body.classList.contains('block-body--empty')) {
      body.classList.toggle('collapsed', shouldHideBody);
    }

    let childrenContainer = null;
    if (block.children?.length > 0 && !block.collapsed) {
      childrenContainer = document.createElement('div');
      childrenContainer.className = 'block-children';
      // eslint-disable-next-line no-await-in-loop
      await renderBlocks(block.children, childrenContainer, depth + 1);
    }

    container.appendChild(blockEl);
    if (childrenContainer) {
      if (isEditingThisBlock) {
        container.appendChild(childrenContainer);
      } else {
        blockEl.appendChild(childrenContainer);
      }
    }
    // Overlay drag handles removed: inline handle is now primary.
  }
}

export function reorderDomBlock(blockId, direction) {
  if (!blockId || !['up', 'down'].includes(direction)) return false;
  const blockEl = document.querySelector(`.block[data-block-id="${blockId}"]`);
  if (!blockEl) return false;
  // В режиме редактирования структура DOM вокруг блока сложнее;
  // для надёжности не пытаемся выполнять «быструю» перестановку.
  if (blockEl.classList.contains('editing')) return false;
  const container = blockEl.parentElement;
  if (!container) return false;

  if (direction === 'up') {
    let prev = blockEl.previousElementSibling;
    while (prev && !prev.classList.contains('block')) {
      prev = prev.previousElementSibling;
    }
    if (!prev) return false;
    container.insertBefore(blockEl, prev);
    return true;
  }

  // direction === 'down'
  let next = blockEl.nextElementSibling;
  while (next && !next.classList.contains('block')) {
    next = next.nextElementSibling;
  }
  if (!next) return false;
  const after = next.nextSibling;
  if (after) {
    container.insertBefore(blockEl, after);
  } else {
    container.appendChild(blockEl);
  }
  return true;
}

export async function rerenderSingleBlock(blockId) {
  if (!state.article || !Array.isArray(state.article.blocks)) return;
  const located = findBlock(blockId);
  if (!located) return;
  const depth = (Array.isArray(located.ancestors) ? located.ancestors.length : 0) + 1;
  const oldBlockEl = document.querySelector(`.block[data-block-id="${blockId}"]`);
  if (!oldBlockEl) return;
  const container = oldBlockEl.parentElement;
  if (!container) return;
  // В режиме редактирования дети блока могут быть рендерены отдельным .block-children сразу после него.
  const extraNodes = [];
  let cursor = oldBlockEl.nextElementSibling;
  if (cursor && cursor.classList.contains('block-children')) {
    extraNodes.push(cursor);
  }
  const insertBefore = (extraNodes[extraNodes.length - 1] || oldBlockEl).nextSibling;
  container.removeChild(oldBlockEl);
  extraNodes.forEach((node) => {
    if (node.parentNode === container) {
      container.removeChild(node);
    }
  });
  const tmp = document.createElement('div');
  await renderBlocks([located.block], tmp, depth);
  const newNodes = Array.from(tmp.childNodes);
  newNodes.forEach((node) => {
    container.insertBefore(node, insertBefore);
  });
  cleanupDomBlockDuplicates();
  cleanupOrphanDomBlocks();
}

export function renderArticle() {
  const article = state.article;
  if (!article) return;
  // Outline-only mode: blocks UI is hidden; header + sidebar still refresh.
  if (!state.isPublicView && !state.isRagView && state.isOutlineEditing) {
    renderSidebarArticleList();
    updateArticleHeaderUi();
    return;
  }
  if (Array.isArray(article.blocks)) {
    // Страхуемся от дубликатов блоков с одинаковым id,
    // которые могли появиться из-за локальных оптимистичных операций.
    dedupeBlocksById(article.blocks);
  }
  renderSidebarArticleList();
  const rootBlocks = article.id === 'inbox' ? [...(article.blocks || [])].reverse() : article.blocks;

  updateArticleHeaderUi();
  refs.blocksContainer.innerHTML = '';
  updateDragModeUi();
  clearDragLayer();
  ensureDragLayer();

  const focusEditingBlock = () => {
    if (state.mode !== 'edit' || !state.editingBlockId) return;
    // Для сценариев, где требуется установить каретку в начало (split блока),
    // позиционирование выполняется в requestAnimationFrame ниже.
    if (state.editingCaretPosition === 'start') return;
    const editable = refs.blocksContainer?.querySelector(
      `.block[data-block-id="${state.editingBlockId}"] .block-text[contenteditable="true"]`,
    );
    if (!editable) return;
    const active = document.activeElement;
    if (editable === active || editable.contains(active)) return;
    editable.focus({ preventScroll: true });
    if (editable.scrollHeight > editable.clientHeight) {
      editable.scrollTop = editable.scrollHeight;
    }
    placeCaretAtEnd(editable);
  };

  renderBlocks(rootBlocks, refs.blocksContainer).then(() => {
    cleanupOrphanDomBlocks();
    cleanupDomBlockDuplicates();
    applyPendingPreviewMarkup();
    if (state.scrollTargetBlockId && state.mode === 'view') {
      const targetId = state.scrollTargetBlockId;
      requestAnimationFrame(() => {
        const target = document.querySelector(`.block[data-block-id="${targetId}"]`);
        if (target) {
          const scrollNode = target.querySelector('.block-content') || target;
          scrollNode.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          const editable = target.querySelector('.block-text[contenteditable="true"]');
          if (editable && state.mode === 'edit' && state.editingBlockId === targetId) {
            editable.focus({ preventScroll: true });
            if (state.editingCaretPosition === 'start') {
              editable.scrollTop = 0;
              placeCaretAtStart(editable);
            } else {
              placeCaretAtEnd(editable);
            }
          } else {
            target.setAttribute('tabindex', '-1');
            target.focus({ preventScroll: true });
          }
        }
        state.currentBlockId = targetId;
        state.scrollTargetBlockId = null;
      });
    }
    // При открытии блока на редактирование не принудительно "центрируем" его,
    // чтобы не было резкого автоскролла.
    focusEditingBlock();
    // В режиме редактирования возвращаем прокрутку списка блоков туда,
    // где она была до входа в edit, чтобы Enter не прокручивал страницу.
    if (state.mode === 'edit' && typeof state.editingScrollTop === 'number' && refs.blocksContainer) {
      refs.blocksContainer.scrollTop = state.editingScrollTop;
    }
  });
}
