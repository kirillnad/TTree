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
} from './api.js';
import { showToast } from './toast.js';

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

function toggleFavorite(articleId) {
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
  if (!showArticle) hideHintPopover();
  if (showArticle && state.isTrashView) {
    state.isTrashView = false;
    updateTabButtons();
  }
}

export function setArticlesIndex(articles = []) {
  if (!state.favoriteArticles || !state.favoriteArticles.length) loadFavorites();
  const sorted = sortArticles(Array.isArray(articles) ? articles : []);
  state.articlesIndex = sorted;
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
  renderMainArticleList();
}

export function upsertArticleIndex(article) {
  if (!article || !article.id || article.deletedAt) return;
  const summary = {
    id: article.id,
    title: article.title || 'Без названия',
    updatedAt: article.updatedAt || new Date().toISOString(),
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

export function renderSidebarArticleList() {
  if (!refs.sidebarArticleList) return;
  refs.sidebarArticleList.innerHTML = '';
  const query = (state.articleFilterQuery || '').trim().toLowerCase();
  const source = state.isTrashView ? state.deletedArticlesIndex : state.articlesIndex;
  const favs = new Set(state.favoriteArticles || []);
  const filtered = source
    .slice()
    .sort((a, b) => {
      const fa = favs.has(a.id);
      const fb = favs.has(b.id);
      if (fa !== fb) return fa ? -1 : 1;
      return new Date(b.deletedAt || b.updatedAt) - new Date(a.deletedAt || a.updatedAt);
    })
    .filter(
      (article) =>
        (!query ? true : (article.title || 'Без названия').toLowerCase().includes(query)) &&
        (!state.isTrashView ? article.id !== 'inbox' : true),
    );
  if (!filtered.length) {
    const empty = document.createElement('li');
    empty.className = 'sidebar-article-empty';
    empty.textContent = state.isTrashView ? (query ? 'No deleted pages match the filter' : 'Trash is empty') : (query ? 'Нет совпадений' : 'Нет статей');
    refs.sidebarArticleList.appendChild(empty);
    return;
  }
  filtered.forEach((article) => {
    const item = document.createElement('li');
    item.className = 'sidebar-article-item';
    const button = document.createElement('button');
    button.type = 'button';
    if (!state.isTrashView && article.id === state.articleId) button.classList.add('active');
    const isFav = favs.has(article.id);
    button.innerHTML = `<span>${escapeHtml(article.title || 'Без названия')}</span><span class="star-btn ${isFav ? 'active' : ''}" aria-label="Избранное" title="${isFav ? 'Убрать из избранного' : 'В избранное'}">${isFav ? '★' : '☆'}</span>`;
    button.addEventListener('click', () => {
      navigate(routing.article(article.id));
      // Автоматически закрываем сайдбар на мобильном.
      if (state.isSidebarMobileOpen) {
        setSidebarMobileOpen(false);
      }
    });
    const star = button.querySelector('.star-btn');
    if (star) {
      star.addEventListener('click', (event) => {
        event.stopPropagation();
        toggleFavorite(article.id);
      });
    }
    item.appendChild(button);
    refs.sidebarArticleList.appendChild(item);
  });
}

export function renderMainArticleList(articles = null) {
  if (!refs.articleList) return;
  refs.articleList.innerHTML = '';
  const query = (state.articleFilterQuery || '').trim().toLowerCase();
  const base = Array.isArray(articles) && articles.length ? articles : (state.isTrashView ? state.deletedArticlesIndex : state.articlesIndex);
  const favs = new Set(state.favoriteArticles || []);
  if (!base.length) {
    const empty = document.createElement('li');
    empty.textContent = state.isTrashView ? (query ? 'No deleted pages match the filter' : 'Trash is empty') : (query ? 'Ничего не найдено' : 'Список пуст.');
    refs.articleList.appendChild(empty);
    return;
  }
  base
    .slice()
    .sort((a, b) => {
      const fa = favs.has(a.id);
      const fb = favs.has(b.id);
      if (fa !== fb) return fa ? -1 : 1;
      return new Date(b.deletedAt || b.updatedAt) - new Date(a.deletedAt || a.updatedAt);
    })
    .filter(
      (article) =>
        (!query ? true : (article.title || 'Без названия').toLowerCase().includes(query)) &&
        (!state.isTrashView ? article.id !== 'inbox' : true),
    )
    .forEach((article) => {
      const item = document.createElement('li');
      if (state.isTrashView) {
        item.innerHTML = `
      <span>
        <strong>${escapeHtml(article.title)}</strong><br />
        <small>${formatArticleDate(article)}</small>
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
      } else {
        const isFav = favs.has(article.id);
        item.innerHTML = `
      <span>
        <strong>${escapeHtml(article.title)}</strong><br />
        <small>${new Date(article.updatedAt).toLocaleString()}</small>
      </span>
      <button class="ghost star-btn ${isFav ? 'active' : ''}" aria-label="Избранное" title="${isFav ? 'Убрать из избранного' : 'В избранное'}">${isFav ? '★' : '☆'}</button>
    `;
        const star = item.querySelector('.star-btn');
        if (star) {
          star.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            toggleFavorite(article.id);
          });
        }
        item.addEventListener('click', () => navigate(routing.article(article.id)));
      }
      refs.articleList.appendChild(item);
    });
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
