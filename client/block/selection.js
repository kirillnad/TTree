// Вынесено из `TTree/client/block.js`:
// - навигация и выделение блоков (current block, multi-select),
// - список видимых блоков (flattenVisible),
// - поиск блока в дереве (findBlock),
// - прокрутка к текущему блоку при смене выделения.
import { state } from '../state.js';
import { refs } from '../refs.js';

export function flattenVisible(blocks = [], acc = []) {
  (blocks || []).forEach((block) => {
    acc.push(block);
    if (block.children && block.children.length > 0 && !block.collapsed) {
      flattenVisible(block.children, acc);
    }
  });
  return acc;
}

export function findBlock(blockId, blocks = state.article?.blocks || [], parent = null, ancestors = []) {
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    if (block.id === blockId) {
      return { block, parent, index: i, siblings: blocks, ancestors };
    }
    const nested = findBlock(blockId, block.children || [], block, [...ancestors, block]);
    if (nested) {
      return nested;
    }
  }
  return null;
}

export function updateSelectionUi({ scrollIntoView = false, scrollBehavior = 'smooth' } = {}) {
  const selectedIds = new Set(Array.isArray(state.selectedBlockIds) ? state.selectedBlockIds : []);
  if (state.currentBlockId) {
    selectedIds.add(state.currentBlockId);
  }
  const blockEls = document.querySelectorAll('.block[data-block-id]');
  blockEls.forEach((el) => {
    const id = el.getAttribute('data-block-id');
    const shouldSelect = id && selectedIds.has(id);
    el.classList.toggle('selected', Boolean(shouldSelect));
    el.classList.remove('block--selected-root-ancestor');
    const surface = el.querySelector(':scope > .block-surface');
    if (surface) surface.classList.remove('block--selected-root-ancestor');
  });

  // Подсветка корневого родителя для вложенного текущего блока.
  if (state.currentBlockId && state.article && Array.isArray(state.article.blocks)) {
    const located = findBlock(state.currentBlockId);
    const ancestors = located?.ancestors || [];
    const rootTargetId = ancestors.length > 0 ? ancestors[0]?.id : located?.block?.id;
    if (rootTargetId) {
      const rootEl = document.querySelector(`.block[data-block-id="${rootTargetId}"]`);
      if (rootEl) {
        // Подсвечиваем только "surface" корневого родителя, чтобы подсветка
        // не растягивалась на всю высоту поддерева (children).
        const rootSurface = rootEl.querySelector(':scope > .block-surface');
        if (rootSurface) rootSurface.classList.add('block--selected-root-ancestor');
      }
    }
  }
  if (scrollIntoView && state.mode === 'view' && state.currentBlockId) {
    const currentEl = document.querySelector(`.block[data-block-id="${state.currentBlockId}"]`);
    if (currentEl) {
      currentEl.scrollIntoView({ behavior: scrollBehavior || 'smooth', block: 'nearest' });
    }
  }
}

/**
 * Внутренний помощник для установки текущего блока.
 * Можно управлять тем, сбрасывать ли мультивыделение.
 */
function setCurrentBlockInternal(blockId, options = {}) {
  if (!blockId || state.currentBlockId === blockId) return;
  const { preserveSelection = false, scrollIntoView, scrollBehavior } = options;
  state.currentBlockId = blockId;
  if (!preserveSelection) {
    state.selectionAnchorBlockId = null;
    state.selectedBlockIds = [];
  }
  const shouldScroll = typeof scrollIntoView === 'boolean' ? scrollIntoView : state.mode === 'view';
  updateSelectionUi({ scrollIntoView: shouldScroll, scrollBehavior: scrollBehavior || 'smooth' });
}

export function setCurrentBlock(blockId, options = {}) {
  setCurrentBlockInternal(blockId, { preserveSelection: false, ...options });
}

export function moveSelection(offset) {
  if (!state.article) return;
  const ordered = flattenVisible(state.article.blocks);
  const index = ordered.findIndex((b) => b.id === state.currentBlockId);
  if (index === -1) return;
  const next = ordered[index + offset];
  if (next) {
    if (state.mode === 'view') {
      state.scrollTargetBlockId = next.id;
    }
    // Обычное перемещение стрелками — сбрасываем мультивыделение.
    setCurrentBlockInternal(next.id, { preserveSelection: false });
  }
}

export function extendSelection(offset) {
  if (!state.article) return;
  const ordered = flattenVisible(state.article.blocks);
  if (!ordered.length) return;

  // Базовый якорь — либо уже существующий, либо текущий блок.
  let anchorId = state.selectionAnchorBlockId || state.currentBlockId || ordered[0].id;
  if (!anchorId) anchorId = ordered[0].id;
  if (!state.selectionAnchorBlockId) {
    state.selectionAnchorBlockId = anchorId;
  }

  const anchorIndex = ordered.findIndex((b) => b.id === anchorId);
  if (anchorIndex === -1) return;

  const currentId = state.currentBlockId || anchorId;
  let currentIndex = ordered.findIndex((b) => b.id === currentId);
  if (currentIndex === -1) currentIndex = anchorIndex;

  const newIndex = currentIndex + offset;
  if (newIndex < 0 || newIndex >= ordered.length) return;

  const [start, end] = newIndex >= anchorIndex ? [anchorIndex, newIndex] : [newIndex, anchorIndex];
  const selected = ordered.slice(start, end + 1).map((b) => b.id);

  state.selectedBlockIds = selected;
  state.currentBlockId = ordered[newIndex].id;
  if (state.mode === 'view') {
    state.scrollTargetBlockId = state.currentBlockId;
  }
  updateSelectionUi({ scrollIntoView: state.mode === 'view' });
}

