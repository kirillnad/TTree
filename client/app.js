const state = {
  mode: 'view',
  articleId: null,
  article: null,
  currentBlockId: null,
  editingBlockId: null,
  undoStack: [],
  redoStack: [],
};

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
  articleActions: document.getElementById('articleActions'),
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
  refs.articleActions.innerHTML = '';
}

async function loadListView() {
  state.article = null;
  state.articleId = null;
  state.currentBlockId = null;
  state.mode = 'view';
  state.editingBlockId = null;
  state.undoStack = [];
  state.redoStack = [];
  setViewMode(false);
  try {
    const articles = await apiRequest('/api/articles');
    refs.articleList.innerHTML = '';
    if (!articles.length) {
      const empty = document.createElement('li');
      empty.textContent = 'Пока нет статей. Создайте первую!';
      refs.articleList.appendChild(empty);
      return;
    }
    articles.forEach((article) => {
      const item = document.createElement('li');
      item.innerHTML = `
        <span>
          <strong>${article.title}</strong><br />
          <small>${new Date(article.updatedAt).toLocaleString()}</small>
        </span>
        <button class="ghost">Открыть</button>
      `;
      item.addEventListener('click', () => navigate(routing.article(article.id)));
      refs.articleList.appendChild(item);
    });
  } catch (error) {
    refs.articleList.innerHTML = `<li>Не удалось загрузить список: ${error.message}</li>`;
  }
}

async function loadArticle(id, options = {}) {
  const { desiredBlockId, resetUndoStacks } = options;
  const switchingArticle = state.articleId !== id;
  state.articleId = id;
  state.mode = state.mode === 'edit' ? 'view' : state.mode;
  state.editingBlockId = null;
  const article = await apiRequest(`/api/articles/${id}`);
  state.article = article;
  const shouldResetUndo = typeof resetUndoStacks === 'boolean' ? resetUndoStacks : switchingArticle;
  if (shouldResetUndo) {
    hydrateUndoRedoFromArticle(article);
  }
  if (desiredBlockId) {
    const desired = findBlock(desiredBlockId);
    if (desired) {
      state.currentBlockId = desired.block.id;
    }
  }
  if (switchingArticle || !findBlock(state.currentBlockId)) {
    const firstBlock = flattenVisible(article.blocks)[0];
    state.currentBlockId = firstBlock ? firstBlock.id : null;
  }
  return article;
}

async function loadArticleView(id) {
  setViewMode(true);
  refs.blocksContainer.innerHTML = 'Загрузка...';
  try {
    await loadArticle(id, { resetUndoStacks: true });
    renderArticle();
    renderArticleActions();
  } catch (error) {
    refs.blocksContainer.innerHTML = `<p class="meta">Не удалось загрузить статью: ${error.message}</p>`;
  }
}

function renderArticleActions() {
  refs.articleActions.innerHTML = '';
  if (!state.article) return;
  const linkButton = document.createElement('button');
  linkButton.className = 'ghost';
  linkButton.textContent = 'Скопировать ссылку';
  linkButton.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      showToast('Ссылка скопирована');
    } catch {
      showToast('Невозможно скопировать ссылку');
    }
  });
  refs.articleActions.appendChild(linkButton);
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

function findBlock(blockId, blocks = state.article?.blocks || [], parent = null) {
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    if (block.id === blockId) {
      return { block, parent, index: i, siblings: blocks };
    }
    const nested = findBlock(blockId, block.children || [], block);
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

  refs.articleTitle.textContent = `${article.title} — ${article.id}`;
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

      const text = document.createElement('div');
      text.className = 'block-text';
      text.innerHTML = block.text || '';
      text.spellcheck = false;
      text.setAttribute('data-placeholder', 'Введите текст');

      if (state.mode === 'edit' && state.editingBlockId === block.id) {
        text.setAttribute('contenteditable', 'true');
        requestAnimationFrame(() => {
          text.focus();
          placeCaretAtEnd(text);
        });
      } else {
        text.setAttribute('contenteditable', 'false');
      }

      text.addEventListener('click', (event) => {
        event.stopPropagation();
        if (state.mode === 'view') {
          setCurrentBlock(block.id);
        }
      });

      const header = document.createElement('div');
      header.className = 'block-header';
      const hasChildren = Boolean(block.children && block.children.length);
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
      header.appendChild(text);

      blockEl.appendChild(header);
      attachRichContentHandlers(text, block.id);

      blockEl.addEventListener('click', () => {
        if (state.mode === 'view') {
          setCurrentBlock(block.id);
        }
      });

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

async function insertImageFromFile(element, file) {
  const dataUrl = await readFileAsDataUrl(file);
  const safeName = (file.name || 'image').replace(/"/g, '&quot;');
  insertHtmlAtCaret(
    element,
    `<img src="${dataUrl}" alt="${safeName}" draggable="false" />`,
  );
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
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
    await apiRequest(`/api/articles/${state.articleId}/blocks/${blockId}`, {
      method: 'PATCH',
      body: JSON.stringify({ collapsed }),
    });
    await loadArticle(state.articleId);
    renderArticle();
  } catch (error) {
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
  refs.createArticleBtn.disabled = true;
  try {
    const article = await apiRequest('/api/articles', { method: 'POST', body: JSON.stringify({}) });
    navigate(routing.article(article.id));
    showToast('Статья создана');
  } catch (error) {
    showToast(error.message);
  } finally {
    refs.createArticleBtn.disabled = false;
  }
}

async function createSibling(direction) {
  if (!state.currentBlockId) return;
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
    await apiRequest(`/api/articles/${state.articleId}/blocks/${state.currentBlockId}`, {
      method: 'DELETE',
    });
    await loadArticle(state.articleId, { desiredBlockId: fallbackId });
    renderArticle();
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

function hydrateUndoRedoFromArticle(article) {
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
  state.undoStack.push(entry);
  state.redoStack = [];
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
  return null;
}

async function executeStructureAction(action, options = {}) {
  const { skipRecord = false } = options;
  if (!action) return false;
  if (action.kind === 'move') {
    return moveBlock(action.blockId, action.direction, { skipRecord });
  }
  if (action.kind === 'indent') {
    return indentBlock(action.blockId, { skipRecord });
  }
  if (action.kind === 'outdent') {
    return outdentBlock(action.blockId, { skipRecord });
  }
  return false;
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
    return result.blockId;
  } catch (error) {
    if (error.message !== 'Nothing to redo') {
      showToast(error.message);
    }
    return null;
  }
}

async function handleUndoAction() {
  if (!state.undoStack.length) {
    showToast('Нечего отменять');
    return;
  }
  const entry = state.undoStack.pop();
  let success = false;
  if (entry.type === 'structure') {
    const inverse = invertStructureAction(entry.action);
    success = await executeStructureAction(inverse, { skipRecord: true });
  } else if (entry.type === 'text') {
    const blockId = await undoTextChange(entry);
    success = Boolean(blockId);
  }
  if (success) {
    state.redoStack.push(entry);
  } else {
    state.undoStack.push(entry);
    if (entry.type === 'structure') {
      showToast('Не удалось отменить действие');
    }
  }
}

async function handleRedoAction() {
  if (!state.redoStack.length) {
    showToast('Нечего повторять');
    return;
  }
  const entry = state.redoStack.pop();
  let success = false;
  if (entry.type === 'structure') {
    success = await executeStructureAction(entry.action, { skipRecord: true });
  } else if (entry.type === 'text') {
    const blockId = await redoTextChange(entry);
    success = Boolean(blockId);
  }
  if (success) {
    state.undoStack.push(entry);
  } else {
    state.redoStack.push(entry);
    if (entry.type === 'structure') {
      showToast('Не удалось повторить действие');
    }
  }
}

function handleViewKey(event) {
  if (!state.article) return;
  const key = typeof event.key === 'string' ? event.key.toLowerCase() : '';
  const code = typeof event.code === 'string' ? event.code : '';
  const isCtrlZ =
    event.ctrlKey && !event.shiftKey && (code === 'KeyZ' || key === 'z' || key === 'я');
  const isCtrlY =
    event.ctrlKey && !event.shiftKey && (code === 'KeyY' || key === 'y' || key === 'н');
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
  if (event.ctrlKey && event.shiftKey && event.key === 'ArrowDown') {
    event.preventDefault();
    moveCurrentBlock('down');
    return;
  }
  if (event.ctrlKey && event.shiftKey && event.key === 'ArrowUp') {
    event.preventDefault();
    moveCurrentBlock('up');
    return;
  }
  if (event.ctrlKey && !event.shiftKey && event.key === 'ArrowDown') {
    event.preventDefault();
    createSibling('after');
    return;
  }
  if (event.ctrlKey && !event.shiftKey && event.key === 'ArrowUp') {
    event.preventDefault();
    createSibling('before');
    return;
  }
  if (event.ctrlKey && event.key === 'Delete') {
    event.preventDefault();
    deleteCurrentBlock();
    return;
  }
  if (event.ctrlKey && event.key === 'ArrowRight') {
    event.preventDefault();
    indentCurrentBlock();
    return;
  }
  if (event.ctrlKey && event.key === 'ArrowLeft') {
    event.preventDefault();
    outdentCurrentBlock();
    return;
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    moveSelection(1);
    return;
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault();
    moveSelection(-1);
    return;
  }
  if (event.key === 'ArrowLeft') {
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
  if (event.key === 'ArrowRight') {
    event.preventDefault();
    const targetId = findCollapsibleTarget(state.currentBlockId, false);
    if (targetId) {
      setCollapseState(targetId, false);
    }
    return;
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    startEditing();
  }
}

function handleEditKey(event) {
  if (event.key === 'Enter' && event.ctrlKey) {
    event.preventDefault();
    saveEditing();
    return;
  }
  if (event.key === 'Escape') {
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

  refs.createArticleBtn.addEventListener('click', createArticle);
  refs.backToList.addEventListener('click', () => navigate(routing.list));
}

window.addEventListener('popstate', () => route(window.location.pathname));

attachEvents();
route(window.location.pathname);
