// Вынесено из `sidebar.js`: работа с localStorage (состояние сайдбара).

import { state } from '../state.js';

const COLLAPSED_ARTICLES_KEY = 'ttree_collapsed_articles';
const LIST_COLLAPSED_ARTICLES_KEY = 'ttree_list_collapsed_articles';
const SIDEBAR_COLLAPSED_KEY = 'ttree_sidebar_collapsed';

export function loadSidebarCollapsedFromStorage() {
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

export function saveSidebarCollapsedToStorage() {
  try {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, state.isSidebarCollapsed ? '1' : '0');
  } catch (_) {
    /* ignore */
  }
}

export function loadCollapsedArticlesFromStorage() {
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
    localStorage.setItem(COLLAPSED_ARTICLES_KEY, JSON.stringify(state.sidebarCollapsedArticleIds || []));
  } catch (_) {
    /* ignore */
  }
}

export function loadListCollapsedArticlesFromStorage() {
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
    localStorage.setItem(LIST_COLLAPSED_ARTICLES_KEY, JSON.stringify(state.listCollapsedArticleIds || []));
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

