import { state } from './state.js';
import { apiRequest } from './api.js';
import { refs } from './refs.js';
import { showToast } from './toast.js';
import { loadArticle } from './article.js';
import { renderArticle, rerenderSingleBlock } from './article.js';
import { pushUndoEntry, cloneBlockSnapshot } from './undo.js';
import { findBlock, countBlocks, findFallbackBlockId } from './block.js';
import { buildBlockPayloadFromParsed, parseMarkdownBlocksInput, looksLikeMarkdownBlocks } from './markdown.js';
import { isEditableElement } from './utils.js';
import { encryptTextForArticle, encryptBlockTree } from './encryption.js';

function setPasteProgress(active, message = 'Вставляем Markdown...') {
  state.isMarkdownInserting = active;
  const node = refs.pasteProgress;
  if (!node) return;
  const textNode = node.querySelector('.inline-progress__text');
  if (textNode && message) {
    textNode.textContent = message;
  }
  node.classList.toggle('hidden', !active);
}

async function maybeEncryptTextForCurrentArticle(text) {
  if (!state.article || !state.article.encrypted || !state.articleEncryptionKey) {
    return text;
  }
  return encryptTextForArticle(state.articleEncryptionKey, text);
}

async function maybeEncryptBlockPayloadForCurrentArticle(blockPayload) {
  if (!state.article || !state.article.encrypted || !state.articleEncryptionKey || !blockPayload) {
    return blockPayload;
  }
  const clone = JSON.parse(JSON.stringify(blockPayload));
  await encryptBlockTree(clone, state.articleEncryptionKey);
  return clone;
}

export async function startEditing() {
  if (!state.currentBlockId) return;
  state.mode = 'edit';
  state.editingBlockId = state.currentBlockId;
  state.editingInitialText = findBlock(state.currentBlockId)?.block.text || '';
  renderArticle();
}

export async function saveEditing() {
  if (state.mode !== 'edit' || !state.editingBlockId) return;
  const editedBlockId = state.editingBlockId;
  const located = findBlock(editedBlockId);
  const previousText = located?.block.text || '';
  const textElement = document.querySelector(
    `.block[data-block-id="${state.editingBlockId}"] .block-text`,
  );
  const editableHtml = textElement?.innerHTML || '';
  const { cleanupEditableHtml } = await import('./block.js');
  const newText = cleanupEditableHtml(editableHtml);

  const trimmedNew = (newText || '').trim();
  if (!trimmedNew) {
    try {
      const fallbackId = findFallbackBlockId(editedBlockId);
      await apiRequest(`/api/articles/${state.articleId}/blocks/${editedBlockId}`, { method: 'DELETE' });
      state.mode = 'view';
      state.editingBlockId = null;
      state.editingInitialText = '';
      await loadArticle(state.articleId, { desiredBlockId: fallbackId });
      renderArticle();
      showToast('Пустой блок удалён');
    } catch (error) {
      showToast(error.message || 'Не удалось удалить пустой блок');
    }
    return;
  }
  // Если после очистки HTML содержимое не изменилось, ничего не сохраняем.
  if (newText === previousText) {
    state.mode = 'view';
    state.editingBlockId = null;
    state.editingInitialText = '';
    state.pendingEditBlockId = null;
    state.currentBlockId = editedBlockId;
    state.scrollTargetBlockId = editedBlockId;
    await rerenderSingleBlock(editedBlockId);
    return;
  }
  try {
    const payloadText = await maybeEncryptTextForCurrentArticle(newText);
    const updatedBlock = await apiRequest(
      `/api/articles/${state.articleId}/blocks/${state.editingBlockId}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ text: payloadText }),
      },
    );
    if (previousText !== newText) {
      pushUndoEntry({
        type: 'text',
        blockId: editedBlockId,
        historyEntryId: updatedBlock?.historyEntryId || null,
      });
    }
    // Обновляем текст блока в локальном состоянии, чтобы не перезагружать всю статью.
    if (located && state.article && Array.isArray(state.article.blocks)) {
      located.block.text = newText;
      if (state.article.updatedAt) {
        try {
          state.article.updatedAt = new Date().toISOString();
        } catch {
          /* ignore */
        }
      }
    }
    state.mode = 'view';
    state.editingBlockId = null;
    state.editingInitialText = '';
    state.pendingEditBlockId = null;
    state.currentBlockId = editedBlockId;
    state.scrollTargetBlockId = editedBlockId;
    await rerenderSingleBlock(editedBlockId);
    showToast('Блок обновлён');
  } catch (error) {
    showToast(error.message);
  }
}

export function cancelEditing() {
  if (state.mode !== 'edit') return;
  const blockId = state.editingBlockId;
  const blockEl = document.querySelector(
    `.block[data-block-id="${blockId}"] .block-text[contenteditable="true"]`,
  );
  const currentText = (blockEl?.textContent || '').replace(/\u00a0/g, ' ').trim();
  const shouldDelete = !currentText;

  state.mode = 'view';
  state.editingBlockId = null;
  state.editingInitialText = '';

  (async () => {
    if (shouldDelete) {
      const fallbackId = findFallbackBlockId(blockId);
      try {
        await apiRequest(`/api/articles/${state.articleId}/blocks/${blockId}`, { method: 'DELETE' });
        await loadArticle(state.articleId, { desiredBlockId: fallbackId });
      } catch (error) {
        showToast(error.message || 'Не удалось удалить пустой блок');
      }
    }
    renderArticle();
  })();
}

export async function splitEditingBlockAtCaret() {
  if (state.mode !== 'edit' || !state.editingBlockId) return;
  const blockId = state.editingBlockId;
  const blockEl = document.querySelector(`.block[data-block-id="${blockId}"] .block-text[contenteditable="true"]`);
  if (!blockEl) return;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !blockEl.contains(sel.anchorNode)) return;
  const range = sel.getRangeAt(0).cloneRange();
  const marker = document.createElement('span');
  const markerId = `split-marker-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  marker.setAttribute('data-split-marker', markerId);
  marker.textContent = '';
  range.insertNode(marker);
  const fullHtml = blockEl.innerHTML;
  marker.parentNode.removeChild(marker);
  const markerHtml = `<span data-split-marker="${markerId}"></span>`;
  const parts = fullHtml.split(markerHtml);
  if (parts.length !== 2) return;
  const [beforeHtmlRaw, afterHtmlRaw] = parts;
  const { cleanupEditableHtml } = await import('./block.js');
  const beforeClean = cleanupEditableHtml(beforeHtmlRaw || '');
  const afterClean = cleanupEditableHtml(afterHtmlRaw || '');
  if (!afterClean || afterClean === beforeClean) return;

  try {
    const located = findBlock(blockId);
    const previousBlock = located?.block;
    const previousSnapshot = previousBlock ? cloneBlockSnapshot(previousBlock) : null;
    const beforePayloadText = await maybeEncryptTextForCurrentArticle(beforeClean);
    await apiRequest(`/api/articles/${state.articleId}/blocks/${blockId}`, {
      method: 'PATCH',
      body: JSON.stringify({ text: beforePayloadText }),
    });
    const siblingRes = await apiRequest(
      `/api/articles/${state.articleId}/blocks/${blockId}/siblings`,
      {
        method: 'POST',
        body: JSON.stringify({ direction: 'after' }),
      },
    );
    const newBlockId = siblingRes?.block?.id;
    if (!newBlockId) {
      showToast('Не удалось создать новый блок');
      return;
    }
    const afterPayloadText = await maybeEncryptTextForCurrentArticle(afterClean);
    await apiRequest(`/api/articles/${state.articleId}/blocks/${newBlockId}`, {
      method: 'PATCH',
      body: JSON.stringify({ text: afterPayloadText }),
    });
    // Обновляем локальное дерево блоков без полной перезагрузки статьи.
    if (located && state.article && Array.isArray(state.article.blocks)) {
      // Обновляем текст исходного блока.
      located.block.text = beforeClean;
      // Вставляем новый блок рядом.
      const parent = located.parent;
      const siblings = located.siblings || (state.article.blocks || []);
      const insertIndex = (located.index ?? 0) + 1;
      const newBlock = {
        id: newBlockId,
        text: afterClean,
        children: [],
        collapsed: false,
      };
      siblings.splice(insertIndex, 0, newBlock);
      if (state.article.updatedAt) {
        try {
          state.article.updatedAt = new Date().toISOString();
        } catch {
          /* ignore */
        }
      }
    }
    // После разбиения блока сразу редактируем новый блок, с кареткой в начале.
    state.mode = 'edit';
    state.editingBlockId = newBlockId;
    state.pendingEditBlockId = null;
    state.currentBlockId = newBlockId;
    state.scrollTargetBlockId = newBlockId;
    state.editingCaretPosition = 'start';
    renderArticle();
    if (previousSnapshot) {
      pushUndoEntry({
        type: 'text',
        blockId,
        block: previousSnapshot,
      });
    }
  } catch (error) {
    showToast(error.message || 'Не удалось разбить блок');
  }
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
    await loadArticle(state.articleId, { desiredBlockId: data.block.id, editBlockId: data.block.id });
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
    showToast('Нельзя вставлять пустые блоки из Markdown');
    return;
  }
  if (!state.articleId) {
    showToast('Нельзя вставлять блоки без выбранной статьи');
    return;
  }
  if (!state.currentBlockId) {
    showToast('Нельзя вставлять блоки без выбранного блока');
    return;
  }
  if (state.isMarkdownInserting) {
    showToast('Идёт вставка Markdown, пожалуйста, подождите...');
    return;
  }
  setPasteProgress(true);
  try {
    let anchorId = state.currentBlockId;
    let lastInsertedId = null;
    for (const parsed of parsedBlocks) {
      const payload = buildBlockPayloadFromParsed(parsed);
      if (!payload) {
        // eslint-disable-next-line no-continue
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const encryptedPayload = await maybeEncryptBlockPayloadForCurrentArticle(payload);
      const result = await apiRequest(`/api/articles/${state.articleId}/blocks/${anchorId}/siblings`, {
        method: 'POST',
        body: JSON.stringify({ direction: 'after', payload: encryptedPayload }),
      });
      if (result?.block?.id) {
        anchorId = result.block.id;
        lastInsertedId = result.block.id;
      }
    }
    if (!lastInsertedId) {
      showToast('Не удалось добавить ни одного блока');
      return;
    }
    await loadArticle(state.articleId, { desiredBlockId: lastInsertedId });
    renderArticle();
    showToast('Блоки добавлены из Markdown');
  } finally {
    setPasteProgress(false);
  }
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
