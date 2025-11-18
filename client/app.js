const state = {
  mode: 'view',
  articleId: null,
  article: null,
  currentBlockId: null,
  editingBlockId: null,
  undoStack: [],
  redoStack: [],
  pendingTextPreview: null,
  searchQuery: '',
  searchResults: [],
  searchError: '',
  searchLoading: false,
  searchRequestId: 0,
  scrollTargetBlockId: null,
  isEditingTitle: false,
  isSidebarCollapsed: false,
  articlesIndex: [],
  articleFilterQuery: '',
};

let isSavingTitle = false;
let isHintVisible = false;

function logDebug(...args) {
  // eslint-disable-next-line no-console
  console.log('[undo]', ...args);
}

function refreshLastChangeTimestamp() {
  if (!refs.lastChangeValue) return;
  if (!state.lastChangeTimestamp) {
    refs.lastChangeValue.textContent = 'нет данных';
    return;
  }
  const lastChange = new Date(state.lastChangeTimestamp);
  refs.lastChangeValue.textContent = lastChange.toLocaleString();
}

async function loadLastChangeFromChangelog() {
  try {
    const resp = await fetch('/changelog.txt', { cache: 'no-store' });
    if (!resp.ok) throw new Error('Не удалось загрузить changelog');
    const text = await resp.text();
    const lines = text.trim().split(/\r?\n/).filter((line) => line.trim());
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const match = lines[i].match(/^\[([^\]]+)\]/);
      if (match) {
        state.lastChangeTimestamp = match[1];
        refreshLastChangeTimestamp();
        return;
      }
    }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('changelog load error', error);
  }
}

const refs = {
  articleListView: document.getElementById('articleListView'),
  articleView: document.getElementById('articleView'),
  articleTitle: document.getElementById('articleTitle'),
  updatedAt: document.getElementById('updatedAt'),
  blocksContainer: document.getElementById('blocksContainer'),
  articleList: document.getElementById('articleList'),
  createArticleBtn: document.getElementById('createArticleBtn'),
  backToList: document.getElementById('backToList'),
  toast: document.getElementById('toast'),
  searchInput: document.getElementById('searchInput'),
  searchResults: document.getElementById('searchResults'),
  searchPanel: document.querySelector('.search-panel'),
  articleTitleInput: document.getElementById('articleTitleInput'),
  editTitleBtn: document.getElementById('editTitleBtn'),
  hintToggleBtn: document.getElementById('hintToggleBtn'),
  hintPopover: document.getElementById('hintPopover'),
  sidebar: document.getElementById('sidebar'),
  sidebarToggle: document.getElementById('sidebarToggle'),
  sidebarArticleList: document.getElementById('sidebarArticleList'),
  sidebarNewArticleBtn: document.getElementById('sidebarNewArticleBtn'),
  articleFilterInput: document.getElementById('articleFilterInput'),
  lastChangeValue: document.getElementById('lastChangeValue'),
};

const routing = {
  list: '/',
  article: (id) => `/article/${id}`,
};

async function apiRequest(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  if (!response.ok) {
    const details = await response.json().catch(() => ({}));
    throw new Error(details.message || 'Ошибка запроса');
  }
  return response.json();
}

function showToast(message) {
  refs.toast.textContent = message;
  refs.toast.classList.remove('hidden');
  requestAnimationFrame(() => {
    refs.toast.classList.add('show');
  });
  setTimeout(() => {
    refs.toast.classList.remove('show');
    setTimeout(() => refs.toast.classList.add('hidden'), 200);
  }, 2500);
}

function escapeHtml(text = '') {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function highlightSnippet(snippet = '') {
  const term = state.searchQuery.trim();
  if (!term) return escapeHtml(snippet);
  const regex = new RegExp(escapeRegExp(term), 'gi');
  return escapeHtml(snippet).replace(regex, (match) => `<mark>${match}</mark>`);
}

function renderSearchResults() {
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
    const item = document.createElement('div');
    item.className = 'search-result-item';
    const lines = htmlToLines(result.blockText || '');
    const previewLines = lines.slice(0, 2);
    const previewContent = previewLines.length
      ? previewLines.map((line) => highlightSnippet(line)).join('<br />')
      : highlightSnippet(result.snippet || '');
    item.innerHTML = `
      <div class="search-result-item__title">${escapeHtml(result.articleTitle || '����� ������')}</div>
      <div class="search-result-item__snippet">${previewContent}</div>
    `;
    item.addEventListener('mousedown', (event) => {
      event.preventDefault();
      handleSearchResultClick(result);
    });
    refs.searchResults.appendChild(item);
  });
}

function setArticlesIndex(articles = []) {
  const sorted = Array.isArray(articles)
    ? [...articles].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    : [];
  state.articlesIndex = sorted;
  renderSidebarArticleList();
}

function handleArticleFilterInput(event) {
  state.articleFilterQuery = event.target.value || '';
  renderSidebarArticleList();
  renderMainArticleList();
}

function upsertArticleIndex(article) {
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

function renderSidebarArticleList(articles = state.articlesIndex) {
  if (!refs.sidebarArticleList) return;
  refs.sidebarArticleList.innerHTML = '';
  const query = (state.articleFilterQuery || '').trim().toLowerCase();
  const filtered = articles
    .slice()
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .filter((article) => (!query ? true : (article.title || '').toLowerCase().includes(query)));
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
    if (article.id === state.articleId) {
      button.classList.add('active');
    }
    button.innerHTML = `<span>${escapeHtml(article.title || 'Без названия')}</span>`;
    button.addEventListener('click', () => navigate(routing.article(article.id)));
    item.appendChild(button);
    refs.sidebarArticleList.appendChild(item);
  });
}

async function fetchArticlesIndex() {
  const articles = await apiRequest('/api/articles');
  setArticlesIndex(articles);
  return articles;
}

async function ensureArticlesIndexLoaded() {
  if (state.articlesIndex.length) {
    renderSidebarArticleList();
    return state.articlesIndex;
  }
  return fetchArticlesIndex();
}

function hideSearchResults() {
  if (!refs.searchResults) return;
  refs.searchResults.classList.add('hidden');
}

async function handleSearchInput(event) {
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
    const response = await fetch(`/api/search?q=${encodeURIComponent(value.trim())}`);
    if (!response.ok) {
      const details = await response.json().catch(() => ({}));
      throw new Error(details.message || 'Ошибка поиска');
    }
    if (state.searchRequestId !== requestId) return;
    const data = await response.json();
    state.searchResults = data;
    state.searchError = '';
  } catch (error) {
    if (state.searchRequestId !== requestId) return;
    logDebug('search API failed, fallback to client search', error.message);
    state.searchLoading = true;
    renderSearchResults();
    try {
      const fallback = await clientSideSearch(value.trim(), 20);
      if (state.searchRequestId !== requestId) return;
      state.searchResults = fallback;
      state.searchError = fallback.length ? '' : 'Ничего не найдено';
    } catch (fallbackError) {
      if (state.searchRequestId !== requestId) return;
      state.searchResults = [];
      state.searchError = fallbackError.message || error.message;
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
  if (refs.searchInput) {
    refs.searchInput.value = '';
  }
  state.searchQuery = '';
  state.searchResults = [];
  state.searchError = '';
  state.scrollTargetBlockId = result.blockId;
  state.currentBlockId = result.blockId;
  navigate(routing.article(result.articleId));
}

function htmlToPlainText(html = '') {
  const template = document.createElement('template');
  template.innerHTML = html || '';
  return (template.content.textContent || '').replace(/\s+/g, ' ').trim();
}


function htmlToLines(html = '') {
  const normalized = (html || '')
    .replace(/<br\s*\/?/gi, '\n')
    .replace(/<\/(?:div|p|li|h[1-6])>/gi, '\n');
  const template = document.createElement('template');
  template.innerHTML = normalized;
  return (template.content.textContent || '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length);
}

async function clientSideSearch(query, limit = 20) {
  const term = (query || '').trim().toLowerCase();
  if (!term) {
    return [];
  }
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
            const snippet = plain.slice(start, end);
            results.push({
              articleId: data.id,
              articleTitle: data.title,
              blockId: block.id,
              snippet,
            });
            if (results.length >= limit) {
              return true;
            }
          }
          if (block.children?.length) {
            const stop = traverse(block.children);
            if (stop) return true;
          }
        }
        return false;
      };
      const shouldStop = traverse(data.blocks || []);
      if (results.length >= limit || shouldStop) {
        break;
      }
    }
  } catch (error) {
    throw new Error(error.message || 'Ошибка локального поиска');
  }
  return results;
}

function navigate(path) {
  if (window.location.pathname === path) {
    route(path);
    return;
  }
  window.history.pushState({}, '', path);
  route(path);
}

function route(pathname) {
  const match = pathname.match(/^\/article\/([0-9a-fA-F-]+)/);
  if (match) {
    loadArticleView(match[1]);
    return;
  }
  loadListView();
}

function setViewMode(showArticle) {
  refs.articleView.classList.toggle('hidden', !showArticle);
  refs.articleListView.classList.toggle('hidden', showArticle);
  if (!showArticle) {
    hideHintPopover();
  }
  if (refs.backToList) {
    refs.backToList.classList.toggle('hidden', !showArticle);
  }
}

async function loadListView() {
  state.article = null;
  state.articleId = null;
  state.currentBlockId = null;
  state.mode = 'view';
  state.editingBlockId = null;
  state.undoStack = [];
  state.redoStack = [];
  clearPendingTextPreview({ restoreDom: false });
  setViewMode(false);
  try {
    const articles = await fetchArticlesIndex();
    renderMainArticleList(articles);
  } catch (error) {
    refs.articleList.innerHTML = `<li>Не удалось загрузить список: ${error.message}</li>`;
  }
}

function renderMainArticleList(articles = null) {
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
  base
    .slice()
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .filter((article) => (!query ? true : (article.title || '').toLowerCase().includes(query)))
    .forEach((article) => {
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

async function loadArticle(id, options = {}) {
  const { desiredBlockId, resetUndoStacks } = options;
  const switchingArticle = state.articleId !== id;
  state.articleId = id;
  state.mode = state.mode === 'edit' ? 'view' : state.mode;
  state.editingBlockId = null;
  const article = await apiRequest(`/api/articles/${id}`);
  state.article = article;
  state.isEditingTitle = false;
  const shouldResetUndo = typeof resetUndoStacks === 'boolean' ? resetUndoStacks : switchingArticle;
  if (shouldResetUndo) {
    hydrateUndoRedoFromArticle(article);
  }
  let targetSet = false;
  if (desiredBlockId) {
    const desired = findBlock(desiredBlockId);
    if (desired) {
      await expandCollapsedAncestors(desired.block.id);
      state.currentBlockId = desired.block.id;
      targetSet = true;
    }
  }
  if (!targetSet && (switchingArticle || !findBlock(state.currentBlockId))) {
    const firstBlock = flattenVisible(article.blocks)[0];
    state.currentBlockId = firstBlock ? firstBlock.id : null;
  }
  upsertArticleIndex(article);
  return article;
}

async function loadArticleView(id) {
  await ensureArticlesIndexLoaded();
  setViewMode(true);
  refs.blocksContainer.innerHTML = 'Загрузка...';
  try {
    const desired = state.scrollTargetBlockId || undefined;
    await loadArticle(id, { resetUndoStacks: true, desiredBlockId: desired });
    renderArticle();
  } catch (error) {
    refs.blocksContainer.innerHTML = `<p class="meta">Не удалось загрузить статью: ${error.message}</p>`;
  }
}

function flattenVisible(blocks = [], acc = []) {
  blocks.forEach((block) => {
    acc.push(block);
    if (!block.collapsed && block.children?.length) {
      flattenVisible(block.children, acc);
    }
  });
  return acc;
}

function findBlock(blockId, blocks = state.article?.blocks || [], parent = null, ancestors = []) {
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    if (block.id === blockId) {
      return { block, parent, index: i, siblings: blocks, ancestors };
    }
    const nested = findBlock(blockId, block.children || [], block, [...ancestors, block]);
    if (nested) {
      return nested;
    }
  }
  return null;
}

function setCurrentBlock(blockId) {
  if (!blockId) return;
  if (state.currentBlockId === blockId) return;
  state.currentBlockId = blockId;
  renderArticle();
}

function isSeparatorNode(node) {
  if (!node) return false;
  if (node.nodeType === Node.TEXT_NODE) {
    return /\n\s*\n/.test(node.textContent || '');
  }
  if (node.nodeType === Node.ELEMENT_NODE) {
    if (node.tagName === 'BR') return true;
    if (
      (node.tagName === 'P' || node.tagName === 'DIV') &&
      node.innerHTML.replace(/<br\s*\/?>/gi, '').trim() === ''
    ) {
      return true;
    }
  }
  return false;
}

function serializeNodes(nodes = []) {
  const wrapper = document.createElement('div');
  nodes.forEach((node) => wrapper.appendChild(node));
  return wrapper.innerHTML.trim();
}

function extractBlockSections(html = '') {
  const template = document.createElement('template');
  template.innerHTML = html || '';
  const nodes = Array.from(template.content.childNodes);
  const titleNodes = [];
  const bodyNodes = [];
  let separatorFound = false;
  nodes.forEach((node) => {
    if (!separatorFound && isSeparatorNode(node)) {
      separatorFound = true;
      return;
    }
    if (!separatorFound) {
      titleNodes.push(node.cloneNode(true));
    } else {
      bodyNodes.push(node.cloneNode(true));
    }
  });

  if (!separatorFound) {
    return { titleHtml: '', bodyHtml: serializeNodes(nodes) };
  }
  const titleHtml = serializeNodes(titleNodes);
  const bodyHtml = serializeNodes(bodyNodes);
  return { titleHtml, bodyHtml };
}

function moveSelection(offset) {
  if (!state.article) return;
  const ordered = flattenVisible(state.article.blocks);
  const index = ordered.findIndex((b) => b.id === state.currentBlockId);
  if (index === -1) return;
  const next = ordered[index + offset];
  if (next) {
    setCurrentBlock(next.id);
  }
}

function renderArticle() {
  const article = state.article;
  if (!article) return;
  renderSidebarArticleList();

  const titleText = article.title || 'Без названия';
  refs.articleTitle.textContent = titleText;
  if (!state.isEditingTitle && refs.articleTitleInput) {
    refs.articleTitleInput.value = titleText;
  }
  refs.articleTitle.classList.toggle('hidden', state.isEditingTitle);
  if (refs.articleTitleInput) {
    refs.articleTitleInput.classList.toggle('hidden', !state.isEditingTitle);
  }
  if (refs.editTitleBtn) {
    refs.editTitleBtn.classList.toggle('hidden', state.isEditingTitle);
  }
  refs.updatedAt.textContent = `Обновлено: ${new Date(article.updatedAt).toLocaleString()}`;
  refs.blocksContainer.innerHTML = '';

  const renderBlocks = (blocks, container) => {
    blocks.forEach((block) => {
      const blockEl = document.createElement('div');
      blockEl.className = 'block';
      blockEl.dataset.blockId = block.id;
      if (block.id === state.currentBlockId) {
        blockEl.classList.add('selected');
      }
      if (block.id === state.editingBlockId) {
        blockEl.classList.add('editing');
      }

      const sections = extractBlockSections(block.text || '');
      const hasTitle = Boolean(sections.titleHtml);
      let titleEl = null;
      if (hasTitle) {
        titleEl = document.createElement('div');
        titleEl.className = 'block-title';
        titleEl.innerHTML = sections.titleHtml;
      }

      const hasChildren = Boolean(block.children && block.children.length);
      blockEl.classList.toggle('block--no-title', !hasTitle && hasChildren);

      const body = document.createElement('div');
      body.className = 'block-text block-body';
      const rawHtml = block.text || '';
      const bodyHtml = hasTitle ? sections.bodyHtml : rawHtml;
      body.innerHTML = bodyHtml || '';
      if (!hasTitle) {
        body.classList.add('block-body--no-title');
      }
      if (!bodyHtml) {
        body.classList.add('block-body--empty');
      }
      body.spellcheck = false;
      body.setAttribute('data-placeholder', 'Введите текст');

      if (state.mode === 'edit' && state.editingBlockId === block.id) {
        body.setAttribute('contenteditable', 'true');
        body.innerHTML = rawHtml;
        requestAnimationFrame(() => {
          body.focus();
          placeCaretAtEnd(body);
        });
      } else {
        body.setAttribute('contenteditable', 'false');
      }

      body.addEventListener('click', (event) => {
        event.stopPropagation();
        if (state.mode === 'view') {
          setCurrentBlock(block.id);
        }
      });

      const header = document.createElement('div');
      header.className = 'block-header';
      if (hasChildren) {
        const collapseBtn = document.createElement('button');
        collapseBtn.className = 'collapse-btn';
        collapseBtn.textContent = block.collapsed ? '+' : '−';
        collapseBtn.title = block.collapsed ? 'Развернуть' : 'Свернуть';
        collapseBtn.addEventListener('click', (event) => {
          event.stopPropagation();
          toggleCollapse(block.id);
        });
        header.appendChild(collapseBtn);
      }
      if (titleEl) {
        header.appendChild(titleEl);
      }

      if (state.mode === 'edit' && state.editingBlockId === block.id) {
        blockEl.appendChild(body);
      } else {
        if (hasTitle && titleEl) {
          header.appendChild(titleEl);
        }
        blockEl.appendChild(header);
        if (!body.classList.contains('block-body--empty')) {
          blockEl.appendChild(body);
        }
      }
      attachRichContentHandlers(body, block.id);

      blockEl.addEventListener('click', () => {
        if (state.mode === 'view') {
          setCurrentBlock(block.id);
        }
      });

      const shouldHideBody = block.collapsed && block.id !== state.editingBlockId && hasTitle;
      if (!body.classList.contains('block-body--empty')) {
        body.classList.toggle('collapsed', shouldHideBody);
      }

      if (block.children && block.children.length > 0 && !block.collapsed) {
        const childrenContainer = document.createElement('div');
        childrenContainer.className = 'block-children';
        renderBlocks(block.children, childrenContainer);
        blockEl.appendChild(childrenContainer);
      }

      container.appendChild(blockEl);
    });
  };

  renderBlocks(article.blocks, refs.blocksContainer);
  applyPendingPreviewMarkup();
  if (state.scrollTargetBlockId) {
    const targetId = state.scrollTargetBlockId;
    requestAnimationFrame(() => {
      const target = document.querySelector(`.block[data-block-id="${targetId}"]`);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.setAttribute('tabindex', '-1');
        target.focus({ preventScroll: true });
        const prevSelected = refs.blocksContainer?.querySelector('.block.selected');
        if (prevSelected && prevSelected !== target) {
          prevSelected.classList.remove('selected');
        }
        target.classList.add('selected');
      }
      state.currentBlockId = targetId;
      state.scrollTargetBlockId = null;
    });
  }
}

function focusTitleInput() {
  if (!refs.articleTitleInput) return;
  requestAnimationFrame(() => {
    refs.articleTitleInput.focus();
    refs.articleTitleInput.select();
  });
}

function startTitleEditingMode() {
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
  if (changed) {
    renderSearchResults();
  }
}

async function saveTitleEditingMode() {
  if (!state.isEditingTitle || !refs.articleTitleInput || !state.articleId || !state.article) {
    return;
  }
  const newTitle = refs.articleTitleInput.value.trim();
  const currentTitle = (state.article.title || '').trim();
  if (!newTitle && !currentTitle) {
    state.isEditingTitle = false;
    renderArticle();
    return;
  }
  if (newTitle === currentTitle) {
    state.isEditingTitle = false;
    renderArticle();
    return;
  }
  if (isSavingTitle) return;
  isSavingTitle = true;
  refs.articleTitleInput.disabled = true;
  try {
    const updatedArticle = await apiRequest(`/api/articles/${state.articleId}`, {
      method: 'PATCH',
      body: JSON.stringify({ title: newTitle }),
    });
    state.article = {
      ...state.article,
      title: updatedArticle.title,
      updatedAt: updatedArticle.updatedAt,
    };
    upsertArticleIndex(updatedArticle);
    state.isEditingTitle = false;
    renderArticle();
    updateSearchTitlesCache(updatedArticle);
    showToast('Заголовок обновлён');
  } catch (error) {
    showToast(error.message);
  } finally {
    isSavingTitle = false;
    if (refs.articleTitleInput) {
      refs.articleTitleInput.disabled = false;
    }
  }
}

function setHintVisibility(visible) {
  isHintVisible = visible;
  if (refs.hintPopover) {
    refs.hintPopover.classList.toggle('hidden', !visible);
  }
  if (refs.hintToggleBtn) {
    refs.hintToggleBtn.setAttribute('aria-expanded', visible ? 'true' : 'false');
    refs.hintToggleBtn.classList.toggle('active', visible);
  }
}

function toggleHintPopover(event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  setHintVisibility(!isHintVisible);
}

function hideHintPopover() {
  if (!isHintVisible) return;
  setHintVisibility(false);
}

function setSidebarCollapsed(collapsed) {
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

function toggleSidebarCollapsed() {
  setSidebarCollapsed(!state.isSidebarCollapsed);
}

function handleTitleInputKeydown(event) {
  if (!state.isEditingTitle) return;
  if (event.code === 'Enter') {
    event.preventDefault();
    event.stopPropagation();
    saveTitleEditingMode();
  } else if (event.code === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    cancelTitleEditingMode();
  }
}

function handleTitleInputBlur() {
  if (!state.isEditingTitle || isSavingTitle) return;
  saveTitleEditingMode();
}

async function expandCollapsedAncestors(blockId) {
  let current = findBlock(blockId);
  if (!current) return;
  const ancestorIds = [];
  while (current.parent) {
    ancestorIds.push(current.parent.id);
    current = findBlock(current.parent.id);
    if (!current) break;
  }
  for (const ancestorId of ancestorIds.reverse()) {
    const ancestorNode = findBlock(ancestorId);
    if (!ancestorNode || !ancestorNode.block.collapsed) continue;
    try {
      await apiRequest(`/api/articles/${state.articleId}/collapse`, {
        method: 'PATCH',
        body: JSON.stringify({ blockId: ancestorNode.block.id, collapsed: false }),
      });
      ancestorNode.block.collapsed = false;
    } catch (error) {
      showToast(error.message);
      break;
    }
  }
}

function placeCaretAtEnd(element) {
  if (!element) return;
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

function attachRichContentHandlers(element, blockId) {
  const handlePaste = (event) => {
    if (state.mode !== 'edit' || state.editingBlockId !== blockId) return;
    const files = collectImageFiles(event.clipboardData?.items);
    if (!files.length) return;
    event.preventDefault();
    insertImagesSequentially(element, files);
  };

  const handleDrop = (event) => {
    if (state.mode !== 'edit' || state.editingBlockId !== blockId) return;
    const items = event.dataTransfer?.items || [];
    const files = collectImageFiles(items, event.dataTransfer?.files);
    if (!files.length) return;
    event.preventDefault();
    insertImagesSequentially(element, files);
  };

  const handleDragOver = (event) => {
    if (state.mode !== 'edit' || state.editingBlockId !== blockId) return;
    const hasImage = collectImageFiles(event.dataTransfer?.items).length > 0;
    if (hasImage) {
      event.preventDefault();
    }
  };

  element.addEventListener('paste', handlePaste);
  element.addEventListener('drop', handleDrop);
  element.addEventListener('dragover', handleDragOver);
}

function collectImageFiles(items = [], fallbackFiles = []) {
  const files = [];
  Array.from(items || []).forEach((item) => {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = typeof item.getAsFile === 'function' ? item.getAsFile() : null;
      if (file) {
        files.push(file);
      }
    }
  });
  if (!files.length && fallbackFiles?.length) {
    Array.from(fallbackFiles).forEach((file) => {
      if (file.type.startsWith('image/')) {
        files.push(file);
      }
    });
  }
  return files;
}

async function insertImagesSequentially(element, files) {
  for (const file of files) {
    // eslint-disable-next-line no-await-in-loop
    await insertImageFromFile(element, file);
  }
}

async function uploadImageFile(file) {
  const formData = new FormData();
  formData.append('file', file);
  const response = await fetch('/api/uploads', {
    method: 'POST',
    body: formData,
  });
  if (!response.ok) {
    const details = await response.json().catch(() => ({}));
    throw new Error(details.message || 'Не удалось загрузить изображение');
  }
  return response.json();
}

async function insertImageFromFile(element, file) {
  try {
    const { url } = await uploadImageFile(file);
    const safeName = (file.name || 'image').replace(/"/g, '&quot;');
    insertHtmlAtCaret(
      element,
      `<img src="${url}" alt="${safeName}" draggable="false" />`,
    );
  } catch (error) {
    showToast(error.message);
  }
}

function insertHtmlAtCaret(element, html) {
  element.focus();
  const selection = window.getSelection();
  if (!selection) return;
  let range =
    selection.rangeCount > 0 ? selection.getRangeAt(0) : document.createRange();
  if (!element.contains(range.commonAncestorContainer)) {
    range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
  }
  selection.removeAllRanges();
  selection.addRange(range);
  const fragment = range.createContextualFragment(html);
  range.deleteContents();
  range.insertNode(fragment);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

async function toggleCollapse(blockId) {
  const located = findBlock(blockId);
  if (!located || !(located.block.children || []).length) return;
  setCollapseState(blockId, !located.block.collapsed);
}

async function setCollapseState(blockId, collapsed) {
  const located = findBlock(blockId);
  if (!located || !(located.block.children || []).length || located.block.collapsed === collapsed) {
    return;
  }
  try {
    if (located.block) {
      located.block.collapsed = collapsed;
    }
    renderArticle();
    const response = await apiRequest(`/api/articles/${state.articleId}/collapse`, {
      method: 'PATCH',
      body: JSON.stringify({ blockId, collapsed }),
    });
    if (response?.updatedAt) {
      state.article.updatedAt = response.updatedAt;
      renderArticle();
    }
  } catch (error) {
    if (located.block) {
      located.block.collapsed = !collapsed;
    }
    renderArticle();
    showToast(error.message);
  }
}

async function startEditing() {
  if (!state.currentBlockId) return;
  state.mode = 'edit';
  state.editingBlockId = state.currentBlockId;
  renderArticle();
}

async function saveEditing() {
  if (state.mode !== 'edit' || !state.editingBlockId) return;
  const editedBlockId = state.editingBlockId;
  const previousText = findBlock(editedBlockId)?.block.text || '';
  const textElement = document.querySelector(
    `.block[data-block-id="${state.editingBlockId}"] .block-text`,
  );
  const newText = textElement?.innerHTML || '';
  try {
    const updatedBlock = await apiRequest(
      `/api/articles/${state.articleId}/blocks/${state.editingBlockId}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ text: newText }),
      },
    );
    state.mode = 'view';
    state.editingBlockId = null;
    if (previousText !== newText) {
      pushUndoEntry({
        type: 'text',
        blockId: editedBlockId,
        historyEntryId: updatedBlock?.historyEntryId || null,
      });
    }
    await loadArticle(state.articleId, { desiredBlockId: editedBlockId });
    renderArticle();
    showToast('Блок обновлён');
  } catch (error) {
    showToast(error.message);
  }
}

function cancelEditing() {
  if (state.mode !== 'edit') return;
  state.mode = 'view';
  state.editingBlockId = null;
  renderArticle();
}

async function createArticle() {
  if (refs.createArticleBtn) refs.createArticleBtn.disabled = true;
  if (refs.sidebarNewArticleBtn) refs.sidebarNewArticleBtn.disabled = true;
  try {
    const article = await apiRequest('/api/articles', { method: 'POST', body: JSON.stringify({}) });
    upsertArticleIndex(article);
    navigate(routing.article(article.id));
    showToast('Статья создана');
  } catch (error) {
    showToast(error.message);
  } finally {
    if (refs.createArticleBtn) refs.createArticleBtn.disabled = false;
    if (refs.sidebarNewArticleBtn) refs.sidebarNewArticleBtn.disabled = false;
  }
}

async function createSibling(direction) {
  if (!state.currentBlockId) return;
  const anchorBlockId = state.currentBlockId;
  try {
    const data = await apiRequest(
      `/api/articles/${state.articleId}/blocks/${state.currentBlockId}/siblings`,
      {
        method: 'POST',
        body: JSON.stringify({ direction }),
      },
    );
    await loadArticle(state.articleId, { desiredBlockId: data.block.id });
    renderArticle();
    if (data?.block) {
      const snapshot = cloneBlockSnapshot(data.block);
      pushUndoEntry({
        type: 'structure',
        action: {
          kind: 'create',
          parentId: data.parentId || null,
          index: data.index ?? null,
          blockId: data.block.id,
          block: snapshot,
          fallbackId: anchorBlockId,
        },
      });
    }
  } catch (error) {
    showToast(error.message);
  }
}

function findCollapsibleTarget(blockId, desiredState) {
  let current = findBlock(blockId);
  while (current) {
    const hasChildren = Boolean(current.block.children && current.block.children.length);
    if (hasChildren && current.block.collapsed !== desiredState) {
      return current.block.id;
    }
    if (!current.parent) {
      break;
    }
    current = findBlock(current.parent.id);
  }
  return null;
}

function findFallbackBlockId(blockId) {
  const located = findBlock(blockId);
  if (!located) return null;
  const next = located.siblings?.[located.index + 1];
  if (next) return next.id;
  const prev = located.siblings?.[located.index - 1];
  if (prev) return prev.id;
  return located.parent ? located.parent.id : null;
}

async function deleteCurrentBlock() {
  if (!state.currentBlockId) return;
  const fallbackId = findFallbackBlockId(state.currentBlockId);
  try {
    const result = await apiRequest(`/api/articles/${state.articleId}/blocks/${state.currentBlockId}`, {
      method: 'DELETE',
    });
    logDebug('deleteCurrentBlock result', result);
    await loadArticle(state.articleId, { desiredBlockId: fallbackId });
    renderArticle();
    if (result?.block) {
      const snapshot = cloneBlockSnapshot(result.block);
      pushUndoEntry({
        type: 'structure',
        action: {
          kind: 'delete',
          parentId: result.parentId || null,
          index: result.index ?? null,
          block: snapshot,
          blockId: snapshot?.id,
          fallbackId,
        },
      });
    }
  } catch (error) {
    showToast(error.message);
  }
}

async function moveBlock(blockId, direction, options = {}) {
  if (!blockId || !['up', 'down'].includes(direction)) return false;
  const { skipRecord = false } = options;
  try {
    await apiRequest(`/api/articles/${state.articleId}/blocks/${blockId}/move`, {
      method: 'POST',
      body: JSON.stringify({ direction }),
    });
    await loadArticle(state.articleId, { desiredBlockId: blockId });
    renderArticle();
    if (!skipRecord) {
      pushUndoEntry({ type: 'structure', action: { kind: 'move', blockId, direction } });
    }
    return true;
  } catch (error) {
    showToast(error.message);
    return false;
  }
}

function moveCurrentBlock(direction) {
  return moveBlock(state.currentBlockId, direction);
}

async function indentBlock(blockId, options = {}) {
  if (!blockId) return false;
  const { skipRecord = false } = options;
  try {
    await apiRequest(`/api/articles/${state.articleId}/blocks/${blockId}/indent`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    await loadArticle(state.articleId, { desiredBlockId: blockId });
    renderArticle();
    if (!skipRecord) {
      pushUndoEntry({ type: 'structure', action: { kind: 'indent', blockId } });
    }
    return true;
  } catch (error) {
    showToast(error.message);
    return false;
  }
}

function indentCurrentBlock() {
  return indentBlock(state.currentBlockId);
}

async function outdentBlock(blockId, options = {}) {
  if (!blockId) return false;
  const { skipRecord = false } = options;
  try {
    await apiRequest(`/api/articles/${state.articleId}/blocks/${blockId}/outdent`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    await loadArticle(state.articleId, { desiredBlockId: blockId });
    renderArticle();
    if (!skipRecord) {
      pushUndoEntry({ type: 'structure', action: { kind: 'outdent', blockId } });
    }
    return true;
  } catch (error) {
    showToast(error.message);
    return false;
  }
}

function outdentCurrentBlock() {
  return outdentBlock(state.currentBlockId);
}

async function ensureBlockVisible(blockId) {
  if (!blockId) return;
  const located = findBlock(blockId);
  if (!located) return;
  const ancestorsToExpand = (located.ancestors || []).filter((ancestor) => ancestor.collapsed);
  for (const ancestor of ancestorsToExpand) {
    // eslint-disable-next-line no-await-in-loop
    await setCollapseState(ancestor.id, false);
  }
}

function hydrateUndoRedoFromArticle(article) {
  clearPendingTextPreview({ restoreDom: false });
  const toTextEntry = (entry) => ({
    type: 'text',
    blockId: entry.blockId,
    historyEntryId: entry.id,
  });
  state.undoStack = (article.history || []).map(toTextEntry);
  state.redoStack = (article.redoHistory || []).map(toTextEntry);
}

function pushUndoEntry(entry) {
  if (!entry) return;
  logDebug('pushUndoEntry', entry);
  state.undoStack.push(entry);
  state.redoStack = [];
}

function cloneBlockSnapshot(block) {
  try {
    return JSON.parse(JSON.stringify(block || {}));
  } catch {
    return null;
  }
}

async function focusBlock(blockId) {
  if (!blockId) return;
  await ensureBlockVisible(blockId);
  setCurrentBlock(blockId);
}

function clearPendingTextPreview({ restoreDom = true } = {}) {
  const pending = state.pendingTextPreview;
  if (!pending) return;
  if (restoreDom) {
    const textEl = document.querySelector(
      `.block[data-block-id="${pending.blockId}"] .block-text`,
    );
    if (textEl) {
      textEl.innerHTML = pending.originalHTML;
    }
  }
  state.pendingTextPreview = null;
}

function textareaToTextContent(html = '') {
  const template = document.createElement('template');
  template.innerHTML = html || '';
  return template.content.textContent || '';
}

function extractImagesFromHtml(html = '') {
  const template = document.createElement('template');
  template.innerHTML = html || '';
  const nodes = template.content.querySelectorAll('img');
  return Array.from(nodes).map((node) => ({
    src: node.getAttribute('src') || '',
    alt: node.getAttribute('alt') || '',
  }));
}

function diffTextSegments(currentText = '', nextText = '') {
  const a = Array.from(currentText);
  const b = Array.from(nextText);
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      if (a[i] === b[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }
  const operations = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      operations.push({ type: 'same', value: a[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      operations.push({ type: 'removed', value: a[i] });
      i += 1;
    } else {
      operations.push({ type: 'added', value: b[j] });
      j += 1;
    }
  }
  while (i < m) {
    operations.push({ type: 'removed', value: a[i] });
    i += 1;
  }
  while (j < n) {
    operations.push({ type: 'added', value: b[j] });
    j += 1;
  }

  const chunks = [];
  operations.forEach((op) => {
    if (!op.value) return;
    const last = chunks[chunks.length - 1];
    if (last && last.type === op.type) {
      last.value += op.value;
    } else {
      chunks.push({ type: op.type, value: op.value });
    }
  });
  return chunks;
}

function buildImageDiff(currentImages = [], nextImages = []) {
  const key = (img) => `${img.src}||${img.alt || ''}`;
  const nextCounts = {};
  nextImages.forEach((img) => {
    const k = key(img);
    nextCounts[k] = (nextCounts[k] || 0) + 1;
  });
  const removed = [];
  currentImages.forEach((img) => {
    const k = key(img);
    if (nextCounts[k]) {
      nextCounts[k] -= 1;
    } else {
      removed.push({ type: 'removed', ...img });
    }
  });
  const currentCounts = {};
  currentImages.forEach((img) => {
    const k = key(img);
    currentCounts[k] = (currentCounts[k] || 0) + 1;
  });
  const added = [];
  nextImages.forEach((img) => {
    const k = key(img);
    if (currentCounts[k]) {
      currentCounts[k] -= 1;
    } else {
      added.push({ type: 'added', ...img });
    }
  });
  return [...removed, ...added];
}

function renderImageDiff(container, imageDiff) {
  if (!imageDiff.length) return;
  const gallery = document.createElement('div');
  gallery.className = 'diff-images';
  imageDiff.forEach((diff) => {
    const card = document.createElement('div');
    card.className = `diff-image-card diff-image-card--${diff.type}`;
    const label = document.createElement('div');
    label.className = 'diff-image-card__label';
    label.textContent = diff.type === 'added' ? 'Добавлено' : 'Удалено';
    const img = document.createElement('img');
    img.src = diff.src;
    img.alt = diff.alt || '';
    card.append(label, img);
    gallery.appendChild(card);
  });
  container.appendChild(gallery);
}

function renderDiffPreview(element, mode, chunks, imageDiff = []) {
  const wrapper = document.createElement('div');
  wrapper.className = 'diff-inline';
  const content = document.createElement('div');
  content.className = 'diff-inline__content';
  chunks.forEach((chunk) => {
    const span = document.createElement('span');
    if (chunk.type === 'added') {
      span.className = 'diff-inline__segment diff-inline__segment--added';
    } else if (chunk.type === 'removed') {
      span.className = 'diff-inline__segment diff-inline__segment--removed';
    }
    span.textContent = chunk.value;
    content.appendChild(span);
  });
  renderImageDiff(content, imageDiff);
  const hint = document.createElement('div');
  hint.className = 'diff-inline__hint';
  hint.textContent =
    mode === 'undo'
      ? 'Повторно нажмите Ctrl+Z, чтобы подтвердить отмену'
      : 'Повторно нажмите Ctrl+Y, чтобы подтвердить повтор';
  wrapper.append(content, hint);
  element.innerHTML = '';
  element.appendChild(wrapper);
}

function findHistoryEntry(entryId, source = 'history') {
  const collection =
    source === 'redo'
      ? state.article?.redoHistory || []
      : state.article?.history || [];
  return collection.find((item) => item.id === entryId) || null;
}

async function showTextDiffPreview(entry, mode) {
  clearPendingTextPreview();
  const source = mode === 'undo' ? 'history' : 'redo';
  const historyEntry = findHistoryEntry(entry.historyEntryId, source);
  if (!historyEntry) {
    return false;
  }
  await focusBlock(entry.blockId);
  const textEl = document.querySelector(`.block[data-block-id="${entry.blockId}"] .block-text`);
  if (!textEl) {
    return false;
  }
  const currentHtml = textEl.innerHTML;
  const nextHtml = mode === 'undo' ? historyEntry.before : historyEntry.after;
  const currentText = textEl.textContent || '';
  const nextText = textareaToTextContent(nextHtml);
  const chunks = diffTextSegments(currentText, nextText);
  const hasChanges = chunks.some((chunk) => chunk.type !== 'same');
  const imageDiff = buildImageDiff(
    extractImagesFromHtml(currentHtml),
    extractImagesFromHtml(nextHtml),
  );
  if (!hasChanges && !imageDiff.length) {
    return false;
  }
  renderDiffPreview(textEl, mode, chunks, imageDiff);
  state.pendingTextPreview = {
    mode,
    blockId: entry.blockId,
    originalHTML: currentHtml,
    chunks,
    imageDiff,
  };
  return true;
}

async function applyPendingTextPreview(mode) {
  const pending = state.pendingTextPreview;
  clearPendingTextPreview({ restoreDom: false });
  if (!pending) {
    return;
  }
  if (mode === 'undo') {
    const entry = state.undoStack.pop();
    if (!entry) return;
    const blockId = await undoTextChange(entry);
    if (blockId) {
      state.redoStack.push(entry);
    } else {
      state.undoStack.push(entry);
    }
  } else if (mode === 'redo') {
    const entry = state.redoStack.pop();
    if (!entry) return;
    const blockId = await redoTextChange(entry);
    if (blockId) {
      state.undoStack.push(entry);
    } else {
      state.redoStack.push(entry);
    }
  }
}

function applyPendingPreviewMarkup() {
  const pending = state.pendingTextPreview;
  if (!pending) return;
  const textEl = document.querySelector(`.block[data-block-id="${pending.blockId}"] .block-text`);
  if (textEl) {
    renderDiffPreview(textEl, pending.mode, pending.chunks, pending.imageDiff || []);
  }
}

function invertStructureAction(action) {
  if (!action) return null;
  if (action.kind === 'move') {
    return {
      kind: 'move',
      blockId: action.blockId,
      direction: action.direction === 'up' ? 'down' : 'up',
    };
  }
  if (action.kind === 'indent') {
    return { kind: 'outdent', blockId: action.blockId };
  }
  if (action.kind === 'outdent') {
    return { kind: 'indent', blockId: action.blockId };
  }
  if (action.kind === 'create') {
    return { kind: 'delete', blockId: action.blockId, fallbackId: action.fallbackId || null };
  }
  if (action.kind === 'delete') {
    return {
      kind: 'restore',
      block: action.block,
      parentId: action.parentId || null,
      index: action.index ?? null,
    };
  }
  return null;
}

async function executeStructureAction(action, options = {}) {
  const { skipRecord = false } = options;
  if (!action) return { success: false };
  let success = false;
  let payload = null;
  logDebug('executeStructureAction start', action);
  if (action.kind === 'move') {
    success = await moveBlock(action.blockId, action.direction, { skipRecord });
  } else if (action.kind === 'indent') {
    success = await indentBlock(action.blockId, { skipRecord });
  } else if (action.kind === 'outdent') {
    success = await outdentBlock(action.blockId, { skipRecord });
  } else if (action.kind === 'delete') {
    const targetId = action.blockId || action.block?.id;
    if (!targetId) {
      return { success: false };
    }
    try {
      payload = await apiRequest(`/api/articles/${state.articleId}/blocks/${targetId}`, {
        method: 'DELETE',
      });
      await loadArticle(state.articleId, { desiredBlockId: action.fallbackId || payload?.parentId });
      renderArticle();
      success = true;
    } catch (error) {
      showToast(error.message);
      success = false;
    }
  } else if (action.kind === 'restore' || action.kind === 'create') {
    const blockPayload = action.block || action.blockSnapshot;
    if (!blockPayload) {
      return { success: false };
    }
    try {
      payload = await apiRequest(`/api/articles/${state.articleId}/blocks/restore`, {
        method: 'POST',
        body: JSON.stringify({
          parentId: action.parentId || null,
          index: action.index ?? null,
          block: blockPayload,
        }),
      });
      await loadArticle(state.articleId, { desiredBlockId: payload.block?.id });
      renderArticle();
      success = true;
    } catch (error) {
      showToast(error.message);
      success = false;
    }
  }
  if (success) {
    const focusId = action.blockId || payload?.block?.id || action.block?.id;
    if (focusId) {
      await focusBlock(focusId);
    }
  }
  logDebug('executeStructureAction result', { success, payload });
  return { success, payload };
}

async function undoTextChange(entry) {
  if (!state.articleId) return null;
  try {
    const result = await apiRequest(
      `/api/articles/${state.articleId}/blocks/undo-text`,
      {
        method: 'POST',
        body: JSON.stringify({ entryId: entry?.historyEntryId || null }),
      },
    );
    if (!result?.blockId) return null;
    await loadArticle(state.articleId, { desiredBlockId: result.blockId });
    renderArticle();
    await focusBlock(result.blockId);
    return result.blockId;
  } catch (error) {
    if (error.message !== 'Nothing to undo') {
      showToast(error.message);
    }
    return null;
  }
}

async function redoTextChange(entry) {
  if (!state.articleId) return null;
  try {
    const result = await apiRequest(
      `/api/articles/${state.articleId}/blocks/redo-text`,
      {
        method: 'POST',
        body: JSON.stringify({ entryId: entry?.historyEntryId || null }),
      },
    );
    if (!result?.blockId) return null;
    await loadArticle(state.articleId, { desiredBlockId: result.blockId });
    renderArticle();
    await focusBlock(result.blockId);
    return result.blockId;
  } catch (error) {
    if (error.message !== 'Nothing to redo') {
      showToast(error.message);
    }
    return null;
  }
}

async function handleUndoAction() {
  if (state.pendingTextPreview?.mode === 'redo') {
    clearPendingTextPreview();
  }
  if (state.pendingTextPreview?.mode === 'undo') {
    await applyPendingTextPreview('undo');
    return;
  }
  if (!state.undoStack.length) {
    showToast('Нечего отменять');
    return;
  }
  const entry = state.undoStack[state.undoStack.length - 1];
  logDebug('handleUndoAction entry', entry);
  logDebug('handleUndoAction entry', entry);
  if (entry.type === 'structure') {
    state.undoStack.pop();
    const inverse = invertStructureAction(entry.action);
    const result = await executeStructureAction(inverse, { skipRecord: true });
    if (result.success) {
      if (entry.action.kind === 'create' && result.payload?.block) {
        entry.action.block = result.payload.block;
        entry.action.parentId = result.payload.parentId || null;
        entry.action.index = result.payload.index ?? null;
      }
      state.redoStack.push(entry);
    } else {
      state.undoStack.push(entry);
      showToast('Не удалось отменить действие');
    }
    return;
  }
  const previewReady = await showTextDiffPreview(entry, 'undo');
  if (!previewReady) {
    state.undoStack.pop();
    const blockId = await undoTextChange(entry);
    if (blockId) {
      state.redoStack.push(entry);
    } else {
      state.undoStack.push(entry);
    }
  }
}

async function handleRedoAction() {
  if (state.pendingTextPreview?.mode === 'undo') {
    clearPendingTextPreview();
  }
  if (state.pendingTextPreview?.mode === 'redo') {
    await applyPendingTextPreview('redo');
    return;
  }
  if (!state.redoStack.length) {
    showToast('Нечего повторять');
    return;
  }
  const entry = state.redoStack[state.redoStack.length - 1];
  logDebug('handleRedoAction entry', entry);
  logDebug('handleRedoAction entry', entry);
  if (entry.type === 'structure') {
    state.redoStack.pop();
    const result = await executeStructureAction(entry.action, { skipRecord: true });
    if (result.success) {
      state.undoStack.push(entry);
    } else {
      state.redoStack.push(entry);
      showToast('Не удалось повторить действие');
    }
    return;
  }
  const previewReady = await showTextDiffPreview(entry, 'redo');
  if (!previewReady) {
    state.redoStack.pop();
    const blockId = await redoTextChange(entry);
    if (blockId) {
      state.undoStack.push(entry);
    } else {
      state.redoStack.push(entry);
    }
  }
}

function handleViewKey(event) {
  if (!state.article) return;
  if (
    state.isEditingTitle &&
    refs.articleTitleInput &&
    refs.articleTitleInput.contains(event.target)
  ) {
    return;
  }
  if (isHintVisible && event.code === 'Escape') {
    event.preventDefault();
    hideHintPopover();
    return;
  }
  const code = typeof event.code === 'string' ? event.code : '';
  const isCtrlZ = event.ctrlKey && !event.shiftKey && code === 'KeyZ';
  const isCtrlY = event.ctrlKey && !event.shiftKey && code === 'KeyY';
  if (state.pendingTextPreview) {
    if (state.pendingTextPreview.mode === 'undo' && isCtrlZ) {
      event.preventDefault();
      applyPendingTextPreview('undo');
      return;
    }
    if (state.pendingTextPreview.mode === 'redo' && isCtrlY) {
      event.preventDefault();
      applyPendingTextPreview('redo');
      return;
    }
    if (code === 'Escape') {
      event.preventDefault();
      clearPendingTextPreview();
      return;
    }
    event.preventDefault();
    return;
  }
  if (isCtrlZ) {
    event.preventDefault();
    handleUndoAction();
    return;
  }
  if (isCtrlY) {
    event.preventDefault();
    handleRedoAction();
    return;
  }
  if (event.ctrlKey && event.shiftKey && event.code === 'ArrowDown') {
    event.preventDefault();
    moveCurrentBlock('down');
    return;
  }
  if (event.ctrlKey && event.shiftKey && event.code === 'ArrowUp') {
    event.preventDefault();
    moveCurrentBlock('up');
    return;
  }
  if (event.ctrlKey && !event.shiftKey && event.code === 'ArrowDown') {
    event.preventDefault();
    createSibling('after');
    return;
  }
  if (event.ctrlKey && !event.shiftKey && event.code === 'ArrowUp') {
    event.preventDefault();
    createSibling('before');
    return;
  }
  if (event.ctrlKey && event.code === 'Delete') {
    event.preventDefault();
    deleteCurrentBlock();
    return;
  }
  if (event.ctrlKey && event.code === 'ArrowRight') {
    event.preventDefault();
    indentCurrentBlock();
    return;
  }
  if (event.ctrlKey && event.code === 'ArrowLeft') {
    event.preventDefault();
    outdentCurrentBlock();
    return;
  }
  if (event.code === 'ArrowDown') {
    event.preventDefault();
    moveSelection(1);
    return;
  }
  if (event.code === 'ArrowUp') {
    event.preventDefault();
    moveSelection(-1);
    return;
  }
  if (event.code === 'ArrowLeft') {
    event.preventDefault();
    const targetId = findCollapsibleTarget(state.currentBlockId, true);
    if (targetId) {
      if (state.currentBlockId !== targetId) {
        setCurrentBlock(targetId);
      }
      setCollapseState(targetId, true);
    }
    return;
  }
  if (event.code === 'ArrowRight') {
    event.preventDefault();
    const targetId = findCollapsibleTarget(state.currentBlockId, false);
    if (targetId) {
      setCollapseState(targetId, false);
    }
    return;
  }
  if (event.code === 'Enter') {
    event.preventDefault();
    startEditing();
  }
}

function handleEditKey(event) {
  if (event.code === 'Enter' && event.ctrlKey) {
    event.preventDefault();
    saveEditing();
    return;
  }
  if (event.code === 'Escape') {
    event.preventDefault();
    cancelEditing();
  }
}

function attachEvents() {
  document.addEventListener('keydown', (event) => {
    if (state.mode === 'view') {
      handleViewKey(event);
    } else {
      handleEditKey(event);
    }
  });

  if (refs.createArticleBtn) {
    refs.createArticleBtn.addEventListener('click', createArticle);
  }
  if (refs.sidebarNewArticleBtn) {
    refs.sidebarNewArticleBtn.addEventListener('click', createArticle);
  }
  refs.backToList.addEventListener('click', () => navigate(routing.list));
  if (refs.searchInput) {
    refs.searchInput.addEventListener('input', handleSearchInput);
    refs.searchInput.addEventListener('focus', () => {
      if (state.searchQuery.trim()) {
        renderSearchResults();
      }
    });
  }
  if (refs.editTitleBtn) {
    refs.editTitleBtn.addEventListener('click', startTitleEditingMode);
  }
  if (refs.articleTitle) {
    refs.articleTitle.addEventListener('dblclick', startTitleEditingMode);
  }
  if (refs.articleTitleInput) {
    refs.articleTitleInput.addEventListener('keydown', handleTitleInputKeydown);
    refs.articleTitleInput.addEventListener('blur', handleTitleInputBlur);
  }
  if (refs.hintToggleBtn) {
    refs.hintToggleBtn.addEventListener('click', toggleHintPopover);
  }
  if (refs.sidebarToggle) {
    refs.sidebarToggle.addEventListener('click', toggleSidebarCollapsed);
  }
  if (refs.articleFilterInput) {
    refs.articleFilterInput.addEventListener('input', handleArticleFilterInput);
  }
  document.addEventListener('click', (event) => {
    if (refs.searchPanel && !refs.searchPanel.contains(event.target)) {
      hideSearchResults();
    }
    if (
      isHintVisible &&
      refs.hintPopover &&
      (!refs.hintPopover.contains(event.target) &&
        !(refs.hintToggleBtn && refs.hintToggleBtn.contains(event.target)))
    ) {
      hideHintPopover();
    }
  });
  refreshLastChangeTimestamp();
  loadLastChangeFromChangelog();
}

window.addEventListener('popstate', () => route(window.location.pathname));

attachEvents();
route(window.location.pathname);
