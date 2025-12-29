// Вынесено из `sidebar.js`: рендер сайдбара и списка статей + операции над индексами.

import { state } from '../state.js';
import { refs } from '../refs.js';
import { escapeHtml } from '../utils.js';
import { navigate, routing } from '../routing.js';
import {
  fetchArticlesIndex,
  fetchDeletedArticlesIndex,
  restoreArticle as restoreArticleApi,
  deleteArticle as deleteArticleApi,
} from '../api.js?v=11';
import { showToast } from '../toast.js';
import { updateTabButtons, hideHintPopover, setSidebarMobileOpen } from './layout.js';
import { saveCollapsedArticles, saveListCollapsedArticles, ensureSidebarSelectionVisible } from './storage.js';
import { attachArticleMouseDnDHandlers, attachArticleTouchDragSource } from './dnd.js';

const FAVORITES_KEY = 'ttree_favorites';

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
  const prevTrimmed = (state.articleFilterQuery || '').trim();
  const nextRaw = event?.target?.value || '';
  const nextTrimmed = String(nextRaw || '').trim();
  state.articleFilterQuery = nextRaw;
  const shouldRevealSelection = Boolean(prevTrimmed && !nextTrimmed && state.sidebarArticlesMode !== 'recent');
  if (shouldRevealSelection) ensureSidebarSelectionVisible();
  renderSidebarArticleList();
  if (shouldRevealSelection) {
    window.requestAnimationFrame(() => {
      try {
        scrollSidebarSelectionIntoView();
      } catch {
        // ignore
      }
    });
  }
}

export function scrollSidebarArticleIntoView(articleId) {
  const id = String(articleId || '').trim();
  if (!id || !refs?.sidebarArticleList) return;
  const row =
    refs.sidebarArticleList.querySelector(`li.sidebar-article-item[data-article-id="${CSS.escape(id)}"]`) ||
    refs.sidebarArticleList.querySelector(`li[data-article-id="${CSS.escape(id)}"]`);
  if (!row) return;
  try {
    row.scrollIntoView({ block: 'center', inline: 'nearest' });
  } catch {
    // ignore
  }
}

export function scrollSidebarSelectionIntoView() {
  const selectedId = state.sidebarSelectedArticleId || state.articleId;
  if (!selectedId) return;
  scrollSidebarArticleIntoView(selectedId);
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
  if (refs.backToList) refs.backToList.classList.toggle('active', state.sidebarArticlesMode !== 'recent');
  if (refs.sidebarRecentBtn) refs.sidebarRecentBtn.classList.toggle('active', state.sidebarArticlesMode === 'recent');
  const query = (state.articleFilterQuery || '').trim().toLowerCase();
  const mode = state.sidebarArticlesMode === 'recent' ? 'recent' : 'tree';
  const source = state.isTrashView ? state.deletedArticlesIndex : state.articlesIndex;
  const favs = new Set(state.favoriteArticles || []);
  const collapsedSet = new Set(state.sidebarCollapsedArticleIds || []);
  const selectedId = state.sidebarSelectedArticleId || state.articleId;
  const recentIds = Array.isArray(state.recentArticleIds) ? state.recentArticleIds : [];

  // Виртуальные статьи (например, RAG) — не приходят с сервера, но должны
  // отображаться в "Последние" и/или "Избранные".
  const virtual = [];
  const shouldIncludeRag =
    !state.isTrashView && (favs.has('RAG') || (mode === 'recent' && recentIds.includes('RAG')));
  if (shouldIncludeRag) {
    const ragQuery = (state.ragQuery || '').trim();
    virtual.push({
      id: 'RAG',
      title: ragQuery ? `AI: ${ragQuery}` : 'AI: результаты поиска',
      updatedAt: new Date().toISOString(),
      deletedAt: null,
      publicSlug: null,
      parentId: null,
      position: 0,
    });
  }
  const virtualSet = new Set(virtual.map((v) => v.id));
  const mergedSource =
    virtual.length && !state.isTrashView
      ? [...(source || []).filter((a) => !virtualSet.has(a.id)), ...virtual]
      : source;

  // Отдельно считаем наличие детей по полному списку (без фильтра),
  // чтобы иконка «есть дети» не пропадала из‑за фильтрации.
  const hasChildren = new Set();
  (mergedSource || []).forEach((article) => {
    const pid = article.parentId || null;
    if (pid) hasChildren.add(pid);
  });

  const base = (mergedSource || []).filter(
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

  if (mode === 'recent') {
    const byId = new Map(base.map((a) => [a.id, a]));
    const recentSet = new Set(recentIds);
    const recentList = recentIds.map((id) => byId.get(id)).filter(Boolean);
    const rest = sortArticles(base.filter((a) => !recentSet.has(a.id)));
    const flat = [...recentList, ...rest];
    flat.forEach((node) => {
      const li = document.createElement('li');
      li.className = 'sidebar-article-item';
      li.dataset.articleId = node.id;

      const row = document.createElement('div');
      row.className = 'sidebar-article-row';

      const button = document.createElement('button');
      button.type = 'button';
      if (!state.isTrashView && node.id === selectedId) button.classList.add('active');
      const isFav = favs.has(node.id);
      const titleText = escapeHtml(node.title || 'Без названия');
      const publicIcon = node.publicSlug ? '\uE774 ' : '';
      button.innerHTML = `<span class="sidebar-article-title">${publicIcon}${titleText}</span><span class="star-btn ${isFav ? 'active' : ''}" aria-label="Избранное" title="${isFav ? 'Убрать из избранного' : 'В избранное'}">${isFav ? '\uE735' : '\uE734'}</span>`;
      button.addEventListener('click', () => {
        if (window.__ttreeDraggingArticleId) return;
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
      refs.sidebarArticleList.appendChild(li);
    });
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
    const publicIcon = node.publicSlug ? '\uE774 ' : '';
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
      // HTML5 DnD для мыши/трекпада (десктоп).
      // На мобильных dragstart почти никогда не срабатывает, поэтому это не мешает touch‑DND.
      attachArticleMouseDnDHandlers(li);
      attachArticleTouchDragSource(li, node.id);
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
  const base =
    Array.isArray(articles) && articles.length
      ? articles
      : state.isTrashView
        ? state.deletedArticlesIndex
        : state.articlesIndex;
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
    empty.textContent = state.isTrashView
      ? query
        ? 'No deleted pages match the filter'
        : 'Trash is empty'
      : query
        ? 'Ничего не найдено'
        : 'Список пуст.';
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
    const publicIcon = article.publicSlug ? '<span class="article-public-icon">&#xE774;</span>' : '';
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
      // Мышиный DnD в списке статей.
      attachArticleMouseDnDHandlers(item);
      attachArticleTouchDragSource(item, article.id);
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

// При переключении режима просмотра (список/статья) стараемся не держать открытыми поповеры.
export function hideSidebarAuxUiWhenLeavingList() {
  hideHintPopover();
}
