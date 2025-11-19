import { state, isSavingTitle, setSavingTitle } from './state.js';
import { refs } from './refs.js';
import { apiRequest } from './api.js';
import { showToast } from './toast.js';
import { renderArticle } from './article.js';
import { upsertArticleIndex } from './sidebar.js';
import { renderSearchResults } from './search.js';

function focusTitleInput() {
  if (!refs.articleTitleInput) return;
  requestAnimationFrame(() => {
    refs.articleTitleInput.focus();
    refs.articleTitleInput.select();
  });
}

export function startTitleEditingMode() {
  if (!state.article || !refs.articleTitleInput) return;
  if (state.mode === 'edit') {
    showToast('Сначала завершите редактирование блока');
    return;
  }
  if (state.isEditingTitle) {
    focusTitleInput();
    return;
  }
  state.isEditingTitle = true;
  refs.articleTitleInput.value = state.article.title || '';
  renderArticle();
  focusTitleInput();
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
    showToast('Заголовок обновлён');
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
