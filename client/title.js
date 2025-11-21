import { state, isSavingTitle, setSavingTitle } from './state.js';
import { refs } from './refs.js';
import { apiRequest, deleteArticle } from './api.js';
import { showToast } from './toast.js';
import { renderArticle } from './article.js';
import { upsertArticleIndex, removeArticleFromIndex } from './sidebar.js';
import { renderSearchResults } from './search.js';
import { navigate, routing } from './routing.js';
import { showConfirm } from './modal.js';

let isArticleMenuOpen = false;

function focusTitleInput() {
  if (!refs.articleTitleInput) return;
  requestAnimationFrame(() => {
    refs.articleTitleInput.focus();
    refs.articleTitleInput.select();
  });
}

export function startTitleEditingMode() {
  if (!state.article || !refs.articleTitleInput) return;
  if (state.isEditingTitle) {
    focusTitleInput();
    return;
  }
  state.isEditingTitle = true;
  refs.articleTitleInput.value = state.article.title || '';
  renderArticle();
  focusTitleInput();
}

export function handleTitleClick() {
  if (!state.article) return;
  if (state.isEditingTitle) return;
  startTitleEditingMode();
}

function cancelTitleEditingMode() {
  if (!state.isEditingTitle) return;
  state.isEditingTitle = false;
  if (refs.articleTitleInput && state.article) {
    refs.articleTitleInput.value = state.article.title || '';
  }
  renderArticle();
}

function updateSearchTitlesCache(article) {
  if (!article) return;
  let changed = false;
  state.searchResults = state.searchResults.map((result) => {
    if (result.articleId === article.id && result.articleTitle !== article.title) {
      changed = true;
      return { ...result, articleTitle: article.title };
    }
    return result;
  });
  if (changed) renderSearchResults();
}

async function saveTitleEditingMode() {
  if (!state.isEditingTitle || !refs.articleTitleInput || !state.articleId || !state.article) return;
  const newTitle = refs.articleTitleInput.value.trim();
  const currentTitle = (state.article.title || '').trim();
  if (newTitle === currentTitle) {
    state.isEditingTitle = false;
    renderArticle();
    return;
  }
  if (isSavingTitle) return;
  setSavingTitle(true);
  refs.articleTitleInput.disabled = true;
  try {
    const updatedArticle = await apiRequest(`/api/articles/${state.articleId}`, {
      method: 'PATCH',
      body: JSON.stringify({ title: newTitle }),
    });
    state.article = { ...state.article, title: updatedArticle.title, updatedAt: updatedArticle.updatedAt };
    upsertArticleIndex(updatedArticle);
    state.isEditingTitle = false;
    renderArticle();
    updateSearchTitlesCache(updatedArticle);
    showToast('Заголовок обновлен');
  } catch (error) {
    showToast(error.message);
  } finally {
    setSavingTitle(false);
    if (refs.articleTitleInput) refs.articleTitleInput.disabled = false;
  }
}

export function handleTitleInputKeydown(event) {
  if (!state.isEditingTitle) return;
  if (event.code === 'Enter') saveTitleEditingMode();
  else if (event.code === 'Escape') cancelTitleEditingMode();
}

export function handleTitleInputBlur() {
  if (!state.isEditingTitle || isSavingTitle) return;
  saveTitleEditingMode();
}

function setArticleMenuVisibility(open) {
  if (!refs.articleMenu || !refs.articleMenuBtn) return;
  isArticleMenuOpen = open;
  refs.articleMenu.classList.toggle('hidden', !open);
  refs.articleMenuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
}

export function toggleArticleMenu(event) {
  if (event) event.stopPropagation();
  if (!state.article) return;
  setArticleMenuVisibility(!isArticleMenuOpen);
}

export function closeArticleMenu() {
  setArticleMenuVisibility(false);
}

export function isArticleMenuVisible() {
  return isArticleMenuOpen;
}

export async function handleDeleteArticle(event) {
  if (event) event.stopPropagation();
  closeArticleMenu();
  if (!state.articleId) return;
  let confirmed = false;
  try {
    confirmed = await showConfirm({
      title: 'Удалить статью?',
      message: 'Действие нельзя отменить.',
      confirmText: 'Удалить',
      cancelText: 'Отмена',
    });
  } catch (error) {
    confirmed = window.confirm('Удалить статью?');
  }
  if (!confirmed) return;
  try {
    await deleteArticle(state.articleId);
    removeArticleFromIndex(state.articleId);
    state.article = null;
    state.articleId = null;
    state.currentBlockId = null;
    navigate(routing.list);
    showToast('Статья удалена');
  } catch (error) {
    showToast(error.message);
  }
}
