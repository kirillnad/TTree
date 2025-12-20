// Вынесено из `article.js`: загрузка статьи в state (без DOM-рендера).

import { state } from '../state.js';
import { fetchArticle } from '../api.js?v=6';
import { hydrateUndoRedoFromArticle } from '../undo.js';
import { showToast } from '../toast.js';
import { upsertArticleIndex } from '../sidebar.js';
import { findBlock, flattenVisible, expandCollapsedAncestors } from '../block.js';
import { ensureArticleDecrypted } from './encryption.js';
import { updatePublicToggleLabel } from './header.js';

export async function loadArticle(id, options = {}) {
  const { desiredBlockId, resetUndoStacks, editBlockId } = options;
  const switchingArticle = state.articleId !== id;

  if (switchingArticle && state.isOutlineEditing) {
    try {
      const outline = await import('../outline/editor.js?v=26');
      if (outline?.flushOutlineAutosave) {
        await outline.flushOutlineAutosave();
      }
      if (outline?.closeOutlineEditor) {
        outline.closeOutlineEditor();
      }
    } catch {
      // ignore
    }
  }

  state.articleId = id;
  state.isEditingTitle = false;
  state.pendingTextPreview = null;

  const rawArticle = await fetchArticle(id);
  let article = rawArticle;
  try {
    // eslint-disable-next-line no-await-in-loop
    article = await ensureArticleDecrypted(rawArticle);
  } catch (error) {
    showToast(error.message || 'Не удалось открыть зашифрованную страницу');
    throw error;
  }
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
  updatePublicToggleLabel();
  return article;
}
