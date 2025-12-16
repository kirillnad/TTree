// Вынесено из `TTree/client/events.js`:
// - обработка горячих клавиш в режиме просмотра (стрелки, PgUp/PgDown/Home/End, Enter),
// - шаговый скролл высокого блока при ArrowUp/ArrowDown,
// - защита публичного режима от редактирования.
import { state, isHintVisible } from '../state.js';
import { refs } from '../refs.js';
import { handleUndoAction, handleRedoAction, clearPendingTextPreview } from '../undo.js';
import {
  moveSelectedBlocks,
  indentSelectedBlocks,
  outdentSelectedBlocks,
} from '../undo.js';
import { createSibling, deleteCurrentBlock, startEditing } from '../actions.js';
import {
  moveSelection,
  extendSelection,
  findCollapsibleTarget,
  setCollapseState,
  setCurrentBlock,
} from '../block.js';
import { hideHintPopover } from '../sidebar.js';

export function isEditableTarget(target) {
  if (!target) return false;
  const el = target instanceof Node ? target : null;
  if (!el || el.nodeType !== Node.ELEMENT_NODE) {
    return Boolean(target && target.isContentEditable);
  }
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return el.isContentEditable;
}

export function scrollCurrentBlockStep(direction) {
  if (!state.currentBlockId) return false;
  const el =
    document.querySelector(`.block[data-block-id="${state.currentBlockId}"] > .block-surface`) ||
    document.querySelector(`.block[data-block-id="${state.currentBlockId}"]`);
  if (!el) return false;
  const container = refs.blocksContainer || document.scrollingElement || document.documentElement;
  if (!container) return false;
  const containerRect = container.getBoundingClientRect();
  const rect = el.getBoundingClientRect();
  const margin = 24;
  const visibleHeight = containerRect.height - margin * 2;
  if (visibleHeight <= 0) return false;
  if (rect.height <= visibleHeight) {
    return false;
  }
  if (direction === 'down') {
    const bottomLimit = containerRect.bottom - margin;
    const fullyVisible = rect.bottom <= bottomLimit;
    if (fullyVisible) return false;
    const delta = rect.bottom - bottomLimit;
    const baseStep = Math.min(Math.max(delta, 40), 160);
    const step = Math.max(24, Math.round(baseStep / 3));
    container.scrollBy({ top: step, behavior: 'smooth' });
    return true;
  }
  if (direction === 'up') {
    const topLimit = containerRect.top + margin;
    const fullyVisible = rect.top >= topLimit;
    if (fullyVisible) return false;
    const delta = topLimit - rect.top;
    const baseStep = Math.min(Math.max(delta, 40), 160);
    const step = Math.max(24, Math.round(baseStep / 3));
    container.scrollBy({ top: -step, behavior: 'smooth' });
    return true;
  }
  return false;
}

export function handleViewKey(event) {
  if (!state.article) return;
  if (isEditableTarget(event.target)) return;
  if (
    state.isEditingTitle &&
    refs.articleTitleInput &&
    refs.articleTitleInput.contains(event.target)
  ) {
    return;
  }
  if (state.isPublicView || state.isRagView) {
    const code = typeof event.code === 'string' ? event.code : '';
    if (code === 'Enter') {
      event.preventDefault();
      return;
    }
    if (
      event.ctrlKey &&
      (code === 'KeyZ' ||
        code === 'KeyY' ||
        code === 'Delete' ||
        code === 'ArrowDown' ||
        code === 'ArrowUp' ||
        code === 'ArrowLeft' ||
        code === 'ArrowRight')
    ) {
      event.preventDefault();
      return;
    }
  }
  if (isHintVisible && event.code === 'Escape') {
    event.preventDefault();
    hideHintPopover();
    return;
  }
  const code = typeof event.code === 'string' ? event.code : '';
  const moveSelectionPage = (direction) => {
    const container = refs.blocksContainer;
    if (!container) return;
    const containerRect = container.getBoundingClientRect();
    const margin = 24;
    const viewHeight = Math.max(0, containerRect.height - margin * 2);
    if (viewHeight <= 0) return;

    const page = Math.max(40, Math.round(viewHeight * 0.92));
    const delta = direction === 'down' ? page : -page;
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    const before = container.scrollTop;
    const targetScrollTop = Math.max(0, Math.min(before + delta, maxScrollTop));

    container.scrollTop = targetScrollTop;

    const topLimit = containerRect.top + margin;
    const blocks = Array.from(container.querySelectorAll('.block[data-block-id]'));
    if (!blocks.length) return;

    const entries = blocks
      .map((el) => {
        const id = el.getAttribute('data-block-id') || '';
        const rect = el.getBoundingClientRect();
        return { id, rect };
      })
      .filter((x) => x.id);

    if (!entries.length) return;

    let chosen = entries.find((e) => e.rect.top >= topLimit) || null;
    if (!chosen && direction === 'down') chosen = entries[entries.length - 1];
    if (!chosen && direction === 'up') chosen = entries[0];

    if (targetScrollTop === before && state.currentBlockId) {
      if (direction === 'down') chosen = entries[entries.length - 1];
      else chosen = entries[0];
    }

    if (chosen && chosen.id) {
      state.scrollTargetBlockId = chosen.id;
      setCurrentBlock(chosen.id, { scrollIntoView: false });
    }
  };

  const moveSelectionEdge = (direction) => {
    const container = refs.blocksContainer;
    if (!container) return;
    const blocks = Array.from(container.querySelectorAll('.block[data-block-id]'));
    if (!blocks.length) return;
    const target = direction === 'end' ? blocks[blocks.length - 1] : blocks[0];
    const id = target.getAttribute('data-block-id');
    if (!id) return;
    state.scrollTargetBlockId = id;
    setCurrentBlock(id, { scrollIntoView: true, scrollBehavior: 'auto' });
  };

  if (!event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey) {
    if (code === 'PageDown') {
      event.preventDefault();
      moveSelectionPage('down');
      return;
    }
    if (code === 'PageUp') {
      event.preventDefault();
      moveSelectionPage('up');
      return;
    }
    if (code === 'Home') {
      event.preventDefault();
      moveSelectionEdge('home');
      return;
    }
    if (code === 'End') {
      event.preventDefault();
      moveSelectionEdge('end');
      return;
    }
  }

  const isCtrlZ = event.ctrlKey && !event.shiftKey && code === 'KeyZ';
  const isCtrlY = event.ctrlKey && !event.shiftKey && code === 'KeyY';
  if (state.pendingTextPreview) {
    if (state.pendingTextPreview.mode === 'undo' && isCtrlZ) {
      event.preventDefault();
      handleUndoAction();
      return;
    }
    if (state.pendingTextPreview.mode === 'redo' && isCtrlY) {
      event.preventDefault();
      handleRedoAction();
      return;
    }
    if (code === 'Escape') {
      event.preventDefault();
      clearPendingTextPreview();
      return;
    }
    event.preventDefault();
    return;
  }
  if (isCtrlZ) {
    event.preventDefault();
    handleUndoAction();
    return;
  }
  if (isCtrlY) {
    event.preventDefault();
    handleRedoAction();
    return;
  }
  if (event.ctrlKey && event.shiftKey && event.code === 'ArrowDown') {
    event.preventDefault();
    moveSelectedBlocks('down');
    return;
  }
  if (event.ctrlKey && event.shiftKey && event.code === 'ArrowUp') {
    event.preventDefault();
    moveSelectedBlocks('up');
    return;
  }
  if (event.ctrlKey && !event.shiftKey && event.code === 'ArrowDown') {
    event.preventDefault();
    const direction = state.articleId === 'inbox' ? 'before' : 'after';
    createSibling(direction);
    return;
  }
  if (event.ctrlKey && !event.shiftKey && event.code === 'ArrowUp') {
    event.preventDefault();
    const direction = state.articleId === 'inbox' ? 'after' : 'before';
    createSibling(direction);
    return;
  }
  if (event.ctrlKey && event.code === 'Delete') {
    event.preventDefault();
    deleteCurrentBlock();
    return;
  }
  if (event.ctrlKey && event.code === 'ArrowRight') {
    event.preventDefault();
    indentSelectedBlocks();
    return;
  }
  if (event.ctrlKey && event.code === 'ArrowLeft') {
    event.preventDefault();
    outdentSelectedBlocks();
    return;
  }
  if (event.code === 'ArrowDown') {
    if (!event.ctrlKey && event.shiftKey) {
      event.preventDefault();
      extendSelection(1);
      return;
    }
    if (!event.ctrlKey && !event.shiftKey) {
      event.preventDefault();
      const scrolled = scrollCurrentBlockStep('down');
      if (!scrolled) {
        const delta = state.articleId === 'inbox' ? -1 : 1;
        moveSelection(delta);
      }
      return;
    }
  }
  if (event.code === 'ArrowUp') {
    if (!event.ctrlKey && event.shiftKey) {
      event.preventDefault();
      extendSelection(-1);
      return;
    }
    if (!event.ctrlKey && !event.shiftKey) {
      event.preventDefault();
      const scrolled = scrollCurrentBlockStep('up');
      if (!scrolled) {
        const delta = state.articleId === 'inbox' ? 1 : -1;
        moveSelection(delta);
      }
      return;
    }
  }
  if (event.code === 'ArrowLeft') {
    event.preventDefault();
    const targetId = findCollapsibleTarget(state.currentBlockId, true);
    if (targetId) {
      if (state.currentBlockId !== targetId) {
        setCurrentBlock(targetId);
      }
      setCollapseState(targetId, true);
    }
    return;
  }
  if (event.code === 'ArrowRight') {
    event.preventDefault();
    const targetId = findCollapsibleTarget(state.currentBlockId, false);
    if (targetId) {
      setCollapseState(targetId, false);
    }
    return;
  }
  if (event.code === 'Enter') {
    event.preventDefault();
    startEditing();
  }
}
