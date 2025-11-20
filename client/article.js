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
  const { desiredBlockId, resetUndoStacks, editBlockId } = options;
  const switchingArticle = state.articleId !== id;
  state.articleId = id;
  state.isEditingTitle = false;
  state.pendingTextPreview = null;

  const article = await fetchArticle(id);
  state.article = article;

  const shouldResetUndo = typeof resetUndoStacks === 'boolean' ? resetUndoStacks : switchingArticle;
  if (shouldResetUndo) {
    hydrateUndoRedoFromArticle(article);
  }

  const autoEditTarget = editBlockId || state.pendingEditBlockId || null;
  state.pendingEditBlockId = null;
  const primaryTarget = desiredBlockId || autoEditTarget || null;

  let targetSet = false;
  if (primaryTarget) {
    const desired = findBlock(primaryTarget);
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

  if (autoEditTarget && findBlock(autoEditTarget)) {
    state.mode = 'edit';
    state.editingBlockId = autoEditTarget;
  } else {
    state.mode = 'view';
    state.editingBlockId = null;
  }

  upsertArticleIndex(article);
  return article;
}

export async function loadArticleView(id) {
  await ensureArticlesIndexLoaded();
  setViewMode(true);
  refs.blocksContainer.innerHTML = 'Загрузка...';
  try {
    const editTarget = state.pendingEditBlockId || undefined;
    const desired = state.scrollTargetBlockId || editTarget || undefined;
    await loadArticle(id, { resetUndoStacks: true, desiredBlockId: desired, editBlockId: editTarget });
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
  state.pendingEditBlockId = null;
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

  const focusEditingBlock = () => {
    if (state.mode !== 'edit' || !state.editingBlockId) return;
    const editable = refs.blocksContainer?.querySelector(
      `.block[data-block-id="${state.editingBlockId}"] .block-text[contenteditable="true"]`,
    );
    if (!editable) return;
    const active = document.activeElement;
    if (editable === active || editable.contains(active)) return;
    editable.focus({ preventScroll: true });
    placeCaretAtEnd(editable);
  };

  const renderBlocks = async (blocks, container) => {
    for (const block of blocks) {
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
      // debug
      try {
        // eslint-disable-next-line no-console
        console.log('render block', block.id, { text: block.text, sections });
      } catch (e) {
        // ignore
      }

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
        const { buildEditableBlockHtml } = await import('./block.js');
        body.setAttribute('contenteditable', 'true');
        body.innerHTML = rawHtml ? buildEditableBlockHtml(rawHtml) : '<br />';
        body.classList.remove('block-body--empty');
        // body.classList.remove('block-body--no-title'); // Оставляем класс для корректных стилей
        requestAnimationFrame(() => {
          // Заставляем браузер использовать <p> вместо <div> для новых строк. Это помогает с авто-ссылками.
          document.execCommand('defaultParagraphSeparator', false, 'p');
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

      let header = null;
      const isEditingThisBlock = state.mode === 'edit' && state.editingBlockId === block.id;
      if (!isEditingThisBlock) {
        header = document.createElement('div');
        header.className = 'block-header';
        if (!hasTitle) {
          header.classList.add('block-header--no-title');
        }
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
      }

      if (header) blockEl.appendChild(header);
      // Тело блока теперь всегда добавляется, а его видимость контролируется через CSS (display: none для .collapsed)
      // Это предотвращает "прыжки" при переключении в режим редактирования.
      blockEl.appendChild(body);

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
    }
  };

  renderBlocks(article.blocks, refs.blocksContainer).then(() => {
    applyPendingPreviewMarkup();
    if (state.scrollTargetBlockId) {
      const targetId = state.scrollTargetBlockId;
      requestAnimationFrame(() => {
        const target = document.querySelector(`.block[data-block-id="${targetId}"]`);
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          const editable = target.querySelector('.block-text[contenteditable="true"]');
          if (editable && state.mode === 'edit' && state.editingBlockId === targetId) {
            editable.focus({ preventScroll: true });
            placeCaretAtEnd(editable);
          } else {
            target.setAttribute('tabindex', '-1');
            target.focus({ preventScroll: true });
          }
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
    focusEditingBlock();
  });
}

export async function createArticle() {
  if (refs.createArticleBtn) refs.createArticleBtn.disabled = true;
  if (refs.sidebarNewArticleBtn) refs.sidebarNewArticleBtn.disabled = true;
  try {
    const article = await createArticleApi();
    upsertArticleIndex(article);
    state.pendingEditBlockId = article?.blocks?.[0]?.id || null;
    state.scrollTargetBlockId = state.pendingEditBlockId;
    navigate(routing.article(article.id));
    showToast('Статья создана');
  } catch (error) {
    showToast(error.message);
  } finally {
    if (refs.createArticleBtn) refs.createArticleBtn.disabled = false;
    if (refs.sidebarNewArticleBtn) refs.sidebarNewArticleBtn.disabled = false;
  }
}
