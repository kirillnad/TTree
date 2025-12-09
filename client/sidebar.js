import { state, isHintVisible, setHintVisibility } from './state.js';
import { refs } from './refs.js';
import { escapeHtml } from './utils.js';
import { navigate, routing } from './routing.js';
import { hideSearchResults } from './search.js';
import {
  fetchArticlesIndex,
  fetchDeletedArticlesIndex,
  restoreArticle as restoreArticleApi,
  deleteArticle as deleteArticleApi,
  moveArticleTree,
} from './api.js?v=2';
import { showToast } from './toast.js';

const FAVORITES_KEY = 'ttree_favorites';
const COLLAPSED_ARTICLES_KEY = 'ttree_collapsed_articles';
const LIST_COLLAPSED_ARTICLES_KEY = 'ttree_list_collapsed_articles';
const SIDEBAR_COLLAPSED_KEY = 'ttree_sidebar_collapsed';

let draggingArticleId = null;
let currentDropLi = null;
const TOUCH_DRAG_THRESHOLD_PX = 6;
let touchArticleDrag = null;

function cancelTouchArticleDrag() {
  if (!touchArticleDrag) return;
  window.removeEventListener('pointermove', handleTouchArticleMove);
  window.removeEventListener('pointerup', handleTouchArticleUp);
  window.removeEventListener('pointercancel', handleTouchArticleUp);
  touchArticleDrag = null;
  clearDropIndicators();
  window.__ttreeDraggingArticleId = null;
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
  touchArticleDrag = {
    pointerId: event.pointerId,
    articleId,
    startX: event.clientX,
    startY: event.clientY,
    dragging: false,
    lastTargetId: null,
    lastDropMode: null,
  };
  window.__ttreeDraggingArticleId = articleId;
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
    if (Math.hypot(dx, dy) < TOUCH_DRAG_THRESHOLD_PX) return;
    touchArticleDrag.dragging = true;
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
  renderSidebarArticleList();
  renderMainArticleList();

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
        setArticlesIndex(articles);
        renderMainArticleList();
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
  const li = event.currentTarget;
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
    if (draggingArticleId) {
      event.dataTransfer.setData('text/plain', draggingArticleId);
    }
  }
}

function handleArticleDragOver(event) {
  if (!draggingArticleId && window.__ttreeDraggingArticleId) {
    draggingArticleId = window.__ttreeDraggingArticleId;
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
}

function handleArticleDragEnd() {
  draggingArticleId = null;
  clearDropIndicators();
}

function loadFavorites() {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    state.favoriteArticles = Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    state.favoriteArticles = [];
  }
}

function saveFavorites() {
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(state.favoriteArticles || []));
  } catch (_) {
    /* ignore */
  }
}

function loadCollapsedArticles() {
  try {
    const raw = localStorage.getItem(COLLAPSED_ARTICLES_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    state.sidebarCollapsedArticleIds = Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    state.sidebarCollapsedArticleIds = [];
  }
}

export function saveCollapsedArticles() {
  try {
    localStorage.setItem(
      COLLAPSED_ARTICLES_KEY,
      JSON.stringify(state.sidebarCollapsedArticleIds || []),
    );
  } catch (_) {
    /* ignore */
  }
}

export function ensureSidebarSelectionVisible() {
  const selectedId = state.sidebarSelectedArticleId || state.articleId;
  if (!selectedId) return;
  const source = state.isTrashView ? state.deletedArticlesIndex : state.articlesIndex;
  if (!Array.isArray(source) || !source.length) return;
  const byId = new Map(source.map((a) => [a.id, a]));
  const collapsed = new Set(state.sidebarCollapsedArticleIds || []);
  const visited = new Set();
  let current = byId.get(selectedId) || null;
  while (current && current.parentId && !visited.has(current.parentId)) {
    visited.add(current.parentId);
    collapsed.delete(current.parentId);
    current = byId.get(current.parentId) || null;
  }
  state.sidebarCollapsedArticleIds = Array.from(collapsed);
  saveCollapsedArticles();
}

function loadListCollapsedArticles() {
  try {
    const raw = localStorage.getItem(LIST_COLLAPSED_ARTICLES_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    state.listCollapsedArticleIds = Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    state.listCollapsedArticleIds = [];
  }
}

export function saveListCollapsedArticles() {
  try {
    localStorage.setItem(
      LIST_COLLAPSED_ARTICLES_KEY,
      JSON.stringify(state.listCollapsedArticleIds || []),
    );
  } catch (_) {
    /* ignore */
  }
}

function loadSidebarCollapsed() {
  try {
    const raw = localStorage.getItem(SIDEBAR_COLLAPSED_KEY);
    if (raw === '1') {
      state.isSidebarCollapsed = true;
    } else if (raw === '0') {
      state.isSidebarCollapsed = false;
    }
  } catch (_) {
    /* ignore */
  }
}

function saveSidebarCollapsed() {
  try {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, state.isSidebarCollapsed ? '1' : '0');
  } catch (_) {
    /* ignore */
  }
}

export function initSidebarStateFromStorage() {
  loadSidebarCollapsed();
  loadCollapsedArticles();
  loadListCollapsedArticles();
  if (refs.sidebar) {
    setSidebarCollapsed(state.isSidebarCollapsed);
  }
}

function sortArticles(arr = []) {
  const favs = new Set(state.favoriteArticles || []);
  return [...arr].sort((a, b) => {
    const fa = favs.has(a.id);
    const fb = favs.has(b.id);
    if (fa !== fb) return fa ? -1 : 1;
    return new Date(b.updatedAt || b.deletedAt || 0) - new Date(a.updatedAt || a.deletedAt || 0);
  });
}

export function toggleFavorite(articleId) {
  if (!articleId) return;
  if (!state.favoriteArticles) state.favoriteArticles = [];
  const set = new Set(state.favoriteArticles);
  if (set.has(articleId)) set.delete(articleId);
  else set.add(articleId);
  state.favoriteArticles = Array.from(set);
  saveFavorites();
  renderSidebarArticleList();
  renderMainArticleList();
}

export function setViewMode(showArticle) {
  refs.articleView.classList.toggle('hidden', !showArticle);
  refs.articleListView.classList.toggle('hidden', showArticle);
  if (refs.articleHeader) refs.articleHeader.classList.toggle('hidden', !showArticle);
  if (!showArticle) hideHintPopover();
  if (showArticle && state.isTrashView) {
    state.isTrashView = false;
    updateTabButtons();
  }
}

export function setArticlesIndex(articles = []) {
  if (!state.favoriteArticles || !state.favoriteArticles.length) loadFavorites();
  const list = Array.isArray(articles) ? articles : [];
  // Сохраняем плоский список, но с полями parentId/position.
  state.articlesIndex = list.map((a) => ({
    id: a.id,
    title: a.title || 'Без названия',
    updatedAt: a.updatedAt || new Date().toISOString(),
    deletedAt: a.deletedAt || null,
    publicSlug: a.publicSlug || null,
    parentId: a.parentId || null,
    position: typeof a.position === 'number' ? a.position : 0,
  }));
  // Очищаем список схлопнутых узлов от несуществующих id.
  const existing = new Set(state.articlesIndex.map((a) => a.id));
  if (Array.isArray(state.sidebarCollapsedArticleIds) && state.sidebarCollapsedArticleIds.length) {
    state.sidebarCollapsedArticleIds = state.sidebarCollapsedArticleIds.filter((id) => existing.has(id));
    saveCollapsedArticles();
  }
  if (Array.isArray(state.listCollapsedArticleIds) && state.listCollapsedArticleIds.length) {
    state.listCollapsedArticleIds = state.listCollapsedArticleIds.filter((id) => existing.has(id));
    saveListCollapsedArticles();
  }
  renderSidebarArticleList();
}

export function setDeletedArticlesIndex(articles = []) {
  const sorted = sortArticles(Array.isArray(articles) ? articles : []);
  state.deletedArticlesIndex = sorted;
  renderSidebarArticleList();
}

export function handleArticleFilterInput(event) {
  state.articleFilterQuery = event.target.value || '';
  renderSidebarArticleList();
}

export function upsertArticleIndex(article) {
  if (!article || !article.id || article.deletedAt) return;
  const summary = {
    id: article.id,
    title: article.title || 'Без названия',
    updatedAt: article.updatedAt || new Date().toISOString(),
    publicSlug: article.publicSlug || null,
    parentId: article.parentId || null,
    position: typeof article.position === 'number' ? article.position : 0,
  };
  const idx = state.articlesIndex.findIndex((item) => item.id === summary.id);
  if (idx >= 0) {
    state.articlesIndex[idx] = { ...state.articlesIndex[idx], ...summary };
  } else {
    state.articlesIndex.unshift(summary);
  }
  renderSidebarArticleList();
}

export function removeArticleFromIndex(articleId) {
  if (!articleId) return;
  const before = state.articlesIndex.length;
  state.articlesIndex = state.articlesIndex.filter((item) => item.id !== articleId);
  if (before !== state.articlesIndex.length) {
    renderSidebarArticleList();
    renderMainArticleList();
  }
}

export function removeArticleFromTrashIndex(articleId) {
  if (!articleId) return;
  const before = state.deletedArticlesIndex.length;
  state.deletedArticlesIndex = state.deletedArticlesIndex.filter((item) => item.id !== articleId);
  if (before !== state.deletedArticlesIndex.length) {
    renderSidebarArticleList();
    renderMainArticleList();
  }
}

function formatArticleDate(article) {
  const raw = article.deletedAt || article.updatedAt || new Date().toISOString();
  return new Date(raw).toLocaleString();
}

function buildArticleTree(list = []) {
  const byId = new Map();
  list.forEach((a) => {
    byId.set(a.id, { ...a, children: [] });
  });
  const roots = [];
  byId.forEach((node) => {
    const pid = node.parentId || null;
    if (pid && byId.has(pid)) {
      byId.get(pid).children.push(node);
    } else {
      roots.push(node);
    }
  });
  const sortRecursive = (nodes) => {
    nodes.sort((a, b) => {
      const fa = (state.favoriteArticles || []).includes(a.id);
      const fb = (state.favoriteArticles || []).includes(b.id);
      if (fa !== fb) return fa ? -1 : 1;
      if (a.position !== b.position) return a.position - b.position;
      return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
    });
    nodes.forEach((n) => sortRecursive(n.children || []));
  };
  sortRecursive(roots);
  return roots;
}

export function renderSidebarArticleList() {
  if (!refs.sidebarArticleList) return;
  refs.sidebarArticleList.innerHTML = '';
  const query = (state.articleFilterQuery || '').trim().toLowerCase();
  const source = state.isTrashView ? state.deletedArticlesIndex : state.articlesIndex;
  const favs = new Set(state.favoriteArticles || []);
  const collapsedSet = new Set(state.sidebarCollapsedArticleIds || []);
  const selectedId = state.sidebarSelectedArticleId || state.articleId;

  // Отдельно считаем наличие детей по полному списку (без фильтра),
  // чтобы иконка «есть дети» не пропадала из‑за фильтрации.
  const hasChildren = new Set();
  (source || []).forEach((article) => {
    const pid = article.parentId || null;
    if (pid) hasChildren.add(pid);
  });

  const base = (source || []).filter(
    (article) =>
      (!query ? true : (article.title || 'Без названия').toLowerCase().includes(query)) &&
      (!state.isTrashView ? article.id !== 'inbox' : true),
  );
  if (!base.length) {
    const empty = document.createElement('li');
    empty.className = 'sidebar-article-empty';
    empty.textContent = state.isTrashView
      ? query
        ? 'No deleted pages match the filter'
        : 'Trash is empty'
      : query
        ? 'Нет совпадений'
        : 'Нет статей';
    refs.sidebarArticleList.appendChild(empty);
    return;
  }

  const tree = buildArticleTree(base);

  const renderNode = (node, depth) => {
    const li = document.createElement('li');
    li.className = 'sidebar-article-item';
    if (hasChildren.has(node.id)) {
      li.classList.add('has-children');
      if (collapsedSet.has(node.id)) li.classList.add('is-collapsed');
    }
    li.dataset.articleId = node.id;
    li.style.paddingLeft = `${depth * 1.25}rem`;

    const row = document.createElement('div');
    row.className = 'sidebar-article-row';

    const button = document.createElement('button');
    button.type = 'button';
    if (!state.isTrashView && node.id === selectedId) button.classList.add('active');
    const isFav = favs.has(node.id);
    const titleText = escapeHtml(node.title || 'Без названия');
    const publicIcon = node.publicSlug ? '\uE909 ' : '';
    button.innerHTML = `<span class="sidebar-article-title">${publicIcon}${titleText}</span><span class="star-btn ${isFav ? 'active' : ''}" aria-label="Избранное" title="${isFav ? 'Убрать из избранного' : 'В избранное'}">${isFav ? '\uE735' : '\uE734'}</span>`;
    button.addEventListener('click', () => {
      // Игнорируем клик только если перетаскивание запущено из заголовка статьи.
      if (window.__ttreeDraggingArticleId) return;
      // Одинарный клик: выделяем статью и сворачиваем/разворачиваем потомков только в сайдбаре.
      state.sidebarSelectedArticleId = node.id;
      if (!state.sidebarCollapsedArticleIds) state.sidebarCollapsedArticleIds = [];
      const set = new Set(state.sidebarCollapsedArticleIds);
      if (set.has(node.id)) set.delete(node.id);
      else set.add(node.id);
      state.sidebarCollapsedArticleIds = Array.from(set);
      saveCollapsedArticles();
      renderSidebarArticleList();
    });
    button.addEventListener('dblclick', (event) => {
      // Двойной клик: открываем статью.
      event.preventDefault();
      event.stopPropagation();
      state.sidebarSelectedArticleId = node.id;
      navigate(routing.article(node.id));
      if (state.isSidebarMobileOpen) {
        setSidebarMobileOpen(false);
      }
    });
    const star = button.querySelector('.star-btn');
    if (star) {
      star.addEventListener('click', (event) => {
        event.stopPropagation();
        toggleFavorite(node.id);
      });
    }
    row.appendChild(button);

    li.appendChild(row);
    if (!state.isTrashView) {
      li.draggable = true;
      li.addEventListener('dragstart', handleArticleDragStart);
      li.addEventListener('dragover', handleArticleDragOver);
      li.addEventListener('drop', handleArticleDrop);
      li.addEventListener('dragend', handleArticleDragEnd);
      li.addEventListener('pointerdown', (event) => {
        if (event.pointerType !== 'touch') return;
        if (typeof event.button === 'number' && event.button !== 0) return;
        if (event.target instanceof Element && event.target.closest('button')) return;
        beginTouchArticleDrag(event, node.id);
      });
    }
    refs.sidebarArticleList.appendChild(li);
    if (!collapsedSet.has(node.id)) {
      (node.children || []).forEach((child) => renderNode(child, depth + 1));
    }
  };

  tree.forEach((root) => renderNode(root, 0));
}

export function renderMainArticleList(articles = null) {
  if (!refs.articleList) return;
  refs.articleList.innerHTML = '';
  const query = '';
  const base = Array.isArray(articles) && articles.length ? articles : (state.isTrashView ? state.deletedArticlesIndex : state.articlesIndex);
  const favs = new Set(state.favoriteArticles || []);
  const collapsedSet = new Set(state.listCollapsedArticleIds || []);
  const selectedId = state.listSelectedArticleId || state.articleId;
  // Наличие детей считаем по полному списку (base), не по отфильтрованному дереву.
  const hasChildren = new Set();
  base.forEach((article) => {
    const pid = article.parentId || null;
    if (pid) hasChildren.add(pid);
  });
  if (!base.length) {
    const empty = document.createElement('li');
    empty.textContent = state.isTrashView ? (query ? 'No deleted pages match the filter' : 'Trash is empty') : (query ? 'Ничего не найдено' : 'Список пуст.');
    refs.articleList.appendChild(empty);
    return;
  }
  if (state.isTrashView) {
    base
      .slice()
      .filter(
        (article) =>
          (!query ? true : (article.title || 'Без названия').toLowerCase().includes(query)) &&
          (!state.isTrashView ? article.id !== 'inbox' : true),
      )
      .forEach((article) => {
        const item = document.createElement('li');
        item.dataset.articleId = article.id;
        item.innerHTML = `
      <span>
        <strong>${escapeHtml(article.title)}</strong>
      </span>
      <div class="row-actions">
        <button class="ghost restore-btn" data-id="${article.id}">Восстановить</button>
        <button class="ghost danger delete-btn" data-id="${article.id}">Удалить</button>
      </div>
    `;
        const restoreBtn = item.querySelector('.restore-btn');
        const deleteBtn = item.querySelector('.delete-btn');
        if (restoreBtn) {
          restoreBtn.addEventListener('click', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            await restoreFromTrash(article.id);
          });
        }
        if (deleteBtn) {
          deleteBtn.addEventListener('click', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            await deleteFromTrash(article.id);
          });
        }
        refs.articleList.appendChild(item);
      });
    return;
  }

  const filtered = base
    .slice()
    .filter(
      (article) =>
        (!query ? true : (article.title || 'Без названия').toLowerCase().includes(query)) &&
        article.id !== 'inbox',
    );
  const tree = buildArticleTree(filtered);

  const renderItem = (article, depth) => {
    const item = document.createElement('li');
    if (hasChildren.has(article.id)) {
      item.classList.add('has-children');
      if (collapsedSet.has(article.id)) item.classList.add('is-collapsed');
    }
    item.dataset.articleId = article.id;
    const isFav = favs.has(article.id);
    const titleText = escapeHtml(article.title || 'Без названия');
    const publicIcon = article.publicSlug ? '\uE909 ' : '';
    item.style.paddingLeft = `${depth * 1.25}rem`;
    item.innerHTML = `
      <span>
        <strong>${publicIcon}${titleText}</strong>
      </span>
      <button class="ghost star-btn ${isFav ? 'active' : ''}" aria-label="Избранное" title="${isFav ? 'Убрать из избранного' : 'В избранное'}">${isFav ? '\uE735' : '\uE734'}</button>
    `;
    const star = item.querySelector('.star-btn');
    if (star) {
      star.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleFavorite(article.id);
      });
    }
    if (article.id === selectedId) {
      item.classList.add('active-article');
    }
    item.addEventListener('click', () => {
      // Если сейчас выполняется перетаскивание из заголовка статьи,
      // не трогаем состояние свёрнутости при "клике" после дропа.
      if (window.__ttreeDraggingArticleId) return;
      // Одинарный клик: выделяем и сворачиваем/разворачиваем потомков только в списке статей.
      state.listSelectedArticleId = article.id;
      if (!state.listCollapsedArticleIds) state.listCollapsedArticleIds = [];
      const set = new Set(state.listCollapsedArticleIds);
      if (set.has(article.id)) set.delete(article.id);
      else set.add(article.id);
      state.listCollapsedArticleIds = Array.from(set);
      saveListCollapsedArticles();
      renderMainArticleList();
    });
    item.addEventListener('dblclick', (event) => {
      // Двойной клик: открываем статью.
      event.preventDefault();
      event.stopPropagation();
      state.listSelectedArticleId = article.id;
      navigate(routing.article(article.id));
    });
    refs.articleList.appendChild(item);
    if (!state.isTrashView) {
      item.draggable = true;
      item.addEventListener('dragstart', handleArticleDragStart);
      item.addEventListener('dragover', handleArticleDragOver);
      item.addEventListener('drop', handleArticleDrop);
      item.addEventListener('dragend', handleArticleDragEnd);
      item.addEventListener('pointerdown', (event) => {
        if (event.pointerType !== 'touch') return;
        if (typeof event.button === 'number' && event.button !== 0) return;
        if (event.target instanceof Element && event.target.closest('button')) return;
        beginTouchArticleDrag(event, article.id);
      });
    }
    if (!collapsedSet.has(article.id)) {
      (article.children || []).forEach((child) => renderItem(child, depth + 1));
    }
  };

  tree.forEach((root) => renderItem(root, 0));
}

async function restoreFromTrash(articleId) {
  if (!articleId) return;
  try {
    const article = await restoreArticleApi(articleId);
    removeArticleFromTrashIndex(articleId);
    upsertArticleIndex(article);
    await setTrashMode(false);
    navigate(routing.article(article.id));
    showToast('Page restored');
  } catch (error) {
    showToast(error.message);
  }
}

async function deleteFromTrash(articleId) {
  if (!articleId) return;
  try {
    await deleteArticleApi(articleId, { force: true });
    removeArticleFromTrashIndex(articleId);
    showToast('Статья удалена безвозвратно');
    renderMainArticleList();
    renderSidebarArticleList();
  } catch (error) {
    showToast(error.message);
  }
}

function updateTabButtons() {
  if (refs.articlesTabBtn) {
    refs.articlesTabBtn.classList.toggle('active', !state.isTrashView);
    refs.articlesTabBtn.setAttribute('aria-pressed', state.isTrashView ? 'false' : 'true');
  }
  if (refs.trashTabBtn) {
    refs.trashTabBtn.classList.toggle('active', state.isTrashView);
    refs.trashTabBtn.setAttribute('aria-pressed', state.isTrashView ? 'true' : 'false');
  }
  if (refs.createArticleBtn) refs.createArticleBtn.disabled = state.isTrashView;
  if (refs.sidebarNewArticleBtn) refs.sidebarNewArticleBtn.disabled = state.isTrashView;
}

export async function setTrashMode(enabled) {
  state.isTrashView = enabled;
  updateTabButtons();
  if (enabled) {
    await ensureDeletedArticlesIndexLoaded();
  } else {
    await ensureArticlesIndexLoaded();
  }
  renderSidebarArticleList();
  renderMainArticleList();
}

export async function ensureArticlesIndexLoaded() {
  if (state.articlesIndex.length) {
    if (!state.isTrashView) renderSidebarArticleList();
    return state.articlesIndex;
  }
  const articles = await fetchArticlesIndex();
  setArticlesIndex(articles);
  return articles;
}

export async function ensureDeletedArticlesIndexLoaded() {
  if (state.deletedArticlesIndex.length) {
    if (state.isTrashView) renderSidebarArticleList();
    return state.deletedArticlesIndex;
  }
  const articles = await fetchDeletedArticlesIndex();
  setDeletedArticlesIndex(articles);
  return articles;
}

export function toggleHintPopover(event) {
  if (event) event.stopPropagation();
  setHintVisibility(!isHintVisible);
  if (refs.hintPopover) refs.hintPopover.classList.toggle('hidden', !isHintVisible);
  if (refs.hintToggleBtn) refs.hintToggleBtn.setAttribute('aria-expanded', !isHintVisible ? 'false' : 'true');
}

export function hideHintPopover() {
  if (!isHintVisible) return;
  setHintVisibility(false);
  if (refs.hintPopover) refs.hintPopover.classList.add('hidden');
  if (refs.hintToggleBtn) refs.hintToggleBtn.setAttribute('aria-expanded', 'false');
}

export function setSidebarCollapsed(collapsed) {
  if (!refs.sidebar) return;
  state.isSidebarCollapsed = collapsed;
  refs.sidebar.classList.toggle('collapsed', collapsed);
  if (refs.sidebarToggle) {
    refs.sidebarToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    refs.sidebarToggle.title = collapsed ? 'Показать панель' : 'Свернуть панель';
    refs.sidebarToggle.textContent = collapsed ? '→' : 'x';
  }
  saveSidebarCollapsed();
  if (collapsed) {
    hideHintPopover();
    hideSearchResults();
  }
}

export function toggleSidebarCollapsed() {
  setSidebarCollapsed(!state.isSidebarCollapsed);
}

export function setSidebarMobileOpen(open) {
  state.isSidebarMobileOpen = open;
  if (refs.sidebar) refs.sidebar.classList.toggle('mobile-open', open);
  if (refs.sidebarBackdrop) refs.sidebarBackdrop.classList.toggle('hidden', !open);
  if (open) {
    hideHintPopover();
    hideSearchResults();
  }
}

export function closeSidebarMobile() {
  setSidebarMobileOpen(false);
}

export function toggleSidebarMobile() {
  setSidebarMobileOpen(!state.isSidebarMobileOpen);
}
