import { state } from './state.js';
import { refs } from './refs.js';
import { escapeHtml, escapeRegExp, htmlToLines, htmlToPlainText, logDebug } from './utils.js';
import { apiRequest, search as apiSearch, semanticSearch } from './api.js?v=2';
import { navigate, routing } from './routing.js';
import { setSidebarMobileOpen } from './sidebar.js';

function highlightSnippet(snippet = '') {
  const term = state.searchQuery.trim();
  if (!term) return escapeHtml(snippet);
  const regex = new RegExp(escapeRegExp(term), 'gi');
  return escapeHtml(snippet).replace(regex, (match) => `<mark>${match}</mark>`);
}

export function renderSearchResults() {
  if (!refs.searchResults) return;
  const query = state.searchQuery.trim();
  if (!query) {
    refs.searchResults.classList.add('hidden');
    refs.searchResults.innerHTML = '';
    return;
  }
  refs.searchResults.classList.remove('hidden');
  if (state.searchLoading) {
    refs.searchResults.innerHTML = '<div class="search-result-empty">Поиск...</div>';
    return;
  }
  if (state.searchError) {
    refs.searchResults.innerHTML = `<div class="search-result-empty">${escapeHtml(state.searchError)}</div>`;
    return;
  }
  if (!state.searchResults.length) {
    refs.searchResults.innerHTML = '<div class="search-result-empty">Ничего не найдено</div>';
    return;
  }
  refs.searchResults.innerHTML = '';
  state.searchResults.forEach((result) => {
    const isArticle = result.type === 'article';
    const item = document.createElement('div');
    item.className = 'search-result-item';
    const titleContent = highlightSnippet(result.articleTitle || ' ');
    const typeLabel = isArticle ? 'Статья' : 'Блок';
    let snippetContent = '';
    if (!isArticle) {
      const lines = htmlToLines(result.blockText || '');
      const previewLines = lines.slice(0, 2);
      snippetContent = previewLines.length
        ? previewLines.map((line) => highlightSnippet(line)).join('<br />')
        : highlightSnippet(result.snippet || '');
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
    const searchFn = state.searchMode === 'semantic' ? semanticSearch : apiSearch;
    const data = await searchFn(value);
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
  const isArticle = result.type === 'article';
  state.scrollTargetBlockId = isArticle ? null : result.blockId;
  state.currentBlockId = isArticle ? null : result.blockId;
  if (state.isSidebarMobileOpen) {
    setSidebarMobileOpen(false);
  }
  navigate(routing.article(result.articleId));
}
