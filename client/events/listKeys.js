// Вынесено из `TTree/client/events.js`:
// - навигация по "Списку статей" (главный список, не сайдбар) через клавиатуру.
import { state } from '../state.js';
import { refs } from '../refs.js';
import { navigate, routing } from '../routing.js';
import { saveListCollapsedArticles, renderMainArticleList, ensureArticlesIndexLoaded } from '../sidebar.js';
import { showToast } from '../toast.js';
import { moveArticlePosition, indentArticleApi, outdentArticleApi } from '../api.js?v=4';

export function handleArticlesListKey(event) {
  const { code, ctrlKey, shiftKey, altKey, metaKey } = event;
  if (altKey || metaKey) return;
  // Работаем в основном в режиме "Список статей":
  if (!refs.articleListView || refs.articleListView.classList.contains('hidden')) return;
  if (!refs.articleList) return;

  const container = refs.articleList;
  const items = Array.from(container.querySelectorAll('li[data-article-id]'));
  if (!items.length) return;

  const selectedId = state.listSelectedArticleId || state.articleId;
  const currentIndex = selectedId && items.findIndex((li) => li.dataset.articleId === selectedId);
  let idx = currentIndex != null && currentIndex >= 0 ? currentIndex : 0;

  const moveSelectionBy = (delta) => {
    if (!items.length) return;
    idx = Math.max(0, Math.min(items.length - 1, idx + delta));
    const li = items[idx];
    if (!li) return;
    const aid = li.dataset.articleId;
    if (!aid) return;
    state.listSelectedArticleId = aid;
    renderMainArticleList();
    li.scrollIntoView({ block: 'nearest' });
  };

  const getCurrentArticleId = () => {
    if (state.listSelectedArticleId) return state.listSelectedArticleId;
    if (state.articleId) return state.articleId;
    const first = items[0];
    return first ? first.dataset.articleId : null;
  };

  const articleId = getCurrentArticleId();
  if (!articleId) return;

  if (!ctrlKey && !shiftKey && (code === 'ArrowDown' || code === 'ArrowUp')) {
    event.preventDefault();
    moveSelectionBy(code === 'ArrowDown' ? 1 : -1);
    return;
  }

  if (!ctrlKey && !shiftKey && (code === 'ArrowLeft' || code === 'ArrowRight')) {
    // Стрелки влево/вправо в списке статей: сворачивание/разворачивание узла.
    // Работает только для статей, у которых есть дети.
    const hasChild = (state.articlesIndex || []).some((a) => (a.parentId || null) === articleId);
    if (!hasChild) return;
    event.preventDefault();
    if (!state.listCollapsedArticleIds) state.listCollapsedArticleIds = [];
    const set = new Set(state.listCollapsedArticleIds);
    if (code === 'ArrowLeft') {
      // Сворачиваем, если ещё не свёрнуто.
      if (!set.has(articleId)) {
        set.add(articleId);
        state.listCollapsedArticleIds = Array.from(set);
        saveListCollapsedArticles();
        renderMainArticleList();
      }
    } else if (code === 'ArrowRight') {
      // Разворачиваем, если было свёрнуто.
      if (set.has(articleId)) {
        set.delete(articleId);
        state.listCollapsedArticleIds = Array.from(set);
        saveListCollapsedArticles();
        renderMainArticleList();
      }
    }
    return;
  }

  if (!ctrlKey && !shiftKey && code === 'Enter') {
    event.preventDefault();
    state.listSelectedArticleId = articleId;
    navigate(routing.article(articleId));
    return;
  }

  if (ctrlKey && shiftKey && (code === 'ArrowUp' || code === 'ArrowDown')) {
    event.preventDefault();
    moveArticlePosition(articleId, code === 'ArrowUp' ? 'up' : 'down')
      .then(() => ensureArticlesIndexLoaded())
      .then((articles) => renderMainArticleList(articles))
      .catch((error) => showToast(error.message || 'Не удалось переместить страницу'));
    return;
  }

  if (ctrlKey && !shiftKey && code === 'ArrowRight') {
    event.preventDefault();
    indentArticleApi(articleId)
      .then(() => ensureArticlesIndexLoaded())
      .then((articles) => renderMainArticleList(articles))
      .catch((error) => showToast(error.message || 'Не удалось изменить вложенность'));
    return;
  }
  if (ctrlKey && !shiftKey && code === 'ArrowLeft') {
    event.preventDefault();
    outdentArticleApi(articleId)
      .then(() => ensureArticlesIndexLoaded())
      .then((articles) => renderMainArticleList(articles))
      .catch((error) => showToast(error.message || 'Не удалось изменить вложенность'));
    return;
  }
}
