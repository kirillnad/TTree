import { state } from './state.js';
import { apiRequest } from './api.js';
import { showToast } from './toast.js';
import { loadArticle } from './article.js';
import { renderArticle } from './article.js';
import { findBlock, setCurrentBlock, ensureBlockVisible } from './block.js';
import { logDebug, textareaToTextContent, extractImagesFromHtml } from './utils.js';
import { encryptBlockTree } from './encryption.js';

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
    source === 'redo' ? state.article?.redoHistory || [] : state.article?.history || [];
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

export function applyPendingPreviewMarkup() {
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
  if (action.kind === 'reorder') {
    return {
      kind: 'reorder',
      blockId: action.blockId,
      fromParentId: action.toParentId ?? null,
      fromIndex: action.toIndex ?? null,
      toParentId: action.fromParentId ?? null,
      toIndex: action.fromIndex ?? null,
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
  } else if (action.kind === 'reorder') {
    const result = await moveBlockToParent(action.blockId, action.toParentId ?? null, action.toIndex ?? null, {
      skipRecord: true,
    });
    success = result.success;
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
      // Для undo/redo удаления используем уже существующую структуру restore/create,
      // поэтому здесь достаточно повторно применить deleteCurrentBlock-подобную логику:
      payload = await apiRequest(`/api/articles/${state.articleId}/blocks/${targetId}`, {
        method: 'DELETE',
      });
      // Локально удаляем блок из дерева статьи.
      const located = findBlock(targetId);
      if (located && state.article && Array.isArray(state.article.blocks)) {
        const siblings = located.siblings || state.article.blocks;
        const index = located.index ?? siblings.findIndex((b) => b.id === targetId);
        if (index >= 0) {
          siblings.splice(index, 1);
        }
        if (state.article.updatedAt) {
          try {
            state.article.updatedAt = new Date().toISOString();
          } catch {
            /* ignore */
          }
        }
      }
      const desiredId = action.fallbackId || payload?.parentId || null;
      if (desiredId) {
        await focusBlock(desiredId);
      } else {
        renderArticle();
      }
      success = true;
    } catch (error) {
      showToast(error.message);
      success = false;
    }
  } else if (action.kind === 'restore' || action.kind === 'create') {
    const baseBlockPayload = action.block || action.blockSnapshot;
    if (!baseBlockPayload) {
      return { success: false };
    }
    try {
      let blockPayload = baseBlockPayload;
      if (state.article && state.article.encrypted && state.articleEncryptionKey) {
        blockPayload = JSON.parse(JSON.stringify(baseBlockPayload));
        // eslint-disable-next-line no-await-in-loop
        await encryptBlockTree(blockPayload, state.articleEncryptionKey);
      }
      payload = await apiRequest(`/api/articles/${state.articleId}/blocks/restore`, {
        method: 'POST',
        body: JSON.stringify({
          parentId: action.parentId || null,
          index: action.index ?? null,
          block: blockPayload,
        }),
      });
      // Локально вставляем восстановленный блок в дерево статьи.
      const inserted = payload?.block;
      const parentId = payload?.parentId || action.parentId || null;
      if (inserted && state.article && Array.isArray(state.article.blocks)) {
        const clone = cloneBlockSnapshot(inserted) || inserted;
        if (!parentId) {
          const roots = state.article.blocks;
          const idx =
            typeof payload.index === 'number' && payload.index >= 0 && payload.index <= roots.length
              ? payload.index
              : roots.length;
          roots.splice(idx, 0, clone);
        } else {
          const parentLocated = findBlock(parentId);
          const parentBlock = parentLocated?.block || null;
          if (parentBlock) {
            if (!Array.isArray(parentBlock.children)) {
              parentBlock.children = [];
            }
            const kids = parentBlock.children;
            const idx =
              typeof payload.index === 'number' && payload.index >= 0 && payload.index <= kids.length
                ? payload.index
                : kids.length;
            kids.splice(idx, 0, clone);
          }
        }
        if (state.article.updatedAt) {
          try {
            state.article.updatedAt = new Date().toISOString();
          } catch {
            /* ignore */
          }
        }
      }
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
    const result = await apiRequest(`/api/articles/${state.articleId}/blocks/undo-text`, {
      method: 'POST',
      body: JSON.stringify({ entryId: entry?.historyEntryId || null }),
    });
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
    const result = await apiRequest(`/api/articles/${state.articleId}/blocks/redo-text`, {
      method: 'POST',
      body: JSON.stringify({ entryId: entry?.historyEntryId || null }),
    });
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

export async function handleUndoAction() {
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

export async function handleRedoAction() {
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

export function hydrateUndoRedoFromArticle(article) {
  clearPendingTextPreview({ restoreDom: false });
  const toTextEntry = (entry) => ({
    type: 'text',
    blockId: entry.blockId,
    historyEntryId: entry.id,
  });
  state.undoStack = (article.history || []).map(toTextEntry);
  state.redoStack = (article.redoHistory || []).map(toTextEntry);
}

export function pushUndoEntry(entry) {
  if (!entry) return;
  logDebug('pushUndoEntry', entry);
  state.undoStack.push(entry);
  state.redoStack = [];
}

export function cloneBlockSnapshot(block) {
  try {
    return JSON.parse(JSON.stringify(block || {}));
  } catch {
    return null;
  }
}

export async function focusBlock(blockId) {
  if (!blockId) return;
  await ensureBlockVisible(blockId);
  setCurrentBlock(blockId);
}

export function clearPendingTextPreview({ restoreDom = true } = {}) {
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

export async function moveBlock(blockId, direction, options = {}) {
  if (!blockId || !['up', 'down'].includes(direction)) return false;
  const { skipRecord = false, internal = false } = options;
  if (!internal) {
    if (state.isMovingBlock) return false;
    state.isMovingBlock = true;
  }
  try {
    const located = findBlock(blockId);

    // Особый случай: пытаемся поднять самый верхний дочерний блок.
    // Вместо "ошибки" трактуем это как выход на уровень родителя
    // (outdent + один шаг вверх, чтобы встать рядом с братом родителя).
    if (direction === 'up' && located && located.parent) {
      const siblings = located.siblings || state.article?.blocks || [];
      const index = located.index ?? siblings.findIndex((b) => b.id === blockId);
      if (index === 0) {
        const parentId = located.parent.id;
        // 1) Выносим блок на уровень выше.
        const outdented = await outdentBlock(blockId, { skipRecord: true, keepEditing: false });
        if (!outdented) {
          return false;
        }
        // 2) После outdent блок стоит сразу после родителя — поднимаем его
        // на одну позицию вверх, чтобы оказаться рядом с "братом родителя".
        const movedUp = await moveBlock(blockId, 'up', { skipRecord: true, internal: true });
        // Если по какой‑то причине поднять нельзя (родитель был первым),
        // просто считаем операцию успешной после outdent.
        if (!movedUp) {
          state.currentBlockId = blockId;
          renderArticle();
          if (!skipRecord) {
            pushUndoEntry({ type: 'structure', action: { kind: 'outdent', blockId } });
          }
          return true;
        }
        state.currentBlockId = blockId;
        renderArticle();
        if (!skipRecord) {
          pushUndoEntry({
            type: 'structure',
            action: { kind: 'moveUpThroughParent', blockId, parentId },
          });
        }
        return true;
      }
    }

    // Не пытаемся двигать блок за пределы доступного списка соседей:
    // - вверх, если он уже первый;
    // - вниз, если он уже последний.
    if (located && state.article && Array.isArray(state.article.blocks)) {
      const siblings = located.siblings || state.article.blocks;
      const index = located.index ?? siblings.findIndex((b) => b.id === blockId);
      if (index >= 0) {
        const isFirst = index === 0;
        const isLast = index === siblings.length - 1;
        if ((direction === 'up' && isFirst) || (direction === 'down' && isLast)) {
          return false;
        }
      }
    }

    await apiRequest(`/api/articles/${state.articleId}/blocks/${blockId}/move`, {
      method: 'POST',
      body: JSON.stringify({ direction }),
    });
    // Локально обновляем порядок соседей без полной перезагрузки статьи.
    if (located && state.article && Array.isArray(state.article.blocks)) {
      const siblings = located.siblings || state.article.blocks;
      const index = located.index ?? siblings.findIndex((b) => b.id === blockId);
      if (index >= 0) {
        const targetIndex = direction === 'up' ? index - 1 : index + 1;
        if (targetIndex >= 0 && targetIndex < siblings.length) {
          const [moved] = siblings.splice(index, 1);
          siblings.splice(targetIndex, 0, moved);
        }
      }
      if (state.article.updatedAt) {
        try {
          state.article.updatedAt = new Date().toISOString();
        } catch {
          /* ignore */
        }
      }
    }
    state.currentBlockId = blockId;
    renderArticle();
    if (!skipRecord) {
      pushUndoEntry({ type: 'structure', action: { kind: 'move', blockId, direction } });
    }
    return true;
  } catch (error) {
    showToast(error.message);
    return false;
  } finally {
    if (!internal) {
      state.isMovingBlock = false;
    }
  }
}

export function moveCurrentBlock(direction) {
  return moveBlock(state.currentBlockId, direction);
}

export async function moveBlockToParent(blockId, targetParentId = null, targetIndex = null, options = {}) {
  if (!blockId) return { success: false };
  const { skipRecord = false, anchorId = null, placement = null } = options;
  const located = findBlock(blockId);
  if (!located) {
    showToast('Блок не найден');
    return { success: false };
  }
  const originParentId = located.parent?.id || null;
  const originIndex = located.index ?? 0;

  const targetParent = targetParentId ? findBlock(targetParentId)?.block : null;
  const targetChildrenCount = targetParent
    ? targetParent.children?.length || 0
    : (state.article?.blocks || []).length;

  const desiredIndex =
    typeof targetIndex === 'number' && targetIndex >= 0 ? Math.min(targetIndex, targetChildrenCount) : targetChildrenCount;

  if (originParentId === targetParentId && originIndex === desiredIndex) {
    return {
      success: true,
      noOp: true,
      from: { parentId: originParentId, index: originIndex },
      to: { parentId: targetParentId, index: desiredIndex },
    };
  }

  let insertionIndex = desiredIndex;
  if (targetParentId === originParentId && originIndex < insertionIndex) {
    insertionIndex = Math.max(insertionIndex - 1, 0);
  }

  try {
    const moveResult = await apiRequest(`/api/articles/${state.articleId}/blocks/${blockId}/relocate`, {
      method: 'POST',
      body: JSON.stringify({
        parentId: targetParentId || null,
        index: insertionIndex,
        anchorId: anchorId || null,
        placement: placement || null,
      }),
    });
    // Локально обновляем дерево блоков без полной перезагрузки.
    if (state.article && Array.isArray(state.article.blocks)) {
      const originSiblings = located.siblings || state.article.blocks;
      const fromIndex = located.index ?? originSiblings.findIndex((b) => b.id === blockId);
      let movedBlock = null;
      if (fromIndex >= 0) {
        [movedBlock] = originSiblings.splice(fromIndex, 1);
      }
      if (!movedBlock) {
        // Блок не нашли в массиве — на всякий случай не ломаем дерево.
        movedBlock = located.block;
      }
      // Находим массив детей у целевого родителя.
      let targetChildren;
      if (targetParentId) {
        const targetParent = findBlock(targetParentId);
        if (targetParent && targetParent.block) {
          if (!Array.isArray(targetParent.block.children)) {
            targetParent.block.children = [];
          }
          targetChildren = targetParent.block.children;
        } else {
          targetChildren = state.article.blocks;
        }
      } else {
        targetChildren = state.article.blocks;
      }
      const insertAt =
        typeof insertionIndex === 'number' && insertionIndex >= 0
          ? Math.min(insertionIndex, targetChildren.length)
          : targetChildren.length;
      targetChildren.splice(insertAt, 0, movedBlock);
      if (state.article.updatedAt) {
        try {
          state.article.updatedAt = new Date().toISOString();
        } catch {
          /* ignore */
        }
      }
    }
    state.currentBlockId = blockId;
    renderArticle();
    if (!skipRecord) {
      pushUndoEntry({
        type: 'structure',
        action: {
          kind: 'reorder',
          blockId,
          fromParentId: originParentId,
          fromIndex: originIndex,
          toParentId: moveResult?.parentId ?? targetParentId ?? null,
          toIndex: moveResult?.index ?? insertionIndex,
        },
      });
    }
    await focusBlock(blockId);
    return {
      success: true,
      from: { parentId: originParentId, index: originIndex },
      to: { parentId: moveResult?.parentId ?? targetParentId ?? null, index: moveResult?.index ?? insertionIndex },
    };
  } catch (error) {
    showToast(error.message);
    return { success: false };
  }
}

export async function indentBlock(blockId, options = {}) {
  if (!blockId) return false;
  const { skipRecord = false, keepEditing = false } = options;
  try {
    if (!options.internal) {
      if (state.isMovingBlock) return false;
      state.isMovingBlock = true;
    }
    if (keepEditing) {
      state.pendingEditBlockId = blockId;
      state.scrollTargetBlockId = blockId;
    }
    const located = findBlock(blockId);
    await apiRequest(`/api/articles/${state.articleId}/blocks/${blockId}/indent`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    // Локально повторяем то же преобразование, что и на сервере:
    // новый родитель — предыдущий сосед по siblings, вставка в конец его детей.
    if (located && state.article && Array.isArray(state.article.blocks)) {
      const siblings = located.siblings || state.article.blocks;
      const index = located.index ?? siblings.findIndex((b) => b.id === blockId);
      if (index > 0) {
        const newParentBlock = siblings[index - 1];
        const [moved] = siblings.splice(index, 1);
        if (!Array.isArray(newParentBlock.children)) {
          newParentBlock.children = [];
        }
        newParentBlock.children.push(moved);
        if (state.article.updatedAt) {
          try {
            state.article.updatedAt = new Date().toISOString();
          } catch {
            /* ignore */
          }
        }
      }
    }
    state.currentBlockId = blockId;
    if (keepEditing) {
      state.mode = 'edit';
      state.editingBlockId = blockId;
    }
    renderArticle();
    if (!skipRecord) {
      pushUndoEntry({ type: 'structure', action: { kind: 'indent', blockId } });
    }
    return true;
  } catch (error) {
    showToast(error.message);
    return false;
  } finally {
    if (!options.internal) {
      state.isMovingBlock = false;
    }
  }
}

export function indentCurrentBlock(options = {}) {
  return indentBlock(state.currentBlockId, options);
}

export async function outdentBlock(blockId, options = {}) {
  if (!blockId) return false;
  const { skipRecord = false, keepEditing = false } = options;
  try {
    if (!options.internal) {
      if (state.isMovingBlock) return false;
      state.isMovingBlock = true;
    }
    if (keepEditing) {
      state.pendingEditBlockId = blockId;
      state.scrollTargetBlockId = blockId;
    }
    const located = findBlock(blockId);
    await apiRequest(`/api/articles/${state.articleId}/blocks/${blockId}/outdent`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    // Локально повторяем outdent-логику сервера:
    // новый родитель — родитель текущего родителя, вставка сразу после родителя.
    if (located && state.article && Array.isArray(state.article.blocks)) {
      const parent = located.parent;
      const grandParent = parent ? findBlock(parent.id)?.parent : null;
      const originSiblings = located.siblings || (parent ? parent.children || [] : state.article.blocks);
      const fromIndex = located.index ?? originSiblings.findIndex((b) => b.id === blockId);
      let moved = null;
      if (fromIndex >= 0) {
        [moved] = originSiblings.splice(fromIndex, 1);
      }
      if (!moved) {
        moved = located.block;
      }
      const targetChildren = grandParent
        ? grandParent.block.children || (grandParent.block.children = [])
        : state.article.blocks;
      const parentIndex = targetChildren.indexOf(parent ? parent.block : null);
      const insertPos = parentIndex >= 0 ? parentIndex + 1 : targetChildren.length;
      targetChildren.splice(insertPos, 0, moved);
      if (state.article.updatedAt) {
        try {
          state.article.updatedAt = new Date().toISOString();
        } catch {
          /* ignore */
        }
      }
    }
    state.currentBlockId = blockId;
    if (keepEditing) {
      state.mode = 'edit';
      state.editingBlockId = blockId;
    }
    renderArticle();
    if (!skipRecord) {
      pushUndoEntry({ type: 'structure', action: { kind: 'outdent', blockId } });
    }
    return true;
  } catch (error) {
    showToast(error.message);
    return false;
  } finally {
    if (!options.internal) {
      state.isMovingBlock = false;
    }
  }
}

export function outdentCurrentBlock(options = {}) {
  return outdentBlock(state.currentBlockId, options);
}
