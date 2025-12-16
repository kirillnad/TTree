// Вынесено из `article.js`: Drag&Drop блоков + UI режима перетаскивания.

import { state } from '../state.js';
import { refs } from '../refs.js';
import { findBlock } from '../block.js';
import { moveBlockToParent } from '../undo.js';
import { showToast } from '../toast.js';

// ----- Drag and drop for blocks -----
const DRAG_THRESHOLD_PX = 6;
const DROP_INDENT_PX = 20;
const DROP_BEFORE_THRESHOLD = 0.35;
const DROP_AFTER_THRESHOLD = 0.65;
const DRAG_INTERACTIVE_SELECTOR =
  'button, a, input, textarea, select, [contenteditable="true"], .block-edit-actions, .move-block-btn, .collapse-btn';
let activeDrag = null;
let dropLineEl = null;
let dropInsideTarget = null;
let dragPreviewEl = null;
let dragLayerEl = null;
const dragHandleEntries = new Map();
let dragLayerListenersBound = false;
let dragSelectionGuardAttached = false;

function handleDragSelectionChange() {
  // Во время активной сессии DnD блоков не даём браузеру
  // оставлять текстовое выделение (особенно на мобильных
  // после долгого тапа), чтобы DnD был приоритетным жестом.
  if (!activeDrag || !isDragModeOperational()) return;
  // Для мыши (desktop) не гасим selection: оно не мешает DnD,
  // а принудительный сброс даёт артефакт — выделение пропадает
  // сразу после mouseup, особенно внутри <pre>.
  if (activeDrag.pointerType === 'mouse') return;
  const sel = window.getSelection ? window.getSelection() : null;
  if (!sel || sel.isCollapsed) return;
  try {
    sel.removeAllRanges();
  } catch {
    // ignore
  }
}

function attachDragSelectionGuard() {
  if (dragSelectionGuardAttached) return;
  document.addEventListener('selectionchange', handleDragSelectionChange);
  dragSelectionGuardAttached = true;
}

function detachDragSelectionGuard() {
  if (!dragSelectionGuardAttached) return;
  document.removeEventListener('selectionchange', handleDragSelectionChange);
  dragSelectionGuardAttached = false;
}

function isDragModeOperational() {
  return Boolean(state.isDragModeEnabled && state.mode === 'view' && state.articleId !== 'inbox');
}

function isInteractiveDragTarget(target) {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest(DRAG_INTERACTIVE_SELECTOR));
}

function cancelActiveDragSession() {
  if (!activeDrag) return;
  window.removeEventListener('pointermove', handlePointerMove);
  window.removeEventListener('pointerup', handlePointerUp);
  window.removeEventListener('pointercancel', handlePointerUp);
  try {
    activeDrag.sourceEl?.releasePointerCapture?.(activeDrag.pointerId);
  } catch (_error) {
    // ignore release errors
  }
  activeDrag = null;
  detachDragSelectionGuard();
  clearDragUi();
}

function beginDragSession(event, blockId, sourceEl, { bypassInteractiveCheck = false } = {}) {
  if (!state.article) return;
  if (!state.isDragModeEnabled) return;
  if (!isDragModeOperational()) return;
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  if (!bypassInteractiveCheck && isInteractiveDragTarget(event.target)) {
    return;
  }
  const located = findBlock(blockId);
  if (!located) return;

  activeDrag = {
    pointerType: event.pointerType || 'mouse',
    blockId,
    pointerId: event.pointerId,
    originParentId: located.parent?.id || null,
    originIndex: located.index ?? 0,
    startX: event.clientX,
    startY: event.clientY,
    dragging: false,
    forbidden: collectBlockIds(located.block),
    lastDrop: null,
    sourceEl,
  };

  try {
    sourceEl?.setPointerCapture?.(event.pointerId);
  } catch (_error) {
    /* noop */
  }

  window.addEventListener('pointermove', handlePointerMove);
  window.addEventListener('pointerup', handlePointerUp);
  window.addEventListener('pointercancel', handlePointerUp);
  attachDragSelectionGuard();
}

export function registerBlockDragSource(element, blockId, { allowInteractive = false } = {}) {
  if (!element) return;
  element.addEventListener('pointerdown', (event) => {
    if (!allowInteractive && isInteractiveDragTarget(event.target)) {
      return;
    }
    const isTouchPointer = event.pointerType === 'touch' || event.pointerType === 'pen';
    // На тач‑устройствах в режиме перетаскивания гасим
    // нативное выделение текста / контекстное меню.
    if (isTouchPointer && isDragModeOperational()) {
      event.preventDefault();
    }
    beginDragSession(event, blockId, element, { bypassInteractiveCheck: allowInteractive });
  });
}

export function updateDragModeUi() {
  const hasArticle = Boolean(state.article);
  const toggleBtn = refs.dragModeToggleBtn;
  if (toggleBtn) {
    toggleBtn.disabled = !hasArticle;
    toggleBtn.classList.toggle('active', Boolean(state.isDragModeEnabled));
    toggleBtn.setAttribute('aria-pressed', state.isDragModeEnabled ? 'true' : 'false');
    let title = state.isDragModeEnabled ? 'Перетащите блок за его поверхность' : 'Включить режим перетаскивания блоков';
    if (!hasArticle) {
      title = 'Откройте статью, чтобы управлять перетаскиванием';
    } else if (state.articleId === 'inbox') {
      title = 'Перетаскивание недоступно в быстрых заметках';
    } else if (state.mode !== 'view') {
      title = 'Перетащить блок можно только в режиме просмотра';
    }
    toggleBtn.title = title;
  }
  const isReady = isDragModeOperational();
  const hosts = [refs.articleView, refs.blocksContainer];
  hosts.forEach((node) => {
    if (!node) return;
    node.classList.toggle('drag-mode-enabled', isReady);
  });
  document.body.classList.toggle('drag-mode-enabled', isReady);
}

function collectBlockIds(block, acc = new Set()) {
  if (!block) return acc;
  acc.add(block.id);
  (block.children || []).forEach((child) => collectBlockIds(child, acc));
  return acc;
}

function ensureDropLine() {
  if (dropLineEl) return dropLineEl;
  const el = document.createElement('div');
  el.className = 'block-drop-line hidden';
  document.body.appendChild(el);
  dropLineEl = el;
  return el;
}

function clearDragUi() {
  if (dropLineEl) dropLineEl.classList.add('hidden');
  if (dropInsideTarget) {
    dropInsideTarget.classList.remove('drop-inside-target');
    dropInsideTarget = null;
  }
  if (dragPreviewEl) {
    dragPreviewEl.remove();
    dragPreviewEl = null;
  }
  document.body.classList.remove('block-dnd-active');
}

function updateDragPreviewPosition(event) {
  if (!dragPreviewEl) return;
  dragPreviewEl.style.left = `${event.clientX + 12}px`;
  dragPreviewEl.style.top = `${event.clientY + 12}px`;
}

function createDragPreview(blockId) {
  const preview = document.createElement('div');
  preview.className = 'block-drag-preview';
  const blockEl = refs.blocksContainer?.querySelector(`.block[data-block-id="${blockId}"]`);
  const titleText = blockEl?.querySelector('.block-title')?.textContent?.trim();
  const bodyText = blockEl?.querySelector('.block-text')?.textContent?.trim();
  preview.textContent = titleText || bodyText || 'Блок';
  document.body.appendChild(preview);
  dragPreviewEl = preview;
}

export function ensureDragLayer() {
  if (dragLayerEl && dragLayerEl.isConnected) {
    if (refs.blocksContainer && dragLayerEl.parentNode !== refs.blocksContainer) {
      refs.blocksContainer.appendChild(dragLayerEl);
    }
    return dragLayerEl;
  }
  dragLayerEl = document.createElement('div');
  dragLayerEl.className = 'drag-layer';
  if (refs.blocksContainer) {
    refs.blocksContainer.appendChild(dragLayerEl);
    if (!dragLayerListenersBound) {
      refs.blocksContainer.addEventListener('scroll', refreshDragHandlePositions, { passive: true });
      window.addEventListener('resize', refreshDragHandlePositions, { passive: true });
      dragLayerListenersBound = true;
    }
  }
  return dragLayerEl;
}

export function clearDragLayer() {
  dragHandleEntries.clear();
  if (dragLayerEl) dragLayerEl.innerHTML = '';
}

function refreshDragHandlePositions() {
  const container = refs.blocksContainer;
  if (!container || !dragLayerEl) return;
  const containerRect = container.getBoundingClientRect();
  const scrollTop = container.scrollTop;
  dragHandleEntries.forEach(({ handle, blockEl }) => {
    const rect = blockEl.getBoundingClientRect();
    const headerLeft = blockEl.querySelector('.block-header__left');
    const header = blockEl.querySelector('.block-header');
    const collapseBtn = blockEl.querySelector('.collapse-btn');
    const headerLeftRect = headerLeft?.getBoundingClientRect();
    const headerRect = header?.getBoundingClientRect();
    const collapseRect = collapseBtn?.getBoundingClientRect();
    const reference =
      (headerLeftRect && headerLeftRect.height > 0 ? headerLeftRect : null) ||
      (headerRect && headerRect.height > 0 ? headerRect : null) ||
      (collapseRect && collapseRect.height > 0 ? collapseRect : null) ||
      rect;
    const top = reference.top - containerRect.top + scrollTop + reference.height / 2;
    handle.style.top = `${top}px`;
    handle.style.right = '8px';
  });
}

function addOverlayDragHandle(blockEl, blockId) {
  const layer = ensureDragLayer();
  const handle = document.createElement('button');
  handle.type = 'button';
  handle.className = 'block-add-btn drag-layer__handle';
  handle.title = 'Добавить блок ниже';
  handle.setAttribute('aria-label', 'Добавить блок ниже');
  handle.textContent = '+';
  handle.dataset.blockId = blockId;
  registerBlockDragSource(handle, blockId, { allowInteractive: true });
  dragHandleEntries.set(blockId, { handle, blockEl });
  layer.appendChild(handle);
  refreshDragHandlePositions();
}

function updateDropIndicator(target) {
  const line = ensureDropLine();
  if (!target) {
    line.classList.add('hidden');
    if (dropInsideTarget) {
      dropInsideTarget.classList.remove('drop-inside-target');
      dropInsideTarget = null;
    }
    return;
  }

  if (target.placement === 'inside') {
    line.classList.add('hidden');
    if (dropInsideTarget && dropInsideTarget.dataset.blockId !== target.targetId) {
      dropInsideTarget.classList.remove('drop-inside-target');
    }
    dropInsideTarget = refs.blocksContainer?.querySelector(`.block[data-block-id="${target.targetId}"]`) || null;
    if (dropInsideTarget) {
      dropInsideTarget.classList.add('drop-inside-target');
    }
    return;
  }

  if (dropInsideTarget) {
    dropInsideTarget.classList.remove('drop-inside-target');
    dropInsideTarget = null;
  }

  line.classList.remove('hidden');
  const top = target.placement === 'before' ? target.rect.top : target.rect.top + target.rect.height;
  const indentPx = Math.min(target.depth * DROP_INDENT_PX, target.rect.width - 32);
  const left = target.rect.left + indentPx;
  const width = Math.max(target.rect.width - indentPx, 48);
  line.style.top = `${top}px`;
  line.style.left = `${left}px`;
  line.style.width = `${width}px`;
}

function computeDropTarget(clientX, clientY) {
  if (!refs.blocksContainer || !activeDrag) return null;
  const blocks = Array.from(refs.blocksContainer.querySelectorAll('.block'));
  const candidates = blocks.filter((el) => {
    const id = el.dataset.blockId;
    return id && !activeDrag.forbidden.has(id);
  });
  if (!candidates.length) return null;

  let best = null;
  let bestDistance = Infinity;
  candidates.forEach((el) => {
    const rect = el.getBoundingClientRect();
    const centerY = rect.top + rect.height / 2;
    const dist = Math.abs(clientY - centerY);
    if (dist < bestDistance) {
      bestDistance = dist;
      best = el;
    }
  });
  if (!best) return null;

  const rect = best.getBoundingClientRect();
  const ratio = rect.height > 0 ? (clientY - rect.top) / rect.height : 0.5;
  const placement = ratio < DROP_BEFORE_THRESHOLD ? 'before' : ratio > DROP_AFTER_THRESHOLD ? 'after' : 'inside';
  const targetId = best.dataset.blockId;
  const located = findBlock(targetId);
  if (!located) return null;

  const depth = (located.ancestors || []).length;
  const parentId = placement === 'inside' ? targetId : located.parent?.id || null;
  if (activeDrag.forbidden.has(parentId || '')) return null;
  let effectiveTargetId = targetId;
  let effectiveParentId = parentId;
  let effectivePlacement = placement;
  let effectiveRect = rect;
  let effectiveDepth = placement === 'inside' ? depth + 1 : depth;
  let effectiveIndex = effectivePlacement === 'after' ? located.index + 1 : located.index;

  if (effectivePlacement !== 'inside' && located.parent) {
    let climb = located;
    let climbRect = rect;
    const HORIZONTAL_THRESHOLD = rect.left + DROP_INDENT_PX;
    while (climb.parent) {
      const shouldClimbHorizontally = clientX <= HORIZONTAL_THRESHOLD;
      const shouldClimbVertically = clientY <= climbRect.top || clientY >= climbRect.bottom;
      if (!shouldClimbHorizontally && !shouldClimbVertically) break;
      const parentInfo = findBlock(climb.parent.id);
      if (!parentInfo) break;
      const parentEl = refs.blocksContainer?.querySelector(`.block[data-block-id="${parentInfo.block.id}"]`);
      const parentRect = parentEl?.getBoundingClientRect();
      climb = parentInfo;
      climbRect = parentRect || climbRect;
      effectiveTargetId = climb.block.id;
      effectiveRect = climbRect;
      effectiveDepth = (climb.ancestors || []).length;
      effectiveParentId = climb.parent?.id || null;
      effectiveIndex = effectivePlacement === 'after' ? climb.index + 1 : climb.index;
    }
  }

  return {
    targetId: effectiveTargetId,
    placement: effectivePlacement,
    parentId: effectiveParentId,
    index: effectiveIndex,
    depth: effectiveDepth,
    rect: effectiveRect,
  };
}

function autoScrollDuringDrag(event) {
  if (!refs.blocksContainer) return;
  const rect = refs.blocksContainer.getBoundingClientRect();
  const threshold = 60;
  if (event.clientY < rect.top + threshold) {
    refs.blocksContainer.scrollTop -= 12;
  } else if (event.clientY > rect.bottom - threshold) {
    refs.blocksContainer.scrollTop += 12;
  }
}

function handlePointerMove(event) {
  if (!activeDrag || event.pointerId !== activeDrag.pointerId) return;
  if (!isDragModeOperational()) {
    cancelActiveDragSession();
    return;
  }
  const dx = event.clientX - activeDrag.startX;
  const dy = event.clientY - activeDrag.startY;
  if (!activeDrag.dragging) {
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    activeDrag.dragging = true;
    const pointerType = activeDrag.pointerType || event.pointerType || 'mouse';
    if (pointerType === 'touch' || pointerType === 'pen') {
      document.body.classList.add('block-dnd-active');
    }
    createDragPreview(activeDrag.blockId);
  }
  event.preventDefault();
  updateDragPreviewPosition(event);
  const dropTarget = computeDropTarget(event.clientX, event.clientY);
  activeDrag.lastDrop = dropTarget;
  updateDropIndicator(dropTarget);
  autoScrollDuringDrag(event);
}

async function handlePointerUp(event) {
  if (!activeDrag || event.pointerId !== activeDrag.pointerId) return;
  const dragSession = activeDrag;
  cancelActiveDragSession();

  const shouldMove = dragSession.dragging && dragSession.lastDrop;
  const dropTarget = dragSession.lastDrop;
  const blockId = dragSession.blockId;

  if (!shouldMove || !dropTarget) return;

  await moveBlockToParent(blockId, dropTarget.parentId || null, dropTarget.index, {
    anchorId: dropTarget.targetId,
    placement: dropTarget.placement,
  });
}

export function toggleDragMode() {
  if (!state.article) {
    showToast('Откройте статью, чтобы переключить перетаскивание');
    return;
  }
  state.isDragModeEnabled = !state.isDragModeEnabled;
  if (!state.isDragModeEnabled) {
    cancelActiveDragSession();
    updateDragModeUi();
    showToast('Перетаскивание выключено');
    return;
  }
  updateDragModeUi();
  if (state.articleId === 'inbox') {
    showToast('Режим включён, но в быстрых заметках перемещение недоступно');
    return;
  }
  if (state.mode !== 'view') {
    showToast('Режим включён, завершите редактирование, чтобы перетаскивать блоки');
    return;
  }
  showToast('Перетаскивание включено — перетащите блок за его поверхность');
}

