import { state } from './state.js';
import { apiRequest } from './api.js?v=4';
import { refs } from './refs.js';
import { showToast } from './toast.js';
import { loadArticle } from './article.js';
import { renderArticle, rerenderSingleBlock, removeDomBlockById, pushLocalBlockTrashEntry } from './article.js';
import { pushUndoEntry, cloneBlockSnapshot } from './undo.js';
import { findBlock, countBlocks, findFallbackBlockId } from './block.js';
import { buildBlockPayloadFromParsed, parseMarkdownBlocksInput, looksLikeMarkdownBlocks } from './markdown.js';
import { isEditableElement } from './utils.js';
import { encryptTextForArticle, encryptBlockTree } from './encryption.js';

function placeCaretAtEnd(element) {
  if (!element) return;
  element.focus({ preventScroll: true });
  const selection = window.getSelection && window.getSelection();
  if (!selection) return;
  selection.removeAllRanges();
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  selection.addRange(range);
}

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
  if (state.isRagView) return;
  const targetBlockId = state.currentBlockId;
  // Запоминаем текущую прокрутку списка блоков, чтобы
  // вход в режим редактирования не «подскакивал» страницу.
  state.editingScrollTop = refs.blocksContainer ? refs.blocksContainer.scrollTop : null;
  state.mode = 'edit';
  // При входе в режим редактирования не должно быть автоскролла
  // по старому scrollTargetBlockId.
  state.scrollTargetBlockId = null;
  state.editingBlockId = state.currentBlockId;
  state.editingInitialText = findBlock(state.currentBlockId)?.block.text || '';
  state.editingUndo = null;
  // Перерисовываем только текущий блок в режиме редактирования,
  // без полной перерисовки всей статьи.
  await rerenderSingleBlock(targetBlockId);
  // Иногда (например, после операций со структурой/слияния/частичного рендера)
  // DOM-нода блока может ещё не соответствовать state, и частичный ререндер
  // не переводит блок в contenteditable. В этом случае делаем полный ререндер.
  let editable = document.querySelector(
    `.block[data-block-id="${targetBlockId}"] .block-text[contenteditable="true"]`,
  );
  if (!editable) {
    renderArticle();
    await rerenderSingleBlock(targetBlockId);
    editable = document.querySelector(
      `.block[data-block-id="${targetBlockId}"] .block-text[contenteditable="true"]`,
    );
  }
  if (!editable) {
    // Фолбек: возвращаемся в view, чтобы не «залипнуть» в режиме edit без editable.
    state.mode = 'view';
    state.editingBlockId = null;
    state.editingInitialText = '';
    state.editingUndo = null;
    state.currentBlockId = targetBlockId;
    showToast('Не удалось открыть редактирование блока');
    return;
  }
  placeCaretAtEnd(editable);
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
    // Пустой блок: сразу выходим из режима редактирования и оптимистично
    // убираем его из локального дерева, а сетевой DELETE выполняем в фоне.
    const fallbackId = findFallbackBlockId(editedBlockId);
    const locatedForDelete = findBlock(editedBlockId);
    const isEphemeralNew =
      Boolean(locatedForDelete?.block && locatedForDelete.block.__isNew);
    if (locatedForDelete && state.article && Array.isArray(state.article.blocks)) {
      const siblings = locatedForDelete.siblings || state.article.blocks;
      const index =
        locatedForDelete.index ?? siblings.findIndex((b) => b && b.id === editedBlockId);
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
      if (!isEphemeralNew) {
        const snapshot = cloneBlockSnapshot(locatedForDelete.block);
        pushLocalBlockTrashEntry(
          snapshot,
          locatedForDelete.parent?.id || null,
          locatedForDelete.index ?? null,
        );
      }
    }
    state.mode = 'view';
    state.editingBlockId = null;
    state.editingInitialText = '';
    state.currentBlockId = fallbackId;
    state.scrollTargetBlockId = fallbackId;
    removeDomBlockById(editedBlockId);
    renderArticle();

    (async () => {
      try {
        const url = isEphemeralNew
          ? `/api/articles/${state.articleId}/blocks/${editedBlockId}/permanent`
          : `/api/articles/${state.articleId}/blocks/${editedBlockId}`;
        const result = await apiRequest(url, {
          method: 'DELETE',
        });
        if (!isEphemeralNew && result?.block) {
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
        showToast('Пустой блок удалён');
      } catch (error) {
        showToast(error.message || 'Не удалось удалить пустой блок, обновляем страницу');
        try {
          await loadArticle(state.articleId, { desiredBlockId: fallbackId || null });
          renderArticle();
        } catch {
          /* ignore reload error */
        }
      }
    })();
    return;
  }
  // Если после очистки HTML содержимое не изменилось, ничего не сохраняем.
  if (newText === previousText) {
    state.mode = 'view';
    state.editingBlockId = null;
    state.editingInitialText = '';
    state.editingUndo = null;
    state.pendingEditBlockId = null;
    state.currentBlockId = editedBlockId;
    state.scrollTargetBlockId = editedBlockId;
    await rerenderSingleBlock(editedBlockId);
    return;
  }
  // Непустой и изменившийся текст: меняем локальное состояние и UI сразу,
  // а PATCH на сервер отправляем в фоне.
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
  state.editingUndo = null;
  state.pendingEditBlockId = null;
  state.currentBlockId = editedBlockId;
  state.scrollTargetBlockId = editedBlockId;
  await rerenderSingleBlock(editedBlockId);

  (async () => {
    try {
      const payloadText = await maybeEncryptTextForCurrentArticle(newText);
      const updatedBlock = await apiRequest(
        `/api/articles/${state.articleId}/blocks/${editedBlockId}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ text: payloadText }),
        },
      );
      if (previousText !== newText) {
        const isNewBlock = Boolean(located?.block && located.block.__isNew);
        if (isNewBlock) {
          // Первое сохранение только что созданного блока считаем частью создания,
          // чтобы Ctrl+Z удалял такой блок целиком (через структурный undo),
          // а не лишь очищал его текст.
          // Флаг используем только один раз.
          // eslint-disable-next-line no-param-reassign
          delete located.block.__isNew;
        } else {
          pushUndoEntry({
            type: 'text',
            blockId: editedBlockId,
            historyEntryId: updatedBlock?.historyEntryId || null,
          });
        }
      }
      showToast('Блок обновлён');
    } catch (error) {
      showToast(error.message || 'Не удалось сохранить блок, обновляем страницу');
      try {
        await loadArticle(state.articleId, { desiredBlockId: editedBlockId });
        renderArticle();
      } catch {
        /* ignore reload error */
      }
    }
  })();
}

export async function cancelEditing() {
  if (state.mode !== 'edit' || !state.editingBlockId) return;
  const blockId = state.editingBlockId;
  const blockEl = document.querySelector(
    `.block[data-block-id="${blockId}"] .block-text[contenteditable="true"]`,
  );
  const currentText = (blockEl?.textContent || '').replace(/\u00a0/g, ' ').trim();
  const shouldDelete = !currentText;

  // Выходим из режима редактирования немедленно, без ожидания сетевых операций.
  state.mode = 'view';
  state.editingBlockId = null;
  state.editingInitialText = '';
  state.editingUndo = null;

  if (shouldDelete) {
    // Пустой блок при Esc: сразу удаляем его локально и перерисовываем
    // только затронутый участок дерева, а сетевой DELETE выполняем в фоне.
    const fallbackId = findFallbackBlockId(blockId);
    const locatedForDelete = findBlock(blockId);
    const isEphemeralNew =
      Boolean(locatedForDelete?.block && locatedForDelete.block.__isNew);
    if (locatedForDelete && state.article && Array.isArray(state.article.blocks)) {
      const siblings = locatedForDelete.siblings || state.article.blocks;
      const index = locatedForDelete.index ?? siblings.findIndex((b) => b && b.id === blockId);
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
    state.currentBlockId = fallbackId;
    state.scrollTargetBlockId = fallbackId;
    removeDomBlockById(blockId);
    const parentIdForRerender = locatedForDelete?.parent?.id || null;
    if (parentIdForRerender) {
      await rerenderSingleBlock(parentIdForRerender);
    } else {
      renderArticle();
    }

    (async () => {
      try {
        const url = isEphemeralNew
          ? `/api/articles/${state.articleId}/blocks/${blockId}/permanent`
          : `/api/articles/${state.articleId}/blocks/${blockId}`;
        const result = await apiRequest(url, {
          method: 'DELETE',
        });
        if (!isEphemeralNew && result?.block) {
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
        showToast(error.message || 'Не удалось удалить пустой блок, обновляем страницу');
        try {
          await loadArticle(state.articleId, { desiredBlockId: fallbackId || null });
          renderArticle();
        } catch {
          /* ignore */
        }
      }
    })();
    return;
  }

  // Непустой блок: просто выходим из режима редактирования и
  // перерисовываем только этот блок, не трогая остальные.
  state.currentBlockId = blockId;
  await rerenderSingleBlock(blockId);
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
    // Частичная перерисовка:
    // - если есть родитель, достаточно перерисовать его поддерево,
    // - если блок корневой — пока откатываемся к полному рендеру.
    const parentIdForRerender = located?.parent?.id || null;
    if (parentIdForRerender) {
      await rerenderSingleBlock(parentIdForRerender);
    } else {
      renderArticle();
    }
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
  if (!state.article || !Array.isArray(state.article.blocks)) {
    showToast('Сначала откройте статью');
    return;
  }
  const anchorBlockId = state.currentBlockId;
  try {
    const located = findBlock(anchorBlockId);
    if (!located) {
      showToast('Не удалось найти текущий блок');
      return;
    }
    const parentId = located.parent?.id || null;
    let siblingsArray = located.siblings || state.article.blocks;
    if (!Array.isArray(siblingsArray)) {
      siblingsArray = state.article.blocks;
    }
    let baseIndex =
      typeof located.index === 'number'
        ? located.index
        : siblingsArray.findIndex((b) => b && b.id === anchorBlockId);
    if (baseIndex < 0) {
      baseIndex = siblingsArray.length;
    }
    const insertIndex = direction === 'before' ? baseIndex : baseIndex + 1;
    const newBlockId =
      (window.crypto && window.crypto.randomUUID)
        ? window.crypto.randomUUID()
        : `block-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
    const localBlock = {
      id: newBlockId,
      text: '',
      children: [],
      collapsed: false,
      __isNew: true,
    };
    siblingsArray.splice(insertIndex, 0, localBlock);

    if (state.article.updatedAt) {
      try {
        state.article.updatedAt = new Date().toISOString();
      } catch {
        /* ignore */
      }
    }

    state.mode = 'edit';
    state.editingBlockId = newBlockId;
    state.editingInitialText = '';
    state.pendingEditBlockId = null;
    state.currentBlockId = newBlockId;
    // Не трогаем scrollTargetBlockId, чтобы не было лишнего автоскролла:
    // новый блок окажется рядом с текущим и будет виден.

    if (parentId) {
      await rerenderSingleBlock(parentId);
    } else {
      renderArticle();
    }

    // Сетевую часть выполняем в фоне: сервер получает уже готовый payload
    // с тем же id, что и локальный блок.
    (async () => {
      try {
        const payload = {
          id: newBlockId,
          text: '',
          children: [],
          collapsed: false,
        };
        const data = await apiRequest(
          `/api/articles/${state.articleId}/blocks/${anchorBlockId}/siblings`,
          {
            method: 'POST',
            body: JSON.stringify({ direction, payload }),
          },
        );
        const created = data?.block;
        if (!created || !created.id) {
          throw new Error('Не удалось создать новый блок');
        }
        const snapshot = cloneBlockSnapshot(created);
        pushUndoEntry({
          type: 'structure',
          action: {
            kind: 'create',
            parentId: data.parentId || parentId || null,
            index: typeof data.index === 'number' ? data.index : null,
            blockId: created.id,
            block: snapshot,
            fallbackId: anchorBlockId,
          },
        });
      } catch (error) {
        showToast(error.message || 'Не удалось создать новый блок, обновляем страницу');
        try {
          await loadArticle(state.articleId, { desiredBlockId: anchorBlockId });
          renderArticle();
        } catch {
          /* ignore */
        }
      }
    })();
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
  if (state.isDeletingBlock) {
    // Удаление уже в процессе — игнорируем повторное нажатие.
    return;
  }
  state.isDeletingBlock = true;
  const fallbackId = findFallbackBlockId(state.currentBlockId);
  try {
    const targetId = state.currentBlockId;
    const located = findBlock(targetId);
    const snapshotBeforeDelete = located?.block ? cloneBlockSnapshot(located.block) : null;
    const result = await apiRequest(`/api/articles/${state.articleId}/blocks/${state.currentBlockId}`, {
      method: 'DELETE',
    });
    // Оптимистично удаляем блок из локального дерева, без полной перезагрузки статьи.
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
      if (snapshotBeforeDelete && snapshotBeforeDelete.id) {
        pushLocalBlockTrashEntry(
          snapshotBeforeDelete,
          located.parent?.id || null,
          located.index ?? index,
        );
      }
    }
    removeDomBlockById(targetId);
    state.currentBlockId = fallbackId;
    state.scrollTargetBlockId = fallbackId;
    const parentIdForRerender = located?.parent?.id || null;
    if (parentIdForRerender) {
      await rerenderSingleBlock(parentIdForRerender);
    } else {
      renderArticle();
    }
    if (snapshotBeforeDelete && snapshotBeforeDelete.id) {
      pushUndoEntry({
        type: 'structure',
        action: {
          kind: 'delete',
          parentId: located?.parent?.id || null,
          index: located?.index ?? null,
          block: snapshotBeforeDelete,
          blockId: snapshotBeforeDelete.id,
          fallbackId,
        },
      });
    }
  } catch (error) {
    showToast(error.message);
  } finally {
    state.isDeletingBlock = false;
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
     let lastParentId = null;
    for (const parsed of parsedBlocks) {
      const payload = buildBlockPayloadFromParsed(parsed);
      if (!payload) {
        // eslint-disable-next-line no-continue
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const encryptedPayload = await maybeEncryptBlockPayloadForCurrentArticle(payload);
      // eslint-disable-next-line no-await-in-loop
      const result = await apiRequest(`/api/articles/${state.articleId}/blocks/${anchorId}/siblings`, {
        method: 'POST',
        body: JSON.stringify({ direction: 'after', payload: encryptedPayload }),
      });
      const inserted = result?.block;
      if (inserted && inserted.id) {
        anchorId = inserted.id;
        lastInsertedId = inserted.id;
        lastParentId = result.parentId || null;

        // Оптимистично вставляем новый блок в локальное дерево статьи,
        // чтобы не перезагружать всю статью.
        if (state.article && Array.isArray(state.article.blocks)) {
          let siblingsArray = null;
          if (lastParentId) {
            const parentLocated = findBlock(lastParentId);
            const parentBlock = parentLocated?.block || null;
            if (parentBlock) {
              if (!Array.isArray(parentBlock.children)) {
                parentBlock.children = [];
              }
              siblingsArray = parentBlock.children;
            }
          } else {
            siblingsArray = state.article.blocks;
          }
          if (!Array.isArray(siblingsArray)) {
            siblingsArray = state.article.blocks;
          }
          const insertIndexFromServer = typeof result.index === 'number' ? result.index : null;
          const insertIndex =
            insertIndexFromServer !== null &&
            insertIndexFromServer >= 0 &&
            insertIndexFromServer <= siblingsArray.length
              ? insertIndexFromServer
              : siblingsArray.length;
          const localBlock = cloneBlockSnapshot(inserted) || inserted;
          siblingsArray.splice(insertIndex, 0, localBlock);
          if (state.article.updatedAt) {
            try {
              state.article.updatedAt = new Date().toISOString();
            } catch {
              /* ignore */
            }
          }
        }
      }
    }
    if (!lastInsertedId) {
      showToast('Не удалось добавить ни одного блока');
      return;
    }
    state.currentBlockId = lastInsertedId;
    state.scrollTargetBlockId = lastInsertedId;
    if (lastParentId) {
      await rerenderSingleBlock(lastParentId);
    } else {
      renderArticle();
    }
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
