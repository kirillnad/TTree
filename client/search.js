import { state } from './state.js';
import { refs } from './refs.js';
import { escapeHtml, escapeRegExp, htmlToLines, htmlToPlainText, logDebug } from './utils.js';
import { apiRequest, search as apiSearch, semanticSearch, ragSummary } from './api.js?v=12';
import { navigate, routing } from './routing.js';
import { setSidebarMobileOpen } from './sidebar.js';
import { hideToast, showPersistentToast } from './toast.js';
import { localClassicSearch } from './offline/search.js';

function textToLines(text = '') {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''));
}

function highlightSnippet(snippet = '') {
  const term = state.searchQuery.trim();
  if (!term) return escapeHtml(snippet);
  const regex = new RegExp(escapeRegExp(term), 'gi');
  return escapeHtml(snippet).replace(regex, (match) => `<mark>${match}</mark>`);
}

function updateRagOpenButton() {
  if (!refs.ragOpenBtn) return;
  if (state.sidebarSearchView !== 'search') {
    refs.ragOpenBtn.classList.add('hidden');
    return;
  }
  const shouldShow =
    state.searchMode === 'semantic' &&
    Boolean(state.searchQuery.trim()) &&
    !state.searchLoading &&
    !state.searchError &&
    Array.isArray(state.searchResults) &&
    state.searchResults.length > 0;
  refs.ragOpenBtn.classList.toggle('hidden', !shouldShow);
}

export function renderSearchResults() {
  if (!refs.searchResults) return;
  if (state.sidebarSearchView !== 'search') {
    refs.searchResults.classList.add('hidden');
    refs.searchResults.innerHTML = '';
    updateRagOpenButton();
    return;
  }
  const query = state.searchQuery.trim();
  if (!query) {
    refs.searchResults.classList.add('hidden');
    refs.searchResults.innerHTML = '';
    updateRagOpenButton();
    return;
  }
  refs.searchResults.classList.remove('hidden');
  if (state.searchLoading) {
    refs.searchResults.innerHTML = '<div class="search-result-empty">Поиск...</div>';
    updateRagOpenButton();
    return;
  }
  if (state.searchError) {
    refs.searchResults.innerHTML = `<div class="search-result-empty">${escapeHtml(state.searchError)}</div>`;
    updateRagOpenButton();
    return;
  }
  if (!state.searchResults.length) {
    refs.searchResults.innerHTML = '<div class="search-result-empty">Ничего не найдено</div>';
    updateRagOpenButton();
    return;
  }
  refs.searchResults.innerHTML = '';
  state.searchResults.forEach((result) => {
    const isArticle = result.type === 'article';
    const item = document.createElement('div');
    item.className = 'search-result-item';
    let titleText = result.articleTitle || ' ';
    let sectionTitle = '';
    let articleTitle = result.articleTitle || '';
    if (!isArticle) {
      const lines = textToLines(result.blockText || '');
      const firstNonEmptyIndex = lines.findIndex((line) => line.trim() !== '');
      sectionTitle = firstNonEmptyIndex >= 0 ? (lines[firstNonEmptyIndex] || '').trim() : '';
      // Для блока заголовком результата является заголовок секции (1-я строка текста).
      titleText = sectionTitle || articleTitle || ' ';
    }
    const titleContent = highlightSnippet(titleText || ' ');
    const typeLabel = isArticle ? 'Статья' : 'Блок';
    let snippetContent = '';
    if (!isArticle) {
      const lines = textToLines(result.blockText || '');
      const firstNonEmptyIndex = lines.findIndex((line) => line.trim() !== '');
      const bodyLines =
        firstNonEmptyIndex >= 0
          ? lines.slice(firstNonEmptyIndex + 1).filter((line) => line.trim() !== '')
          : lines.filter((line) => line.trim() !== '');
      const previewLines = bodyLines.slice(0, 2);
      const preview = previewLines.map((line) => highlightSnippet(line)).join('<br />');
      const articleMeta = articleTitle ? `<div class="search-result-item__article">${escapeHtml(articleTitle)}</div>` : '';
      snippetContent = `${articleMeta}${preview ? `<div>${preview}</div>` : ''}`;
    }
    item.innerHTML = `
      <div class="search-result-item__header">
        <span class="search-result-item__badge">${typeLabel}</span>
        <span class="search-result-item__title">${titleContent}</span>
      </div>
      ${snippetContent ? `<div class="search-result-item__snippet">${snippetContent}</div>` : ''}
    `;
    item.addEventListener('mousedown', (event) => {
      event.preventDefault();
      handleSearchResultClick(result);
    });
    refs.searchResults.appendChild(item);
  });
  updateRagOpenButton();
}

export function hideSearchResults() {
  if (!refs.searchResults) return;
  refs.searchResults.classList.add('hidden');
}

async function clientSideSearch(query, limit = 20) {
  const term = (query || '').trim().toLowerCase();
  if (!term) return [];
  const results = [];
  try {
    const articles = await apiRequest('/api/articles');
    for (const article of articles) {
      const data = await apiRequest(`/api/articles/${article.id}`);
      const traverse = (blocks = []) => {
        for (const block of blocks) {
          const plain = htmlToPlainText(block.text || '');
          if (plain.toLowerCase().includes(term)) {
            const idx = plain.toLowerCase().indexOf(term);
            const start = Math.max(0, idx - 40);
            const end = Math.min(plain.length, idx + term.length + 40);
            results.push({
              articleId: data.id,
              articleTitle: data.title,
              blockId: block.id,
              snippet: plain.slice(start, end),
            });
            if (results.length >= limit) return true;
          }
          if (block.children?.length) {
            if (traverse(block.children)) return true;
          }
        }
        return false;
      };
      if (traverse(data.blocks || []) || results.length >= limit) break;
    }
  } catch (error) {
    throw new Error(error.message || 'Ошибка локального поиска');
  }
  return results;
}

export async function handleSearchInput(event) {
  if (state.sidebarSearchView !== 'search') {
    hideSearchResults();
    updateRagOpenButton();
    return;
  }
  const value = event.target.value;
  state.searchQuery = value;
  if (!value.trim()) {
    state.searchResults = [];
    state.searchError = '';
    state.searchLoading = false;
    renderSearchResults();
    return;
  }
  state.searchLoading = true;
  const requestId = Date.now();
  state.searchRequestId = requestId;
  renderSearchResults();
  try {
    let data = null;
    if (state.searchMode !== 'semantic') {
      // classic search: try local first to avoid server CPU and work offline
      try {
        data = await localClassicSearch(value);
      } catch {
        data = null;
      }
    }
    if (!data) {
      const searchFn = state.searchMode === 'semantic' ? semanticSearch : apiSearch;
      data = await searchFn(value);
    }
    if (state.searchRequestId === requestId) {
      state.searchResults = data;
      state.searchError = '';
    }
  } catch (error) {
    if (state.searchRequestId === requestId) {
      state.searchError = error.message;
    }
  } finally {
    if (state.searchRequestId === requestId) {
      state.searchLoading = false;
      renderSearchResults();
    }
  }
}

function handleSearchResultClick(result) {
  hideSearchResults();
  if (refs.searchInput) refs.searchInput.value = '';
  state.searchQuery = '';
  state.searchResults = [];
  state.searchError = '';
  updateRagOpenButton();
  const isArticle = result.type === 'article';
  state.scrollTargetBlockId = isArticle ? null : result.blockId;
  state.currentBlockId = isArticle ? null : result.blockId;
  if (state.isSidebarMobileOpen) {
    setSidebarMobileOpen(false);
  }
  navigate(routing.article(result.articleId));
}

export function openRagPageFromCurrentSearch() {
  const query = state.searchQuery.trim();
  if (!query) return;
  if (state.searchMode !== 'semantic') return;
  if (state.searchLoading || state.searchError) return;
  if (!Array.isArray(state.searchResults) || !state.searchResults.length) return;
  state.ragQuery = query;
  // Сохраняем «снимок» результатов: пользователь может продолжить вводить в поиске.
  state.ragResults = JSON.parse(JSON.stringify(state.searchResults));
  state.ragSummaryHtml = '';
  state.ragSummaryError = '';
  state.ragSummaryLoading = true;
  state.scrollTargetBlockId = null;
  state.currentBlockId = null;
  navigate(routing.article('RAG'));

  // Генерируем резюме в фоне (результат будет показан в верхнем блоке RAG).
  (async () => {
    showPersistentToast('Генерирую сводку…', { protect: true });
    try {
      const data = await ragSummary(state.ragQuery, state.ragResults);
      state.ragSummaryHtml = (data && data.summaryHtml) || '';
      state.ragSummaryError = '';
    } catch (error) {
      state.ragSummaryError = error.message || 'Не удалось получить резюме';
      state.ragSummaryHtml = '';
    } finally {
      state.ragSummaryLoading = false;
      hideToast({ force: true });
      // Если пользователь всё ещё на странице RAG — пересоберём виртуальную статью,
      // чтобы верхний блок подхватил state.ragSummaryHtml/state.ragSummaryError.
      if (state.articleId === 'RAG') {
        navigate(routing.article('RAG'));
      }
    }
  })();
}
