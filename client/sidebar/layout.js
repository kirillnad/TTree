// Вынесено из `sidebar.js`: UI-состояния сайдбара (коллапс, мобайл, подсказки, переключение вьюх).

import { state, isHintVisible, setHintVisibility } from '../state.js';
import { refs } from '../refs.js';
import { hideSearchResults } from '../search.js';
import { saveSidebarCollapsedToStorage } from './storage.js';

export function updateTabButtons() {
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

export function hideHintPopover() {
  if (!isHintVisible) return;
  setHintVisibility(false);
  if (refs.hintPopover) refs.hintPopover.classList.add('hidden');
  if (refs.hintToggleBtn) refs.hintToggleBtn.setAttribute('aria-expanded', 'false');
}

export function toggleHintPopover(event) {
  if (event) event.stopPropagation();
  setHintVisibility(!isHintVisible);
  if (refs.hintPopover) refs.hintPopover.classList.toggle('hidden', !isHintVisible);
  if (refs.hintToggleBtn) refs.hintToggleBtn.setAttribute('aria-expanded', !isHintVisible ? 'false' : 'true');
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
  saveSidebarCollapsedToStorage();
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

