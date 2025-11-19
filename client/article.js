import { state } from './state.js';
import { refs } from './refs.js';
import { fetchArticle, fetchArticlesIndex, createArticle as createArticleApi } from './api.js';
import { clearPendingTextPreview, hydrateUndoRedoFromArticle } from './undo.js';
import { setViewMode, upsertArticleIndex, renderMainArticleList, renderSidebarArticleList, ensureArticlesIndexLoaded } from './sidebar.js';
import {
  findBlock,
  flattenVisible,
  expandCollapsedAncestors,
  extractBlockSections,
  buildEditableBlockHtml,
  toggleCollapse,
  setCurrentBlock,
} from './block.js';
import { applyPendingPreviewMarkup } from './undo.js';
import { placeCaretAtEnd } from './utils.js';
import { attachRichContentHandlers } from './block.js';
import { showToast } from './toast.js';
import { navigate, routing } from './routing.js';

export async function loadArticle(id, options = {}) {
  const { desiredBlockId, resetUndoStacks } = options;
  const switchingArticle = state.articleId !== id;
  state.articleId = id;
  state.mode = state.mode === 'edit' ? 'view' : state.mode;
  state.editingBlockId = null;
  const article = await fetchArticle(id);
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

export async function loadArticleView(id) {
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

export async function loadListView() {
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
    upsertArticleIndex(articles);
    renderMainArticleList(articles);
  } catch (error) {
    refs.articleList.innerHTML = `<li>Не удалось загрузить список: ${error.message}</li>`;
  }
}

export function renderArticle() {
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
      if (block.id === state.currentBlockId) blockEl.classList.add('selected');
      if (block.id === state.editingBlockId) blockEl.classList.add('editing');

      const sections = extractBlockSections(block.text || '');
      const hasTitle = Boolean(sections.titleHtml);
      const hasChildren = Boolean(block.children?.length);
      const canCollapse = hasTitle || hasChildren;
      blockEl.classList.toggle('block--no-title', !hasTitle && hasChildren);

      const body = document.createElement('div');
      body.className = 'block-text block-body';
      const rawHtml = block.text || '';
      const bodyHtml = hasTitle ? sections.bodyHtml : rawHtml;
      body.innerHTML = bodyHtml || '';
      if (!hasTitle) body.classList.add('block-body--no-title');
      if (!bodyHtml) body.classList.add('block-body--empty');
      body.spellcheck = false;
      body.setAttribute('data-placeholder', 'Введите текст');

      if (state.mode === 'edit' && state.editingBlockId === block.id) {
        body.setAttribute('contenteditable', 'true');
        body.innerHTML = buildEditableBlockHtml(rawHtml);
        requestAnimationFrame(() => {
          body.focus();
          placeCaretAtEnd(body);
        });
      } else {
        body.setAttribute('contenteditable', 'false');
      }

      body.addEventListener('click', (event) => {
        event.stopPropagation();
        if (state.mode === 'view') setCurrentBlock(block.id);
      });

      const header = document.createElement('div');
      header.className = 'block-header';
      if (canCollapse) {
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

      if (hasTitle) {
        const titleEl = document.createElement('div');
        titleEl.className = 'block-title';
        titleEl.innerHTML = sections.titleHtml;
        header.appendChild(titleEl);
      }

      blockEl.appendChild(header);
      if (!body.classList.contains('block-body--empty')) {
        blockEl.appendChild(body);
      }
      attachRichContentHandlers(body, block.id);

      blockEl.addEventListener('click', () => {
        if (state.mode === 'view') setCurrentBlock(block.id);
      });

      const shouldHideBody = block.collapsed && block.id !== state.editingBlockId && hasTitle;
      if (!body.classList.contains('block-body--empty')) {
        body.classList.toggle('collapsed', shouldHideBody);
      }

      if (block.children?.length > 0 && !block.collapsed) {
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

export async function createArticle() {
  if (refs.createArticleBtn) refs.createArticleBtn.disabled = true;
  if (refs.sidebarNewArticleBtn) refs.sidebarNewArticleBtn.disabled = true;
  try {
    const article = await createArticleApi();
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
