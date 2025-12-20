import { state } from './state.js';
import { apiRequest, uploadAttachmentFileWithProgress, uploadFileToYandexDisk } from './api.js?v=4';
import { showToast } from './toast.js';
import { rerenderSingleBlock } from './article.js';
import { escapeHtml, insertHtmlAtCaret, logDebug } from './utils.js';
import { showPrompt, showImagePreview, showLinkPrompt } from './modal.js?v=8';
import { fetchArticlesIndex } from './api.js?v=4';
import { routing } from './routing.js';
import { navigate } from './routing.js';
import { splitEditingBlockAtCaret } from './actions.js';
// Вынесено из этого файла: навигация/выделение блоков → `./block/selection.js`.
import { flattenVisible, findBlock, setCurrentBlock, moveSelection, extendSelection, updateSelectionUi } from './block/selection.js';

// Публичный API остался прежним, но реализация вынесена в модуль `./block/selection.js`.
export { flattenVisible, findBlock, setCurrentBlock, moveSelection, extendSelection };

// Вынесено из этого файла: заголовок/тело блока + склейка <p> → `./block/paragraphMerge.js`.
import { isSeparatorNode, extractBlockSections, normalizeToParagraphs, maybeHandleParagraphMergeKeydown } from './block/paragraphMerge.js';
// Публичный API остался прежним, но реализация вынесена в модуль `./block/paragraphMerge.js`.
export { isSeparatorNode, extractBlockSections };

// Вынесено из этого файла: очистка/санитайз HTML → `./block/sanitize.js`.
import { cleanupEditableHtml, linkifyHtml, sanitizePastedHtml, trimPastedHtml } from './block/sanitize.js';
export { cleanupEditableHtml };

// Вынесено из этого файла: плейсхолдеры contenteditable → `./block/editable.js`.
import { clearEmptyPlaceholder } from './block/editable.js';

// Вынесено из этого файла: изображения (вставка + resize) → `./block/images.js`.
import {
  isImageLikeFile,
  collectImageFiles,
  collectNonImageFiles,
  insertImageFromFile,
  initResizableImageResizing,
} from './block/images.js';

// Вынесено из этого файла: преобразование <p> ↔ <ol>/<ul> → `./block/lists.js`.
import { applyListAction as applyListActionFromModule } from './block/lists.js';

function resolveYandexDiskHref(rawPath = '') {
  if (!rawPath) return '';
  if (rawPath.startsWith('app:/')) {
    // Открываем файл через наш backend, который
    // по OAuth‑токену пользователя берёт href на скачивание у Я.Диска.
    const encoded = encodeURIComponent(rawPath);
    return `/api/yandex/disk/file?path=${encoded}`;
  }
  if (rawPath.startsWith('disk:/')) {
    const encoded = encodeURIComponent(rawPath);
    return `/api/yandex/disk/file?path=${encoded}`;
  }
  return rawPath;
}

// (flattenVisible) перенесено в `./block/selection.js`.

const EDITING_UNDO_MAX_WORD_TAIL = 16;

function shouldCreateEditingSnapshot(prevText, nextText) {
  if (prevText === nextText) return false;
  // Если пользователь дописывает то же слово: next начинается с prev,
  // а хвост состоит только из букв/цифр и небольшой длины — не создаём
  // новый шаг, чтобы Ctrl+Z откатывал слово целиком.
  if (nextText.startsWith(prevText)) {
    const tail = nextText.slice(prevText.length);
    if (
      tail.length > 0 &&
      tail.length <= EDITING_UNDO_MAX_WORD_TAIL &&
      /^[A-Za-zА-Яа-я0-9]+$/.test(tail)
    ) {
      return false;
    }
  }
  return true;
}

export function initEditingUndoForElement(element, blockId) {
  if (!element || !blockId) return;
  state.editingUndo = {
    blockId,
    snapshots: [element.innerHTML],
    index: 0,
    lastText: element.textContent || '',
    lastSnapshotAt: Date.now(),
  };
  const scheduleSnapshot = () => {
    const session = state.editingUndo;
    if (!session || session.blockId !== blockId) return;
    const html = element.innerHTML;
    const text = element.textContent || '';
    const { snapshots, index, lastText, lastSnapshotAt } = session;
    const now = Date.now();
    if (!shouldCreateEditingSnapshot(lastText || '', text)) {
      session.lastText = text;
      return;
    }
    if (snapshots[index] === html) {
      session.lastText = text;
      session.lastSnapshotAt = now;
      return;
    }
    if (index < snapshots.length - 1) {
      snapshots.splice(index + 1);
    }
    snapshots.push(html);
    session.index = snapshots.length - 1;
    session.lastText = text;
    session.lastSnapshotAt = now;
  };
  element.addEventListener('input', () => {
    if (!state.editingUndo || state.editingUndo.blockId !== blockId) return;
    if (state.mode !== 'edit' || state.editingBlockId !== blockId) return;
    scheduleSnapshot();
  });
}

export function clearEditingUndoSession() {
  state.editingUndo = null;
}

function notifyEditingInput(element) {
  if (!element) return;
  try {
    const evt =
      typeof InputEvent === 'function'
        ? new InputEvent('input', { bubbles: true })
        : new Event('input', { bubbles: true });
    element.dispatchEvent(evt);
  } catch (_error) {
    try {
      const fallback = document.createEvent('Event');
      fallback.initEvent('input', true, false);
      element.dispatchEvent(fallback);
    } catch {
      // ignore synthetic input failures
    }
  }
}

export function applyEditingUndoStep(direction) {
  const session = state.editingUndo;
  if (!session || !session.blockId || !direction) return false;
  if (state.mode !== 'edit' || state.editingBlockId !== session.blockId) return false;
  const editable = document.querySelector(
    `.block[data-block-id="${session.blockId}"] .block-text[contenteditable="true"]`,
  );
  if (!editable) return false;
  const nextIndex = session.index + direction;
  if (nextIndex < 0 || nextIndex >= session.snapshots.length) return false;
  session.index = nextIndex;
  const html = session.snapshots[nextIndex];
  editable.innerHTML = html;
  try {
    editable.focus({ preventScroll: true });
  } catch {
    editable.focus();
  }
  try {
    const sel = window.getSelection && window.getSelection();
    if (sel) {
      const range = document.createRange();
      range.selectNodeContents(editable);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  } catch {
    /* ignore */
  }
  return true;
}

// (findBlock/setCurrentBlock/moveSelection/extendSelection + updateSelectionUi)
// перенесены в `./block/selection.js`.

// (isSeparatorNode/extractBlockSections/normalizeToParagraphs + merge <p> keydown)
// перенесены в `./block/paragraphMerge.js`.

export function buildEditableBlockHtml(html = '') {
  const sections = extractBlockSections(html);
  if (!sections.titleHtml) return html || '';
  const titleContent = normalizeToParagraphs(sections.titleHtml);
  // Очищаем ведущие «пустые» абзацы в теле (p/br),
  // чтобы между заголовком и телом всегда была ровно одна пустая строка.
  let bodyHtml = sections.bodyHtml || '';
  if (bodyHtml) {
    const tmp = document.createElement('template');
    tmp.innerHTML = bodyHtml;
    let first = tmp.content.firstChild;
    while (first && isSeparatorNode(first)) {
      const toRemove = first;
      first = first.nextSibling;
      tmp.content.removeChild(toRemove);
    }
    bodyHtml = tmp.innerHTML;
  }
  const bodyContent = normalizeToParagraphs(bodyHtml || '');
  return `${titleContent}<p><br /></p>${bodyContent}`;
}

export function buildStoredBlockHtml(html = '') {
  const template = document.createElement('template');
  template.innerHTML = html || '';
  // РЈР±РёСЂР°РµРј РІР»РѕР¶РµРЅРЅС‹Рµ block-header, РѕСЃС‚Р°РІР»СЏСЏ С‚РѕР»СЊРєРѕ РєРѕРЅС‚РµРЅС‚
  template.content.querySelectorAll('.block-header').forEach((node) => {
    const parent = node.parentNode;
    if (!parent) return;
    while (node.firstChild) {
      parent.insertBefore(node.firstChild, node);
    }
    parent.removeChild(node);
  });

  const cleanedHtml = template.innerHTML;
  const sections = extractBlockSections(cleanedHtml);
  if (!sections.titleHtml) return html || '';
  const header = `<div class="block-header">${sections.titleHtml}</div>`;
  if (!sections.bodyHtml) return header;
  return `${header}<div><br /></div>${sections.bodyHtml}`;
}

// cleanupEditableHtml перенесён в `./block/sanitize.js`.

export async function toggleCollapse(blockId) {
  const located = findBlock(blockId);
  if (!located) return;
  setCollapseState(blockId, !located.block.collapsed);
}

export async function setCollapseState(blockId, collapsed) {
  const located = findBlock(blockId);
  if (!located || located.block.collapsed === collapsed) return;

  const captureScrollAnchor = () => {
    const container = document.getElementById('blocksContainer');
    if (!container) return null;
    const currentId = state.currentBlockId;
    if (!currentId) return { container };
    const currentEl = container.querySelector(`.block[data-block-id="${currentId}"]`);
    if (!currentEl) return { container };
    const containerRect = container.getBoundingClientRect();
    const currentRect = currentEl.getBoundingClientRect();
    return {
      container,
      currentId,
      topOffset: currentRect.top - containerRect.top,
    };
  };

	  const restoreScrollAnchor = (anchor) => {
	    if (!anchor?.container) return;
	    const { container } = anchor;
	    if (!anchor.currentId || typeof anchor.topOffset !== 'number') return;
	    const currentEl = container.querySelector(`.block[data-block-id="${anchor.currentId}"]`);
	    if (!currentEl) return;
	    const containerRect = container.getBoundingClientRect();
	    const currentRect = currentEl.getBoundingClientRect();
	    const newOffset = currentRect.top - containerRect.top;
	    container.scrollTop += newOffset - anchor.topOffset;
	  };

  const scrollAnchor = captureScrollAnchor();

  located.block.collapsed = collapsed;
  // Оптимистично обновляем только этот блок и его поддерево,
  // без полного пересчёта всей статьи, затем заново обновляем
  // UI выделения (в т.ч. рамку корневого родителя).
  await rerenderSingleBlock(blockId);
  updateSelectionUi({ scrollIntoView: false });
  restoreScrollAnchor(scrollAnchor);

  try {
    const response = await apiRequest(`/api/articles/${state.articleId}/collapse`, {
      method: 'PATCH',
      body: JSON.stringify({ blockId, collapsed }),
    });
    if (response?.updatedAt) {
      state.article.updatedAt = response.updatedAt;
      // Обновляем только метаданные статьи, без полного рендера.
    }
  } catch (error) {
    // В случае ошибки откатываем локальное состояние и
    // снова перерисовываем только затронутый блок.
    located.block.collapsed = !collapsed;
    await rerenderSingleBlock(blockId);
    updateSelectionUi({ scrollIntoView: false });
    restoreScrollAnchor(scrollAnchor);
    showToast(error.message || 'Не удалось изменить состояние блока');
  }
}

export function findCollapsibleTarget(blockId, desiredState) {
  let current = findBlock(blockId);
  while (current) {
    const sections = extractBlockSections(current.block.text || '');
    const hasTitle = Boolean(sections.titleHtml);
    const hasChildren = Boolean(current.block.children?.length);
    if ((hasTitle || hasChildren) && current.block.collapsed !== desiredState) {
      return current.block.id;
    }
    if (!current.parent) break;
    current = findBlock(current.parent.id);
  }
  return null;
}

export async function expandCollapsedAncestors(blockId) {
  const located = findBlock(blockId);
  if (!located) return;
  const ancestorsToExpand = (located.ancestors || []).filter((a) => a.collapsed);
  for (const ancestor of ancestorsToExpand) {
    // eslint-disable-next-line no-await-in-loop
    await setCollapseState(ancestor.id, false);
  }
}

export function findFallbackBlockId(blockId) {
  const located = findBlock(blockId);
  if (!located) return null;
  const next = located.siblings?.[located.index + 1];
  if (next) return next.id;
  const prev = located.siblings?.[located.index - 1];
  if (prev) return prev.id;
  return located.parent ? located.parent.id : null;
}

export function countBlocks(blocks = []) {
  return (blocks || []).reduce((acc, block) => acc + 1 + countBlocks(block.children || []), 0);
}

// linkifyHtml/sanitizePastedHtml/trimPastedHtml перенесены в `./block/sanitize.js`.
// clearEmptyPlaceholder перенесён в `./block/editable.js`.

// isImageLikeFile/collectImageFiles/collectNonImageFiles/insertImageFromFile перенесены в `./block/images.js`.

let attachmentUploadNoticeShown = false;

async function insertAttachmentFromFile(element, file, blockId) {
  if (!state.articleId) {
    showToast('Не выбрана статья для вставки файла');
    return;
  }
  const token = `att-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const safeName = escapeHtml(file?.name || 'файл');
   const displayName = file?.name || 'файл';
   let lastProgressLabel = '';
  logDebug('attachment: uploading to Yandex Disk', {
    name: file?.name,
    type: file?.type,
    size: file?.size,
    articleId: state.articleId,
    token,
  });
  // Показываем плейсхолдер сразу, чтобы было видно, что файл вставлен.
  try {
    clearEmptyPlaceholder(element);
    insertHtmlAtCaret(
      element,
      `<a data-pending-attachment="true" data-attachment-token="${token}">${safeName} (загрузка...)</a>`,
    );
  } catch (_) {
    // Если не получилось вставить плейсхолдер, продолжаем без него.
  }
  try {
    const attachment = await uploadFileToYandexDisk(state.articleId, file, {
      onProgress: (rawPercent) => {
        const percent = Math.max(0, Math.min(100, Math.round(rawPercent || 0)));
        logDebug('attachment upload progress', { percent, name: file?.name });
        try {
          let container = element;
          let placeholder = container.querySelector(
            `a[data-attachment-token="${token}"][data-pending-attachment="true"]`,
          );
          if (blockId && (!placeholder || !container.isConnected)) {
            const blockRoot = document.querySelector(`.block[data-block-id="${blockId}"]`);
            if (blockRoot) {
              const liveEditable = blockRoot.querySelector('.block-text[contenteditable="true"]');
              const liveBody = liveEditable || blockRoot.querySelector('.block-text.block-body');
              if (liveBody) {
                container = liveBody;
                placeholder = container.querySelector(
                  `a[data-attachment-token="${token}"][data-pending-attachment="true"]`,
                );
              }
            }
          }
          if (placeholder) {
            const label =
              percent >= 100
                ? `${displayName} (обработка...)`
                : `${displayName} (${percent}%)`;
            if (label !== lastProgressLabel) {
              lastProgressLabel = label;
              placeholder.textContent = label;
            }
          }
        } catch (_) {
          /* ignore progress UI errors */
        }
      },
    });
    const finalName = escapeHtml(attachment.originalName || file.name || 'файл');
    const rawHref = attachment.storedPath || attachment.url || '';
    const resolvedHref = resolveYandexDiskHref(rawHref);
    const href = escapeHtml(resolvedHref);
    if (href) {
      let container = element;
      let placeholder = container.querySelector(
        `a[data-attachment-token="${token}"][data-pending-attachment="true"]`,
      );
      if (blockId && (!placeholder || !container.isConnected)) {
        const blockRoot = document.querySelector(`.block[data-block-id="${blockId}"]`);
        if (blockRoot) {
          const liveEditable = blockRoot.querySelector('.block-text[contenteditable="true"]');
          const liveBody = liveEditable || blockRoot.querySelector('.block-text.block-body');
          if (liveBody) {
            container = liveBody;
            placeholder = container.querySelector(
              `a[data-attachment-token="${token}"][data-pending-attachment="true"]`,
            );
          }
        }
      }
      if (placeholder) {
        placeholder.removeAttribute('data-pending-attachment');
        placeholder.removeAttribute('data-attachment-token');
        placeholder.setAttribute('href', href);
        placeholder.setAttribute('target', '_blank');
        placeholder.setAttribute('rel', 'noopener noreferrer');
        placeholder.textContent = finalName;
      } else {
        // Если плейсхолдер не нашли — просто вставляем ссылку в текущую позицию.
        clearEmptyPlaceholder(container);
        insertHtmlAtCaret(
          container,
          `<a href="${href}" target="_blank" rel="noopener noreferrer">${finalName}</a>`,
        );
      }
    }
  } catch (error) {
    try {
      let container = element;
      if (blockId && !container.isConnected) {
        const blockRoot = document.querySelector(`.block[data-block-id="${blockId}"]`);
        if (blockRoot) {
          const liveEditable = blockRoot.querySelector('.block-text[contenteditable="true"]');
          const liveBody = liveEditable || blockRoot.querySelector('.block-text.block-body');
          if (liveBody) {
            container = liveBody;
          }
        }
      }
      const placeholder = container.querySelector(
        `a[data-attachment-token="${token}"][data-pending-attachment="true"]`,
      );
      if (placeholder) {
        placeholder.textContent = `${safeName} (ошибка загрузки)`;
      }
    } catch (_) {
      /* ignore */
    }
    const msg = String(error?.message || '').toLowerCase();
    if (msg.includes('status 0') || msg.includes('network error')) {
      showToast('Не удалось загрузить файл (проблема с соединением). Обновите страницу и, при необходимости, войдите заново.');
    } else {
      showToast(error.message || 'Не удалось загрузить файл на Яндекс.Диск');
    }
  }
}

export function insertFilesIntoEditable(element, files = [], blockId) {
  if (!element || !files || !files.length) return;
  const list = Array.from(files);
  const imageFiles = list.filter((file) => isImageLikeFile(file));
  const otherFiles = list.filter((file) => file && !isImageLikeFile(file));
  imageFiles.forEach((file) => insertImageFromFile(element, file, blockId));
  otherFiles.forEach((file) => insertAttachmentFromFile(element, file, blockId));
}

export function attachRichContentHandlers(element, blockId) {
  attachContextMenu(element, blockId);
  const container = element.closest('.block-content');
  if (container && container !== element) {
    attachContextMenu(container, blockId, element);
  }
  element.addEventListener('paste', (event) => {
    if (state.mode !== 'edit' || state.editingBlockId !== blockId) return;
    const imageFiles = collectImageFiles(event.clipboardData?.items);
    const otherFiles = collectNonImageFiles(event.clipboardData?.items);
    if (imageFiles.length > 0) {
      event.preventDefault();
      imageFiles.forEach((file) => insertImageFromFile(element, file, blockId));
    } else if (otherFiles.length > 0) {
      event.preventDefault();
      logDebug('paste: non-image files detected', otherFiles.map((f) => ({ name: f.name, type: f.type, size: f.size })));
      otherFiles.forEach((file) => insertAttachmentFromFile(element, file, blockId));
    } else {
      const htmlData = (event.clipboardData?.getData('text/html') || '').trim();
      event.preventDefault();

      if (htmlData) {
        const safeHtml = sanitizePastedHtml(htmlData);
        const trimmed = trimPastedHtml(safeHtml);
        clearEmptyPlaceholder(element);
        insertHtmlAtCaret(element, linkifyHtml(trimmed));
        notifyEditingInput(element);
      } else {
        const text = event.clipboardData?.getData('text/plain') || '';
        const trimmed = text.trim();
        const isLikelyUrl = /^https?:\/\/\S+$/i.test(trimmed);
        if (isLikelyUrl) {
          const safeUrl = escapeHtml(trimmed);
          clearEmptyPlaceholder(element);
          insertHtmlAtCaret(
            element,
            `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeUrl}</a>`,
          );
          notifyEditingInput(element);
        } else {
          const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
          // Для обычного текста считаем, что одна пустая строка между абзацами —
          // это «настоящий» перенос, а одиночные переводы строк внутри абзаца
          // можно схлопнуть до пробела. Поэтому оставляем <br /><br /> только
          // на местах двойных (и более) переводов строк.
          const safeTextHtml = escapeHtml(normalized)
            .replace(/\n{2,}/g, '<br /><br />')
            .replace(/\n/g, ' ');
          const safeHtml = linkifyHtml(trimPastedHtml(safeTextHtml));
          clearEmptyPlaceholder(element);
          insertHtmlAtCaret(element, safeHtml);
          notifyEditingInput(element);
        }
      }
    }
  });

  element.addEventListener('drop', (event) => {
    if (state.mode !== 'edit' || state.editingBlockId !== blockId) {
      logDebug('drop ignored', { mode: state.mode, editingBlockId: state.editingBlockId, targetBlockId: blockId });
      return;
    }
    const allFiles = Array.from(event.dataTransfer?.files || []);
    if (!allFiles.length) return;
    const imageFiles = allFiles.filter((file) => file.type?.startsWith('image/'));
    const otherFiles = allFiles.filter((file) => !file.type || !file.type.startsWith('image/'));
    if (!imageFiles.length && !otherFiles.length) return;
    event.preventDefault();
    logDebug('drop: files detected', allFiles.map((f) => ({ name: f.name, type: f.type, size: f.size })));
    imageFiles.forEach((file) => insertImageFromFile(element, file, blockId));
    otherFiles.forEach((file) => insertAttachmentFromFile(element, file, blockId));
  });

  element.addEventListener('click', (event) => {
    const img = event.target?.closest('img');
    if (img) {
      const handle = event.target?.closest('.resizable-image__handle');
      if (handle) {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      showImagePreview(img.src, img.alt || '');
      return;
    }
    const link = event.target?.closest('a[href]');
    if (!link) return;
    const rawHref = link.getAttribute('href') || '';
    if (!rawHref.startsWith('app:/') && !rawHref.startsWith('disk:/')) return;
    event.preventDefault();
    const resolved = resolveYandexDiskHref(rawHref);
    if (resolved) {
      window.open(resolved, '_blank', 'noopener,noreferrer');
    }
  });

  if (state.articleId === 'inbox') {
    element.addEventListener('click', async (event) => {
      const moveBtn = event.target?.closest('.move-block-btn');
      if (!moveBtn) return;
      event.preventDefault();
      event.stopPropagation();
      try {
        const list = state.articlesIndex.length ? state.articlesIndex : await fetchArticlesIndex();
        const suggestions = list
          .filter((item) => item.id !== 'inbox')
          .map((item) => ({ id: item.id, title: item.title || 'Р‘РµР· РЅР°Р·РІР°РЅРёСЏ' }));
        const result = await showPrompt({
          title: 'РџРµСЂРµРЅРµСЃС‚Рё РІ СЃС‚Р°С‚СЊСЋ',
          message: 'Р’РІРµРґРёС‚Рµ ID РёР»Рё РІС‹Р±РµСЂРёС‚Рµ СЃС‚Р°С‚СЊСЋ',
          confirmText: 'РџРµСЂРµРЅРµСЃС‚Рё',
          cancelText: 'РћС‚РјРµРЅР°',
          suggestions,
          returnMeta: true,
          hideConfirm: false,
        });
        const targetId = result?.selectedId || (typeof result === 'object' ? result?.value : result) || '';
        const trimmed = (targetId || '').trim();
        if (!trimmed) return;
        await apiRequest(`/api/articles/${state.articleId}/blocks/${blockId}/move-to/${trimmed}`, { method: 'POST' });
        navigate(routing.article('inbox'));
      } catch (error) {
        showToast(error.message || 'РќРµ СѓРґР°Р»РѕСЃСЊ РїРµСЂРµРЅРµСЃС‚Рё Р±Р»РѕРє');
      }
    });
  }

  element.addEventListener('dragover', (event) => {
    if (state.mode !== 'edit' || state.editingBlockId !== blockId) return;
    const hasFiles =
      collectImageFiles(event.dataTransfer?.items).length > 0 ||
      collectNonImageFiles(event.dataTransfer?.items).length > 0;
    if (hasFiles) {
      event.preventDefault();
    }
  });

  element.addEventListener('keydown', (event) => {
    if (state.mode !== 'edit' || state.editingBlockId !== blockId) return;

    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (!range || !range.collapsed) return;

    // Вынесено из этого файла: склейка <p> по Backspace/Delete → `./block/paragraphMerge.js`.
    if (
      maybeHandleParagraphMergeKeydown({
        event,
        element,
        range,
        selection: sel,
        notifyEditingInput,
        logDebug,
      })
    ) {
      return;
    }

    if (event.key !== 'Tab') return;
    // Таб в режиме редактирования: если курсор внутри элемента списка,
    // смещаем ul/ol вправо/влево. В остальных случаях не перехватываем
    // событие, чтобы глобальный обработчик мог, например, сохранить блок.
    const node =
      range.commonAncestorContainer?.nodeType === Node.ELEMENT_NODE
        ? range.commonAncestorContainer
        : range.commonAncestorContainer?.parentElement;
    const li = node?.closest?.('li');
    if (!li) {
      // Не в элементе списка — даём событию подняться выше.
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const command = event.shiftKey ? 'outdent' : 'indent';
    document.execCommand(command, false, null);
  });

  // Не перехватываем PageUp/PageDown и колесо мыши в режиме редактирования,
  // чтобы прокручивался весь список блоков (контейнер статьи), а не отдельный блок.
  // События прокрутки обрабатываются ближайшим прокручиваемым контейнером (blocksContainer).
}

let richContextMenu = null;
let richContextRange = null;
let richContextTarget = null;
let richLastActiveEditable = null;
let appClipboard = {
  html: '',
  text: '',
  sourceBlockId: null,
};
let lastEditableSelectionRange = null;
let selectionTrackerInitialized = false;
// resizableImageSession + pointer handlers перенесены в `./block/images.js`.

function captureEditableSelectionRange() {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return;
  const range = selection.getRangeAt(0);
  const container = range.commonAncestorContainer;
  const anchorElement =
    container?.nodeType === Node.ELEMENT_NODE ? container : container?.parentElement;
  const editable = anchorElement?.closest('.block-text[contenteditable="true"]');
  if (!editable) {
    lastEditableSelectionRange = null;
    return;
  }
  const blockEl = editable.closest('.block');
  const blockId = blockEl?.dataset?.blockId;
  if (state.mode !== 'edit' || state.editingBlockId !== blockId) {
    lastEditableSelectionRange = null;
    return;
  }
  lastEditableSelectionRange = range.cloneRange();
}

// Ресайз изображений (pointer handlers) перенесён в `./block/images.js`.
initResizableImageResizing();

function ensureContextMenu() {
  if (richContextMenu) return richContextMenu;
  if (!selectionTrackerInitialized) {
    document.addEventListener('selectionchange', captureEditableSelectionRange);
    selectionTrackerInitialized = true;
  }
  const menu = document.createElement('div');
  menu.className = 'rich-context-menu hidden';
  menu.innerHTML = `
    <div class="rich-context-menu__col rich-context-menu__col--buffer">
      <div class="rich-context-menu__grid">
        <button class="rich-context-menu__icon-btn" data-action="copy" aria-label="Копировать" title="Копировать">⧉</button>
        <button class="rich-context-menu__icon-btn" data-action="cut" aria-label="Вырезать" title="Вырезать">✂</button>
        <button class="rich-context-menu__icon-btn" data-action="paste" aria-label="Вставить" title="Вставить">▣</button>
        <button class="rich-context-menu__icon-btn" data-action="select-all" aria-label="Выбрать всё" title="Выбрать всё">⛶</button>
      </div>
    </div>
    <div class="rich-context-menu__col">
      <div class="rich-context-menu__grid">
        <button class="rich-context-menu__icon-btn" data-action="bold" aria-label="Полужирный" title="Полужирный"><strong>Ж</strong></button>
        <button class="rich-context-menu__icon-btn" data-action="italic" aria-label="Курсив" title="Курсив"><em>/</em></button>
        <button class="rich-context-menu__icon-btn" data-action="underline" aria-label="Подчеркнуть" title="Подчеркнуть"><u>Ч</u></button>
        <button class="rich-context-menu__icon-btn" data-action="remove-format" aria-label="Очистить формат" title="Очистить формат">✕</button>
      </div>
    </div>
    <div class="rich-context-menu__col">
      <div class="rich-context-menu__grid">
        <button class="rich-context-menu__icon-btn" data-action="ul" aria-label="Маркированный список" title="Маркированный список">•</button>
        <button class="rich-context-menu__icon-btn" data-action="ol" aria-label="Нумерованный список" title="Нумерованный список">1.</button>
        <button class="rich-context-menu__icon-btn" data-action="quote" aria-label="Цитата" title="Цитата">❝</button>
        <button class="rich-context-menu__icon-btn" data-action="code" aria-label="Код" title="Код">&lt;/&gt;</button>
      </div>
    </div>
    <div class="rich-context-menu__col">
      <div class="rich-context-menu__grid">
        <button class="rich-context-menu__icon-btn" data-action="link" aria-label="Ссылка" title="Ссылка">🔗</button>
        <button class="rich-context-menu__icon-btn" data-action="unlink" aria-label="Убрать ссылку" title="Убрать ссылку">⊘</button>
        <button class="rich-context-menu__icon-btn" data-action="insert-article-link" aria-label="Ссылка на статью" title="Ссылка на статью">§</button>
      </div>
    </div>
    <div class="rich-context-menu__col">
      <div class="rich-context-menu__grid">
        <button class="rich-context-menu__icon-btn" data-action="split-at-caret" aria-label="Разделить блок по курсору" title="Разделить блок по курсору">|↵</button>
      </div>
    </div>
  `;
  document.body.appendChild(menu);

  const hideContextMenu = () => {
    menu.classList.add('hidden');
    menu.style.visibility = '';
    richContextRange = null;
    richContextTarget = null;
    richLastActiveEditable = null;
  };

  const restoreSelection = () => {
    if (richContextRange) {
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(richContextRange);
    }
  };

  const applyAction = async (action) => {
    restoreSelection();

    const resolveTarget = () => {
      if (richContextTarget && document.contains(richContextTarget)) return richContextTarget;
      const selNow = window.getSelection();
      const anchorNode = selNow?.anchorNode;
      const fromSelection = anchorNode?.parentElement?.closest('.block-text[contenteditable]');
      if (fromSelection) return fromSelection;
      if (richContextRange) {
        const container = richContextRange.commonAncestorContainer;
        if (container?.parentElement) {
          const fromRange = container.parentElement.closest('.block-text[contenteditable]');
          if (fromRange) return fromRange;
        }
      }
      if (richLastActiveEditable && document.contains(richLastActiveEditable)) return richLastActiveEditable;
      if (state.editingBlockId) {
        const byId = document.querySelector(
          `.block[data-block-id="${state.editingBlockId}"] .block-text[contenteditable="true"]`,
        );
        if (byId) return byId;
      }
      const active = document.activeElement;
      if (active && active.closest) {
        const fromActive = active.closest('.block-text[contenteditable]');
        if (fromActive) return fromActive;
      }
      return null;
    };

    const applyListAction = (listTag) => {
      applyListActionFromModule({
        listTag,
        resolveTarget,
        restoreSelection,
        richContextRange,
        notifyEditingInput,
        setRichContextRange: (nextRange) => {
          richContextRange = nextRange ? nextRange.cloneRange() : null;
        },
      });
    };

    const applyInsertArticleLink = async () => {
      const targetEl = resolveTarget();
      if (!targetEl) {
        showToast('Не удалось найти место вставки ссылки');
        return;
      }
      const list = state.articlesIndex.length ? state.articlesIndex : await fetchArticlesIndex();
      const suggestions = list.map((item) => ({
        id: item.id,
        title: item.title || 'Без названия',
      }));
      let input = '';
      let selectedId = '';
      try {
        const result = await showPrompt({
          title: 'Ссылка на статью',
          message: 'Введите ID статьи. Подсказки помогут найти нужную.',
          confirmText: 'Вставить',
          cancelText: 'Отмена',
          suggestions,
          returnMeta: true,
          hideConfirm: true,
        });
        if (result && typeof result === 'object') {
          input = result.value || '';
          selectedId = result.selectedId || '';
        } else {
          input = result || '';
        }
      } catch (_) {
        input = window.prompt('Введите ID статьи') || '';
      }
      const term = (input || '').trim().toLowerCase();
      if (!term && !selectedId) return;
      const match = list.find((item) => {
        const titleLc = (item.title || '').toLowerCase();
        return (
          (selectedId && item.id === selectedId) ||
          (item.id && item.id.toLowerCase() === term) ||
          titleLc === term ||
          titleLc.includes(term)
        );
      });
      if (!match) {
        showToast('Статья не найдена');
        return;
      }
      if (!targetEl || !document.contains(targetEl)) {
        showToast('Не удалось найти место вставки ссылки');
        return;
      }
      restoreSelection();
      targetEl.focus();
      const linkHtml = `<a href="${routing.article(match.id)}" class="article-link" data-article-id="${match.id}">${escapeHtml(match.title || 'Без названия')}</a>`;
      insertHtmlAtCaret(targetEl, linkHtml);
      const htmlNow = (targetEl.innerHTML || '').trim();
      if (!htmlNow || htmlNow === '<br>' || htmlNow === '<br/>' || htmlNow === '<br />') {
        targetEl.innerHTML = linkHtml;
      }
      targetEl.classList.remove('block-body--empty');
    };

    const clearAllFormatting = () => {
      restoreSelection();
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      document.execCommand('removeFormat');
      for (let i = 0; i < 4; i += 1) {
        document.execCommand('outdent');
      }
      document.execCommand('formatBlock', false, 'p');
    };

    const captureSelectionToClipboard = (kind) => {
      const target = resolveTarget();
      if (!target || !document.contains(target)) {
        showToast('Не удалось найти текст для копирования');
        return null;
      }
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) {
        return null;
      }
      const range = sel.getRangeAt(0).cloneRange();
      if (!range || range.collapsed) {
        return null;
      }
      const fragment = range.cloneContents();
      const wrapper = document.createElement('div');
      wrapper.appendChild(fragment);
      const html = wrapper.innerHTML || '';
      const text = wrapper.textContent || '';
      const blockEl = target.closest('.block');
      const blockId = blockEl?.dataset.blockId || null;
      appClipboard = { html, text, sourceBlockId: blockId };
      logDebug('clipboard.capture', { kind, hasHtml: Boolean(html), length: text.length, blockId });
      return { range, target };
    };

    switch (action) {
      case 'cut': {
        const captured = captureSelectionToClipboard('cut');
        if (!captured) break;
        document.execCommand('cut');
        break;
      }
      case 'copy':
        captureSelectionToClipboard('copy');
        document.execCommand('copy');
        break;
      case 'select-all': {
        const target = resolveTarget();
        if (!target || !document.contains(target)) break;
        const range = document.createRange();
        range.selectNodeContents(target);
        const sel = window.getSelection();
        if (sel) {
          sel.removeAllRanges();
          sel.addRange(range);
        }
        richContextRange = range.cloneRange();
        break;
      }
      case 'paste': {
        const target = resolveTarget();
        if (!target || !document.contains(target)) {
          showToast('Не удалось найти место вставки');
          break;
        }
        if (!appClipboard || (!appClipboard.html && !appClipboard.text)) {
          showToast('Сначала скопируйте или вырежьте текст в редакторе');
          break;
        }
        restoreSelection();
        const selection = window.getSelection();
        let range = null;
        if (richContextRange && target.contains(richContextRange.commonAncestorContainer)) {
          range = richContextRange.cloneRange();
        } else if (selection && selection.rangeCount > 0) {
          const candidate = selection.getRangeAt(0);
          if (target.contains(candidate.commonAncestorContainer)) {
            range = candidate.cloneRange();
          }
        }
        if (!range) {
          range = document.createRange();
          range.selectNodeContents(target);
          range.collapse(false);
        }
        const html = appClipboard.html || escapeHtml(appClipboard.text).replace(/\n/g, '<br />');
        const tmp = document.createElement('div');
        tmp.innerHTML = html;
        const frag = document.createDocumentFragment();
        while (tmp.firstChild) frag.appendChild(tmp.firstChild);
        range.deleteContents();
        range.insertNode(frag);
        range.collapse(false);
        if (selection) {
          selection.removeAllRanges();
          selection.addRange(range);
        }
        target.focus({ preventScroll: true });
        target.classList.remove('block-body--empty');
        break;
      }
      case 'bold':
        document.execCommand('bold');
        break;
      case 'italic':
        document.execCommand('italic');
        break;
      case 'underline':
        document.execCommand('underline');
        break;
      case 'ul':
        applyListAction('ul');
        break;
      case 'ol':
        applyListAction('ol');
        break;
      case 'quote':
        document.execCommand('formatBlock', false, 'blockquote');
        break;
      case 'code':
        document.execCommand('formatBlock', false, 'pre');
        break;
      case 'link': {
        const sel = window.getSelection();
        const selectedText = sel ? sel.toString() : '';
        const focusNode = sel?.anchorNode;
        const anchor = focusNode ? focusNode.parentElement?.closest('a') : null;
        const currentHref = anchor?.getAttribute('href') || '';
        const promptResult = await showLinkPrompt({
          title: 'Ссылка',
          textLabel: 'Текст',
          urlLabel: 'Ссылка',
          defaultText: selectedText || anchor?.textContent || '',
          defaultUrl: currentHref,
          confirmText: 'Вставить',
          cancelText: 'Отмена',
        });
        logDebug('link action: prompt result', {
          hasResult: Boolean(promptResult),
          url: promptResult?.url,
          text: promptResult?.text,
        });
        if (!promptResult || !promptResult.url) break;
        const safeUrl = promptResult.url.match(/^[a-z]+:/i) ? promptResult.url : `https://${promptResult.url}`;
        const label = promptResult.text?.trim() || safeUrl;
        restoreSelection();
        const target = resolveTarget();
        logDebug('link action: target', {
          targetExists: Boolean(target),
          inDom: Boolean(target && document.contains(target)),
          className: target?.className,
        });
        if (!target || !document.contains(target)) break;
        const selection = window.getSelection();
        let range = null;
        if (richContextRange && target.contains(richContextRange.commonAncestorContainer)) {
          range = richContextRange.cloneRange();
        } else if (selection && selection.rangeCount > 0 && target.contains(selection.getRangeAt(0).commonAncestorContainer)) {
          range = selection.getRangeAt(0).cloneRange();
        }
        if (!range) {
          range = document.createRange();
          range.selectNodeContents(target);
          range.collapse(false);
        }
        logDebug('link action: range chosen', {
          usedSelectionRange: Boolean(selection && selection.rangeCount > 0 && target.contains(selection.getRangeAt(0).commonAncestorContainer)),
          usedStoredRange: Boolean(richContextRange && target.contains(richContextRange.commonAncestorContainer)),
          selectionRangeCollapsed: Boolean(selection && selection.rangeCount > 0 && selection.getRangeAt(0).collapsed),
          rangeStartNode: range?.startContainer?.nodeName,
          rangeOffset: range?.startOffset,
          labelLength: (label || '').length,
          url: safeUrl,
        });

        const linkNode = document.createElement('a');
        linkNode.href = safeUrl;
        linkNode.target = '_blank';
        linkNode.rel = 'noopener noreferrer';
        linkNode.textContent = label;

        range.deleteContents();
        range.insertNode(linkNode);
        range.setStartAfter(linkNode);
        range.setEndAfter(linkNode);
        logDebug('link action: inserted link', {
          outerHTML: linkNode.outerHTML,
          parentClass: linkNode.parentElement?.className,
          targetInner: target.innerHTML.slice(0, 120),
        });

        if (selection) {
          selection.removeAllRanges();
          selection.addRange(range);
        }
        target.focus({ preventScroll: true });
        target.classList.remove('block-body--empty');
        break;
      }
      case 'unlink': {
        const target = resolveTarget();
        logDebug('unlink action: target', {
          targetExists: Boolean(target),
          inDom: Boolean(target && document.contains(target)),
          className: target?.className,
        });
        if (!target || !document.contains(target)) break;
        const selection = window.getSelection();
        let anchor = null;
        if (selection && selection.rangeCount > 0) {
          const node = selection.getRangeAt(0).commonAncestorContainer;
          anchor = node?.parentElement?.closest('a') || node?.closest?.('a');
        }
        if (!anchor && richContextRange) {
          const node = richContextRange.commonAncestorContainer;
          anchor = node?.parentElement?.closest('a') || node?.closest?.('a');
        }
        if (!anchor) anchor = target.querySelector('a');
        if (anchor) {
          const textNode = document.createTextNode(anchor.textContent || '');
          anchor.replaceWith(textNode);
        } else {
          document.execCommand('unlink');
        }
        break;
      }
      case 'remove-format':
        clearAllFormatting();
        break;
      case 'insert-article-link':
        applyInsertArticleLink().finally(() => {
          hideContextMenu();
        });
        return;
      case 'split-at-caret':
        await splitEditingBlockAtCaret();
        break;
      default:
        break;
    }
    hideContextMenu();
  };

  menu.addEventListener('click', (event) => {
    const target = event.target.closest('button[data-action]');
    if (!target) return;
    const action = target.dataset.action;
    applyAction(action);
  });

  document.addEventListener('click', (event) => {
    if (menu.classList.contains('hidden')) return;
    if (!menu.contains(event.target)) hideContextMenu();
  });
  document.addEventListener(
    'touchstart',
    (event) => {
      if (menu.classList.contains('hidden')) return;
      if (!menu.contains(event.target)) hideContextMenu();
    },
    { passive: true },
  );
  document.addEventListener('keydown', (event) => {
    if (event.code === 'Escape') hideContextMenu();
  });
  window.addEventListener('scroll', hideContextMenu, true);

  richContextMenu = menu;
  return menu;
}

function showContextMenu(event) {
  const menu = ensureContextMenu();
  menu.classList.remove('hidden');
  menu.style.visibility = 'hidden';
  captureEditableSelectionRange();
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0) {
    richContextRange = sel.getRangeAt(0).cloneRange();
  } else if (lastEditableSelectionRange) {
    richContextRange = lastEditableSelectionRange.cloneRange();
  } else {
    richContextRange = null;
  }
  const rect = menu.getBoundingClientRect();
  const pointerOffset = 22;
  const horizontalPadding = 12;
  let targetX = event.clientX + 14;
  let targetY = event.clientY + pointerOffset;

  if (targetY + rect.height + horizontalPadding > window.innerHeight) {
    targetY = Math.max(horizontalPadding, event.clientY - rect.height - pointerOffset);
  }

  const safeX = Math.min(Math.max(targetX, horizontalPadding), window.innerWidth - rect.width - horizontalPadding);
  const safeY = Math.min(Math.max(targetY, horizontalPadding), window.innerHeight - rect.height - horizontalPadding);
  menu.style.left = `${safeX}px`;
  menu.style.top = `${safeY}px`;
  menu.style.visibility = 'visible';
}

function attachContextMenu(element, blockId, targetOverride) {
  const targetEl = targetOverride || element;
  element.addEventListener('focusin', () => {
    richLastActiveEditable = targetEl;
  });
  element.addEventListener('contextmenu', (event) => {
    if (state.mode !== 'edit' || state.editingBlockId !== blockId) return;
    event.preventDefault();
    richContextTarget = targetEl;
    showContextMenu(event);
  });
  let touchTimer = null;
  element.addEventListener(
    'touchstart',
    (event) => {
      if (state.mode !== 'edit' || state.editingBlockId !== blockId) return;
      if (event.touches.length !== 1) return;
      const touch = event.touches[0];
      touchTimer = window.setTimeout(() => {
        richContextTarget = targetEl;
        showContextMenu({ clientX: touch.clientX, clientY: touch.clientY });
      }, 500);
    },
    { passive: true },
  );
  const clearTouchTimer = () => {
    if (touchTimer !== null) {
      clearTimeout(touchTimer);
      touchTimer = null;
    }
  };
  element.addEventListener('touchend', clearTouchTimer, { passive: true });
  element.addEventListener('touchcancel', clearTouchTimer, { passive: true });
}

export async function ensureBlockVisible(blockId) {
    if (!blockId) return;
    const located = findBlock(blockId);
    if (!located) return;
    const ancestorsToExpand = (located.ancestors || []).filter((ancestor) => ancestor.collapsed);
    for (const ancestor of ancestorsToExpand) {
      // eslint-disable-next-line no-await-in-loop
      await setCollapseState(ancestor.id, false);
    }
  }
