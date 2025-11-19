import { state, isHintVisible, setHintVisibility } from './state.js';
import { refs } from './refs.js';
import { escapeHtml } from './utils.js';
import { navigate, routing } from './routing.js';
import { hideSearchResults } from './search.js';
import { fetchArticlesIndex } from './api.js';

export function setViewMode(showArticle) {
  refs.articleView.classList.toggle('hidden', !showArticle);
  refs.articleListView.classList.toggle('hidden', showArticle);
  if (!showArticle) hideHintPopover();
  if (refs.backToList) refs.backToList.classList.toggle('hidden', !showArticle);
}

export function setArticlesIndex(articles = []) {
  const sorted = Array.isArray(articles) ? [...articles].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)) : [];
  state.articlesIndex = sorted;
  renderSidebarArticleList();
}

export function handleArticleFilterInput(event) {
  state.articleFilterQuery = event.target.value || '';
  renderSidebarArticleList();
  renderMainArticleList();
}

export function upsertArticleIndex(article) {
  if (!article || !article.id) return;
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

export function renderSidebarArticleList(articles = state.articlesIndex) {
  if (!refs.sidebarArticleList) return;
  refs.sidebarArticleList.innerHTML = '';
  const query = (state.articleFilterQuery || '').trim().toLowerCase();
  const filtered = articles.slice().sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)).filter((article) => (!query ? true : (article.title || '').toLowerCase().includes(query)));
  if (!filtered.length) {
    const empty = document.createElement('li');
    empty.className = 'sidebar-article-empty';
    empty.textContent = query ? 'Нет совпадений' : 'Нет статей';
    refs.sidebarArticleList.appendChild(empty);
    return;
  }
  filtered.forEach((article) => {
    const item = document.createElement('li');
    item.className = 'sidebar-article-item';
    const button = document.createElement('button');
    button.type = 'button';
    if (article.id === state.articleId) button.classList.add('active');
    button.innerHTML = `<span>${escapeHtml(article.title || 'Без названия')}</span>`;
    button.addEventListener('click', () => navigate(routing.article(article.id)));
    item.appendChild(button);
    refs.sidebarArticleList.appendChild(item);
  });
}

export function renderMainArticleList(articles = null) {
  if (!refs.articleList) return;
  refs.articleList.innerHTML = '';
  const base = Array.isArray(articles) && articles.length ? articles : state.articlesIndex;
  if (!base.length) {
    const empty = document.createElement('li');
    empty.textContent = 'Пока нет статей. Создайте первую!';
    refs.articleList.appendChild(empty);
    return;
  }
  const query = (state.articleFilterQuery || '').trim().toLowerCase();
  base.slice().sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)).filter((article) => (!query ? true : (article.title || '').toLowerCase().includes(query))).forEach((article) => {
    const item = document.createElement('li');
    item.innerHTML = `
      <span>
        <strong>${escapeHtml(article.title)}</strong><br />
        <small>${new Date(article.updatedAt).toLocaleString()}</small>
      </span>
      <button class="ghost">Открыть</button>
    `;
    item.addEventListener('click', () => navigate(routing.article(article.id)));
    refs.articleList.appendChild(item);
  });
}

export async function ensureArticlesIndexLoaded() {
  if (state.articlesIndex.length) {
    renderSidebarArticleList();
    return state.articlesIndex;
  }
  const articles = await fetchArticlesIndex();
  setArticlesIndex(articles);
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
    refs.sidebarToggle.textContent = collapsed ? '⟩' : '⟨';
  }
  if (collapsed) {
    hideHintPopover();
    hideSearchResults();
  }
}

export function toggleSidebarCollapsed() {
  setSidebarCollapsed(!state.isSidebarCollapsed);
}
