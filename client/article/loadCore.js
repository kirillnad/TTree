// Вынесено из `article.js`: загрузка статьи в state (без DOM-рендера).

import { state } from '../state.js';
import { fetchArticle } from '../api.js?v=6';
import { hydrateUndoRedoFromArticle } from '../undo.js';
import { showToast } from '../toast.js';
import { upsertArticleIndex } from '../sidebar.js';
import { ensureArticleDecrypted } from './encryption.js';
import { updatePublicToggleLabel } from './header.js';

function firstOutlineSectionId(docJson) {
  try {
    const content = docJson?.content;
    if (!Array.isArray(content)) return null;
    for (const node of content) {
      if (node?.type === 'outlineSection') {
        const id = String(node?.attrs?.id || '');
        if (id) return id;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export async function loadArticle(id, options = {}) {
  const { desiredBlockId, resetUndoStacks, editBlockId } = options;
  const switchingArticle = state.articleId !== id;

  if (switchingArticle && state.isOutlineEditing) {
    try {
      const outline = await import('../outline/editor.js?v=76');
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

  // Outline-only UX: pick section id from docJson (or fallback to legacy blocks tree).
  const primaryTarget = desiredBlockId || editBlockId || state.pendingEditBlockId || null;
  state.pendingEditBlockId = null;
  const defaultId = firstOutlineSectionId(article.docJson) || (article.blocks?.[0]?.id || null);
  state.currentBlockId = primaryTarget || defaultId;
  state.mode = 'view';
  state.editingBlockId = null;

  upsertArticleIndex(article);
  updatePublicToggleLabel();

  // Outline is the only editor mode now: auto-open after load.
  if (!state.isPublicView && !state.isRagView && !article.encrypted) {
    try {
      state.isOutlineEditing = true;
      const outline = await import('../outline/editor.js?v=76');
      if (outline?.openOutlineEditor) {
        await outline.openOutlineEditor();
      }
    } catch {
      // ignore
    }
  }
  return article;
}
