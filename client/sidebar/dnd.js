// Вынесено из `sidebar.js`: Drag&Drop статей в дереве (desktop HTML5 + mobile touch/pointer).

import { state } from '../state.js';
import { fetchArticlesIndex, moveArticleTree } from '../api.js?v=2';
import { showToast } from '../toast.js';

let renderSidebarArticleListCb = null;
let renderMainArticleListCb = null;
let setArticlesIndexCb = null;

export function setSidebarDndCallbacks({ renderSidebarArticleList, renderMainArticleList, setArticlesIndex } = {}) {
  renderSidebarArticleListCb = typeof renderSidebarArticleList === 'function' ? renderSidebarArticleList : null;
  renderMainArticleListCb = typeof renderMainArticleList === 'function' ? renderMainArticleList : null;
  setArticlesIndexCb = typeof setArticlesIndex === 'function' ? setArticlesIndex : null;
}

let isTouchDevice = false;
if (typeof window !== 'undefined') {
  if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) {
    isTouchDevice = true;
  } else if ('ontouchstart' in window) {
    isTouchDevice = true;
  }
}

let draggingArticleId = null;
let currentDropLi = null;
const TOUCH_DRAG_THRESHOLD_PX = 6;
let touchArticleDrag = null;
// Для DnD статей на мобильных используем чистые touch‑события даже при
// наличии Pointer Events, т.к. поведение Pointer Events на iOS нестабильно.
const supportsPointerEvents =
  typeof window !== 'undefined' && 'PointerEvent' in window && !isTouchDevice;

function clearDropIndicators() {
  if (currentDropLi) {
    currentDropLi.classList.remove('drop-before', 'drop-after', 'drop-inside');
    currentDropLi = null;
  }
}

function setDropIndicator(li, dropMode) {
  if (!li) return;
  if (currentDropLi && currentDropLi !== li) {
    currentDropLi.classList.remove('drop-before', 'drop-after', 'drop-inside');
  }
  currentDropLi = li;
  currentDropLi.classList.remove('drop-before', 'drop-after', 'drop-inside');
  if (dropMode === 'before') {
    currentDropLi.classList.add('drop-before');
  } else if (dropMode === 'after') {
    currentDropLi.classList.add('drop-after');
  } else if (dropMode === 'inside') {
    currentDropLi.classList.add('drop-inside');
  }
}

function cancelTouchArticleDrag() {
  if (!touchArticleDrag) return;
  if (touchArticleDrag.sourceEl instanceof Element) {
    touchArticleDrag.sourceEl.classList.remove('article-dnd-source');
  }
  if (typeof document !== 'undefined' && document.body) {
    document.body.classList.remove('article-dnd-active');
  }
  window.removeEventListener('pointermove', handleTouchArticleMove);
  window.removeEventListener('pointerup', handleTouchArticleUp);
  window.removeEventListener('pointercancel', handleTouchArticleUp);
  window.removeEventListener('touchmove', handleLegacyTouchMove);
  window.removeEventListener('touchend', handleLegacyTouchEnd);
  window.removeEventListener('touchcancel', handleLegacyTouchEnd);
  touchArticleDrag = null;
  clearDropIndicators();
  window.__ttreeDraggingArticleId = null;
}

function isArticleInteractiveTarget(target) {
  if (!(target instanceof Element)) return false;
  if (target.closest('.star-btn')) return true;
  if (target.closest('.row-actions')) return true;
  return false;
}

function beginLegacyTouchArticleDrag(event, articleId) {
  if (!articleId) return;
  if (touchArticleDrag) return;
  if (!event.touches || event.touches.length !== 1) return;
  const touch = event.touches[0];
  const sourceEl = event.currentTarget instanceof Element ? event.currentTarget : null;
  touchArticleDrag = {
    pointerId: 'legacy-touch',
    articleId,
    startX: touch.clientX,
    startY: touch.clientY,
    dragging: false,
    lastTargetId: null,
    lastDropMode: null,
    sourceEl,
  };
  window.__ttreeDraggingArticleId = articleId;
  if (typeof document !== 'undefined' && document.body) {
    document.body.classList.add('article-dnd-active');
  }
  try {
    const selection = window.getSelection ? window.getSelection() : null;
    if (selection && !selection.isCollapsed) {
      selection.removeAllRanges();
    }
  } catch (_) {
    /* ignore */
  }
  window.addEventListener('touchmove', handleLegacyTouchMove, { passive: false });
  window.addEventListener('touchend', handleLegacyTouchEnd);
  window.addEventListener('touchcancel', handleLegacyTouchEnd);
}

function handleLegacyTouchMove(event) {
  if (!touchArticleDrag) return;
  if (!event.touches || event.touches.length === 0) return;
  const touch = event.touches[0];
  handleTouchArticleMove({
    pointerId: 'legacy-touch',
    clientX: touch.clientX,
    clientY: touch.clientY,
    preventDefault: () => {
      event.preventDefault();
    },
  });
}

function handleLegacyTouchEnd() {
  if (!touchArticleDrag) return;
  handleTouchArticleUp({ pointerId: 'legacy-touch' });
}

function getArticleItemFromPoint(clientX, clientY) {
  const el = document.elementFromPoint(clientX, clientY);
  if (!el) return null;
  const li = el.closest('.sidebar-article-item, #articleList li');
  if (!li || !li.dataset || !li.dataset.articleId) return null;
  return li;
}

function beginTouchArticleDrag(event, articleId) {
  if (!articleId) return;
  if (touchArticleDrag) return;
  const sourceEl = event.currentTarget instanceof Element ? event.currentTarget : null;
  touchArticleDrag = {
    pointerId: event.pointerId,
    articleId,
    startX: event.clientX,
    startY: event.clientY,
    dragging: false,
    lastTargetId: null,
    lastDropMode: null,
    sourceEl,
  };
  window.__ttreeDraggingArticleId = articleId;
  if (typeof document !== 'undefined' && document.body) {
    document.body.classList.add('article-dnd-active');
  }
  try {
    const selection = window.getSelection ? window.getSelection() : null;
    if (selection && !selection.isCollapsed) {
      selection.removeAllRanges();
    }
  } catch (_) {
    /* ignore */
  }
  try {
    event.currentTarget?.setPointerCapture?.(event.pointerId);
  } catch (_error) {
    /* ignore */
  }
  window.addEventListener('pointermove', handleTouchArticleMove);
  window.addEventListener('pointerup', handleTouchArticleUp);
  window.addEventListener('pointercancel', handleTouchArticleUp);
}

function handleTouchArticleMove(event) {
  if (!touchArticleDrag || event.pointerId !== touchArticleDrag.pointerId) return;
  const dx = event.clientX - touchArticleDrag.startX;
  const dy = event.clientY - touchArticleDrag.startY;
  if (!touchArticleDrag.dragging) {
    const distance = Math.hypot(dx, dy);
    if (distance < TOUCH_DRAG_THRESHOLD_PX) return;
    touchArticleDrag.dragging = true;
    if (touchArticleDrag.sourceEl instanceof Element) {
      touchArticleDrag.sourceEl.classList.add('article-dnd-source');
    }
  }
  event.preventDefault();
  const li = getArticleItemFromPoint(event.clientX, event.clientY);
  if (!li || !li.dataset || !li.dataset.articleId || li.dataset.articleId === touchArticleDrag.articleId) {
    clearDropIndicators();
    touchArticleDrag.lastTargetId = null;
    touchArticleDrag.lastDropMode = null;
    return;
  }
  const rect = li.getBoundingClientRect();
  const offsetY = event.clientY - rect.top;
  const third = rect.height / 3;
  let dropMode;
  if (offsetY < third) dropMode = 'before';
  else if (offsetY > rect.height - third) dropMode = 'after';
  else dropMode = 'inside';
  touchArticleDrag.lastTargetId = li.dataset.articleId;
  touchArticleDrag.lastDropMode = dropMode;
  setDropIndicator(li, dropMode);
}

function handleTouchArticleUp(event) {
  if (!touchArticleDrag || event.pointerId !== touchArticleDrag.pointerId) return;
  const session = touchArticleDrag;
  cancelTouchArticleDrag();
  if (!session.dragging || !session.lastTargetId || !session.lastDropMode) return;
  if (session.lastTargetId === session.articleId) return;
  commitArticleDrop(session.articleId, session.lastTargetId, session.lastDropMode);
}

export function attachArticleTouchDragSource(element, articleId) {
  if (!element) return;
  if (supportsPointerEvents) {
    element.addEventListener('pointerdown', (event) => {
      if (event.pointerType !== 'touch') return;
      if (typeof event.button === 'number' && event.button !== 0) return;
      if (isArticleInteractiveTarget(event.target)) return;
      const pointerId = event.pointerId;
      const LONG_PRESS_MS = 350;
      let fired = false;
      const timeoutId = window.setTimeout(() => {
        fired = true;
        beginTouchArticleDrag(event, articleId);
      }, LONG_PRESS_MS);

      const cancel = (ev) => {
        if (ev.pointerId !== pointerId) return;
        if (!fired) {
          window.clearTimeout(timeoutId);
        }
        window.removeEventListener('pointerup', cancel, true);
        window.removeEventListener('pointercancel', cancel, true);
      };

      window.addEventListener('pointerup', cancel, true);
      window.addEventListener('pointercancel', cancel, true);
    });
  } else {
    element.addEventListener(
      'touchstart',
      (event) => {
        if (!event.touches || event.touches.length !== 1) return;
        const target = event.target;
        if (isArticleInteractiveTarget(target)) return;
        const LONG_PRESS_MS = 350;
        let fired = false;
        const timeoutId = window.setTimeout(() => {
          fired = true;
          beginLegacyTouchArticleDrag(event, articleId);
        }, LONG_PRESS_MS);

        const cancel = () => {
          if (!fired) {
            window.clearTimeout(timeoutId);
          }
          window.removeEventListener('touchend', cancel, true);
          window.removeEventListener('touchcancel', cancel, true);
        };

        window.addEventListener('touchend', cancel, true);
        window.addEventListener('touchcancel', cancel, true);
      },
      { passive: false },
    );
  }
}

function findArticleById(id) {
  if (!id) return null;
  return (state.articlesIndex || []).find((a) => a.id === id) || null;
}

function getArticleSiblingsSnapshot(parentId) {
  const pid = parentId || null;
  return (state.articlesIndex || [])
    .filter((a) => (a.parentId || null) === pid)
    .sort((a, b) => {
      if (a.position !== b.position) return a.position - b.position;
      return new Date(a.updatedAt || 0) - new Date(b.updatedAt || 0);
    });
}

function applyLocalArticleMove(articleId, parentId, anchorId, placement) {
  if (!articleId) return;
  const dragged = findArticleById(articleId);
  if (!dragged) return;
  const newParentId = parentId || null;
  const oldParentId = dragged.parentId || null;

  const oldSiblings = getArticleSiblingsSnapshot(oldParentId);
  const oldWithout = oldSiblings.filter((a) => a.id !== articleId);

  let baseTarget;
  if (newParentId === oldParentId) {
    baseTarget = oldWithout;
  } else {
    baseTarget = getArticleSiblingsSnapshot(newParentId);
  }

  const targetWithoutDragged = baseTarget.filter((a) => a.id !== articleId);

  let insertionIndex = targetWithoutDragged.length;
  if (anchorId && placement && placement !== 'inside') {
    const idx = targetWithoutDragged.findIndex((a) => a.id === anchorId);
    if (idx !== -1) {
      insertionIndex = placement === 'before' ? idx : idx + 1;
    }
  }
  if (placement === 'inside') {
    insertionIndex = targetWithoutDragged.length;
  }
  if (insertionIndex < 0) insertionIndex = 0;
  if (insertionIndex > targetWithoutDragged.length) insertionIndex = targetWithoutDragged.length;

  const targetOrder = targetWithoutDragged.slice();
  targetOrder.splice(insertionIndex, 0, dragged);

  // Сначала обновляем parentId у перетаскиваемой статьи.
  dragged.parentId = newParentId;

  // Пересчитываем позиции в исходной группе (без перетаскиваемой статьи).
  oldWithout.forEach((item, index) => {
    item.position = index;
  });

  // Пересчитываем позиции в целевой группе.
  targetOrder.forEach((item, index) => {
    item.parentId = newParentId;
    item.position = index;
  });
}

function commitArticleDrop(articleId, targetId, dropMode) {
  if (!articleId || !targetId || !dropMode) return;
  const dragged = findArticleById(articleId);
  const target = findArticleById(targetId);
  if (!dragged || !target) return;

  const parentId = dropMode === 'inside' ? target.id : target.parentId || null;
  const anchorId = dropMode === 'inside' ? null : target.id;

  applyLocalArticleMove(articleId, parentId, anchorId, dropMode);
  renderSidebarArticleListCb?.();
  renderMainArticleListCb?.();

  (async () => {
    try {
      await moveArticleTree(articleId, {
        parentId,
        anchorId,
        placement: dropMode,
      });
    } catch (error) {
      try {
        const articles = await fetchArticlesIndex();
        setArticlesIndexCb?.(articles);
        renderMainArticleListCb?.();
      } catch (_) {
        /* ignore */
      }
      showToast(error.message || 'Не удалось переместить страницу');
    }
  })();
}

function handleArticleDragStart(event) {
  // Сначала пробуем взять id из глобальной переменной (перетаскивание из заголовка статьи).
  if (window.__ttreeDraggingArticleId) {
    draggingArticleId = window.__ttreeDraggingArticleId;
  } else {
    const li = event.currentTarget;
    draggingArticleId = li?.dataset?.articleId || null;
  }
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
    if (draggingArticleId) {
      event.dataTransfer.setData('text/plain', draggingArticleId);
    }
  }
}

function handleArticleDragOver(event) {
  if (!draggingArticleId) {
    const fromWindow = window.__ttreeDraggingArticleId;
    let fromTransfer = null;
    if (!fromWindow && event?.dataTransfer) {
      try {
        fromTransfer = event.dataTransfer.getData('text/plain') || null;
      } catch (_) {
        fromTransfer = null;
      }
    }
    draggingArticleId = fromWindow || fromTransfer || null;
  }
  if (!draggingArticleId) return;
  if (!event.currentTarget || !event.currentTarget.dataset.articleId) return;
  event.preventDefault();
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'move';
  }
  const targetLi = event.currentTarget;
  const rect = targetLi.getBoundingClientRect();
  const offsetY = event.clientY - rect.top;
  const third = rect.height / 3;
  let dropMode;
  if (offsetY < third) dropMode = 'before';
  else if (offsetY > rect.height - third) dropMode = 'after';
  else dropMode = 'inside';
  setDropIndicator(targetLi, dropMode);
}

function handleArticleDrop(event) {
  if (!draggingArticleId) {
    const fromWindow = window.__ttreeDraggingArticleId;
    let fromTransfer = null;
    if (!fromWindow && event?.dataTransfer) {
      try {
        fromTransfer = event.dataTransfer.getData('text/plain') || null;
      } catch (_) {
        fromTransfer = null;
      }
    }
    draggingArticleId = fromWindow || fromTransfer || null;
  }
  if (!draggingArticleId) return;
  const targetLi = event.currentTarget;
  const targetId = targetLi?.dataset?.articleId || null;
  if (!targetId || targetId === draggingArticleId) return;
  event.preventDefault();
  clearDropIndicators();

  const rect = targetLi.getBoundingClientRect();
  const offsetY = event.clientY - rect.top;
  const third = rect.height / 3;
  let dropMode;
  if (offsetY < third) dropMode = 'before';
  else if (offsetY > rect.height - third) dropMode = 'after';
  else dropMode = 'inside';
  commitArticleDrop(draggingArticleId, targetId, dropMode);
  draggingArticleId = null;
}

function handleArticleDragEnd() {
  draggingArticleId = null;
  window.__ttreeDraggingArticleId = null;
  clearDropIndicators();
}

export function attachArticleMouseDnDHandlers(element) {
  if (!element) return;
  element.draggable = true;
  element.addEventListener('dragstart', handleArticleDragStart);
  element.addEventListener('dragover', handleArticleDragOver);
  element.addEventListener('drop', handleArticleDrop);
  element.addEventListener('dragend', handleArticleDragEnd);
}

