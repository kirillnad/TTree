import { state } from './state.js';
import { apiRequest } from './api.js';
import { showToast } from './toast.js';
import { loadArticle } from './article.js';
import { renderArticle } from './article.js';
import { pushUndoEntry, cloneBlockSnapshot } from './undo.js';
import { findBlock, countBlocks, findFallbackBlockId } from './block.js';
import { buildBlockPayloadFromParsed, parseMarkdownBlocksInput, looksLikeMarkdownBlocks } from './markdown.js';
import { isEditableElement } from './utils.js';

export async function startEditing() {
  if (!state.currentBlockId) return;
  state.mode = 'edit';
  state.editingBlockId = state.currentBlockId;
  renderArticle();
}

export async function saveEditing() {
  if (state.mode !== 'edit' || !state.editingBlockId) return;
  const editedBlockId = state.editingBlockId;
  const previousText = findBlock(editedBlockId)?.block.text || '';
  const textElement = document.querySelector(
    `.block[data-block-id="${state.editingBlockId}"] .block-text`,
  );
  const editableHtml = textElement?.innerHTML || '';
  const { buildStoredBlockHtml } = await import('./block.js');
  const newText = buildStoredBlockHtml(editableHtml);

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

export function cancelEditing() {
  if (state.mode !== 'edit') return;
  state.mode = 'view';
  state.editingBlockId = null;
  renderArticle();
}

export async function createSibling(direction) {
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

export async function deleteCurrentBlock() {
  if (!state.currentBlockId) return;
  if (countBlocks(state.article?.blocks || []) <= 1) {
    showToast('Нельзя удалять последний блок');
    return;
  }
  const fallbackId = findFallbackBlockId(state.currentBlockId);
  try {
    const result = await apiRequest(`/api/articles/${state.articleId}/blocks/${state.currentBlockId}`, {
      method: 'DELETE',
    });
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

export async function insertParsedMarkdownBlocks(parsedBlocks = []) {
  if (!parsedBlocks.length) {
    showToast('Не удалось распознать структуру блоков');
    return;
  }
  if (!state.articleId) {
    showToast('Сначала выберите статью');
    return;
  }
  if (!state.currentBlockId) {
    showToast('Сначала выберите блок для вставки');
    return;
  }
  let anchorId = state.currentBlockId;
  let lastInsertedId = null;
  for (const parsed of parsedBlocks) {
    const payload = buildBlockPayloadFromParsed(parsed);
    if (!payload) {
      // eslint-disable-next-line no-continue
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const result = await apiRequest(`/api/articles/${state.articleId}/blocks/${anchorId}/siblings`, {
      method: 'POST',
      body: JSON.stringify({ direction: 'after', payload }),
    });
    if (result?.block?.id) {
      anchorId = result.block.id;
      lastInsertedId = result.block.id;
    }
  }
  if (!lastInsertedId) {
    showToast('Не удалось создать блоки');
    return;
  }
  await loadArticle(state.articleId, { desiredBlockId: lastInsertedId });
  renderArticle();
  showToast('Блоки вставлены из Markdown');
}

export function handleGlobalPaste(event) {
  if (state.mode !== 'view') return;
  const target = event.target;
  if (isEditableElement(target)) {
    return;
  }
  const text = event.clipboardData?.getData('text/plain');
  if (!text || !looksLikeMarkdownBlocks(text)) {
    return;
  }
  event.preventDefault();
  const parsed = parseMarkdownBlocksInput(text);
  insertParsedMarkdownBlocks(parsed).catch((error) => {
    showToast(error.message);
  });
}
