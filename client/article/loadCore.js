// Вынесено из `article.js`: загрузка статьи в state (без DOM-рендера).

import { state } from '../state.js';
import { fetchArticle } from '../api.js?v=11';
import { hydrateUndoRedoFromArticle } from '../undo.js';
import { showToast } from '../toast.js';
import { upsertArticleIndex } from '../sidebar.js';
import { ensureArticleDecrypted } from './encryption.js';
import { updatePublicToggleLabel } from './header.js';

const DEBUG_KEY = 'ttree_debug_article_load_v1';
const PERF_KEY = 'ttree_profile_v1';
function debugEnabled() {
  try {
    return window?.localStorage?.getItem?.(DEBUG_KEY) === '1';
  } catch {
    return false;
  }
}
function perfEnabled() {
  try {
    return window?.localStorage?.getItem?.(PERF_KEY) === '1';
  } catch {
    return false;
  }
}
function debugLog(...args) {
  try {
    if (!debugEnabled()) return;
    // eslint-disable-next-line no-console
    console.log('[article-load]', ...args);
  } catch {
    // ignore
  }
}

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

  debugLog('load.start', { id, switchingArticle, mode: state.mode, isOutlineEditing: state.isOutlineEditing });

  if (switchingArticle) {
    try {
      const outline = await import('../outline/editor.js?v=81');
      if (outline?.flushOutlineAutosave) {
        // Don't block navigation on slow saves: store draft locally and let outbox sync later.
        await outline.flushOutlineAutosave({ mode: 'queue' });
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
  // Important: while fetching the next article, clear the previous one so UI doesn't keep
  // rendering stale content under the new route/title.
  state.article = null;
  state.currentBlockId = null;

  const fetchStartedAt = performance.now();
  const rawArticle = await fetchArticle(id);
  if (perfEnabled()) {
    // eslint-disable-next-line no-console
    console.log('[perf][article-load] fetchArticle', { id, ms: Math.round(performance.now() - fetchStartedAt) });
  }
  debugLog('load.fetched', {
    id,
    ms: Math.round(performance.now() - fetchStartedAt),
    hasDocJson: !!rawArticle?.docJson,
    docContent: Array.isArray(rawArticle?.docJson?.content) ? rawArticle.docJson.content.length : null,
    blocksCount: Array.isArray(rawArticle?.blocks) ? rawArticle.blocks.length : null,
    updatedAt: rawArticle?.updatedAt,
  });
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
      const outline = await import('../outline/editor.js?v=81');
      if (outline?.openOutlineEditor) {
        debugLog('outline.open.start', { id });
        // Don't block article navigation on TipTap mount: on mobile this can take seconds.
        // `openOutlineEditor()` shows its own loading skeleton; we'll let it finish in background.
        const outlineStart = perfEnabled() ? performance.now() : 0;
        void outline.openOutlineEditor();
        if (outlineStart) {
          // eslint-disable-next-line no-console
          console.log('[perf][article-load] outline.open scheduled', { id, ms: Math.round(performance.now() - outlineStart) });
        }
        debugLog('outline.open.scheduled', { id, isOutlineEditing: state.isOutlineEditing });
      }
    } catch (err) {
      // Do not fail silently: otherwise /article becomes blank (blocks may be empty in doc_json-first mode).
      state.isOutlineEditing = false;
      debugLog('outline.open.failed', { id, message: err?.message || String(err || 'error') });
      showToast('Не удалось открыть outline-режим (см. консоль)');
    }
  }
  debugLog('load.done', { id, currentBlockId: state.currentBlockId });
  return article;
}
