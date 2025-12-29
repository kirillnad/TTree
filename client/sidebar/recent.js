// Вынесено из `sidebar.js`: режим "Последние" и учёт последних открытий.

import { state } from '../state.js';
import { renderSidebarArticleList, scrollSidebarSelectionIntoView } from './render.js';
import { ensureSidebarSelectionVisible } from './storage.js';

const SIDEBAR_ARTICLES_MODE_KEY = 'ttree_sidebar_articles_mode';
const RECENT_ARTICLES_KEY = 'ttree_recent_articles';
const RECENT_ARTICLES_LIMIT = 300;

export function initRecentFromStorage() {
  try {
    const raw = window.localStorage.getItem(SIDEBAR_ARTICLES_MODE_KEY) || '';
    const mode = (raw || '').trim().toLowerCase();
    if (mode === 'recent' || mode === 'tree') {
      state.sidebarArticlesMode = mode;
    }
  } catch (_) {
    /* ignore */
  }

  try {
    const raw = window.localStorage.getItem(RECENT_ARTICLES_KEY) || '[]';
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      state.recentArticleIds = parsed
        .filter((id) => typeof id === 'string' && id && id !== 'inbox')
        .slice(0, RECENT_ARTICLES_LIMIT);
    }
  } catch (_) {
    /* ignore */
  }
}

function saveSidebarArticlesMode() {
  try {
    window.localStorage.setItem(SIDEBAR_ARTICLES_MODE_KEY, state.sidebarArticlesMode || 'tree');
  } catch (_) {
    /* ignore */
  }
}

function saveRecentArticles() {
  try {
    const list = Array.isArray(state.recentArticleIds) ? state.recentArticleIds : [];
    window.localStorage.setItem(RECENT_ARTICLES_KEY, JSON.stringify(list.slice(0, RECENT_ARTICLES_LIMIT)));
  } catch (_) {
    /* ignore */
  }
}

export function toggleSidebarRecentMode() {
  const prev = state.sidebarArticlesMode;
  const next = state.sidebarArticlesMode === 'recent' ? 'tree' : 'recent';
  state.sidebarArticlesMode = next;
  saveSidebarArticlesMode();
  if (prev === 'recent' && next === 'tree') ensureSidebarSelectionVisible();
  renderSidebarArticleList();
  if (prev === 'recent' && next === 'tree') {
    window.requestAnimationFrame(() => {
      try {
        scrollSidebarSelectionIntoView();
      } catch {
        // ignore
      }
    });
  }
}

export function recordArticleOpened(articleId) {
  if (!articleId || articleId === 'inbox') return;
  if (state.isPublicView) return;
  const current = Array.isArray(state.recentArticleIds) ? state.recentArticleIds : [];
  const next = [articleId, ...current.filter((id) => id !== articleId)];
  state.recentArticleIds = next.slice(0, RECENT_ARTICLES_LIMIT);
  saveRecentArticles();
  if (state.sidebarArticlesMode === 'recent') {
    renderSidebarArticleList();
  }
}
