// Вынесено из `article.js`: UI заголовка статьи и подписи публичной ссылки.

import { state } from '../state.js';
import { refs } from '../refs.js';

export function updatePublicToggleLabel() {
  if (!refs.articlePublicToggleBtn) return;
  const slug = state.article?.publicSlug || null;
  refs.articlePublicToggleBtn.textContent = slug ? 'Отменить доступ по ссылке' : 'Дать доступ по ссылке';
}

export function updateArticleHeaderUi() {
  const article = state.article;
  if (!article) return;
  const titleText = article.title || 'Без названия';
  if (refs.articleTitle) {
    refs.articleTitle.textContent = titleText;
    refs.articleTitle.classList.toggle('article-title--encrypted', Boolean(article.encrypted));
    refs.articleTitle.classList.toggle('hidden', state.isEditingTitle);
  }
  if (refs.articleTitleInput) {
    if (!state.isEditingTitle) {
      refs.articleTitleInput.value = titleText;
    }
    refs.articleTitleInput.classList.toggle('hidden', !state.isEditingTitle);
  }
  if (refs.editTitleBtn) {
    refs.editTitleBtn.classList.toggle('hidden', state.isEditingTitle);
  }
  if (refs.articleFavoriteBtn) {
    const favs = new Set(state.favoriteArticles || []);
    const isFav = favs.has(article.id);
    refs.articleFavoriteBtn.textContent = isFav ? '\uE735' : '\uE734';
    refs.articleFavoriteBtn.title = isFav ? 'Убрать из избранного' : 'Добавить в избранное';
  }
  if (refs.articlePublicLinkBtn) {
    const hasPublic = Boolean(article.publicSlug);
    refs.articlePublicLinkBtn.classList.toggle('hidden', !hasPublic);
    if (hasPublic) {
      refs.articlePublicLinkBtn.title = 'Скопировать публичную ссылку';
    }
  }
  if (refs.deleteArticleBtn) {
    refs.deleteArticleBtn.classList.toggle('hidden', article.id === 'inbox');
  }
  if (refs.articleEncryptionBtn) {
    refs.articleEncryptionBtn.textContent = article.encrypted ? 'Сменить пароль' : 'Зашифровать';
  }
  if (refs.articleEncryptionRemoveBtn) {
    refs.articleEncryptionRemoveBtn.classList.toggle('hidden', !article.encrypted);
  }
  if (refs.updatedAt) {
    if (state.isOutlineEditing) {
      refs.updatedAt.textContent = state.outlineStatusText || '';
    } else if (article.updatedAt) {
      refs.updatedAt.textContent = `Обновлено: ${new Date(article.updatedAt).toLocaleString()}`;
    } else {
      refs.updatedAt.textContent = '';
    }
  }

  if (refs.articleStatusText) {
    if (state.isOutlineEditing) {
      refs.articleStatusText.textContent = state.outlineStatusText || '';
    } else if (article.updatedAt) {
      refs.articleStatusText.textContent = `Обновлено: ${new Date(article.updatedAt).toLocaleString()}`;
    } else {
      refs.articleStatusText.textContent = '';
    }
  }

  if (refs.mediaStatusText) {
    refs.mediaStatusText.textContent = state.mediaStatusText || '';
  }
  if (refs.mediaPrefetchToggleBtn) {
    const paused = Boolean(state.mediaPrefetchPaused);
    refs.mediaPrefetchToggleBtn.textContent = paused ? 'Продолжить' : 'Пауза';
    refs.mediaPrefetchToggleBtn.classList.toggle('is-active', paused);
  }
}
