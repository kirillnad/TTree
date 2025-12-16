// Вынесено из `block.js`: вставка изображений + ресайз изображений в редакторе.

import { state } from '../state.js';
import { uploadImageFile } from '../api.js?v=2';
import { showToast } from '../toast.js';
import { escapeHtml, insertHtmlAtCaret, logDebug } from '../utils.js';
import { clearEmptyPlaceholder } from './editable.js';

export function isImageLikeFile(file) {
  if (!file) return false;
  if (file.type && file.type.startsWith('image/')) return true;
  const name = (file.name || '').toLowerCase();
  if (!name) return false;
  return /\.(png|jpe?g|gif|webp|bmp|svg|heic|heif)$/i.test(name);
}

export function collectImageFiles(items = [], fallbackFiles = []) {
  const files = [];
  Array.from(items || []).forEach((item) => {
    if (item.kind === 'file') {
      const file = typeof item.getAsFile === 'function' ? item.getAsFile() : null;
      if (file && isImageLikeFile(file)) files.push(file);
    }
  });
  if (!files.length && fallbackFiles?.length) {
    Array.from(fallbackFiles).forEach((file) => {
      if (isImageLikeFile(file)) files.push(file);
    });
  }
  return files;
}

export function collectNonImageFiles(items = [], fallbackFiles = []) {
  const files = [];
  Array.from(items || []).forEach((item) => {
    if (item.kind === 'file') {
      const file = typeof item.getAsFile === 'function' ? item.getAsFile() : null;
      if (file && !isImageLikeFile(file)) files.push(file);
    }
  });
  if (!files.length && fallbackFiles?.length) {
    Array.from(fallbackFiles).forEach((file) => {
      if (!isImageLikeFile(file)) files.push(file);
    });
  }
  return files;
}

export async function insertImageFromFile(element, file, blockId) {
  const token = `img-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const rawName = file && file.name ? file.name : 'image';
  const safeName = escapeHtml(rawName).replace(/"/g, '&quot;');
  // Показываем текстовый плейсхолдер, чтобы было видно, что идёт загрузка.
  try {
    clearEmptyPlaceholder(element);
    insertHtmlAtCaret(
      element,
      `<span data-pending-image="true" data-image-token="${token}">${safeName} (загрузка изображения...)</span>`,
    );
  } catch (_) {
    // Если не получилось вставить плейсхолдер, просто продолжаем без него.
  }
  try {
    const { url } = await uploadImageFile(file);
    const innerImage = `<img src="${url}" alt="${safeName}" draggable="false" />`;
    const finalHtml = `
      <span class="resizable-image" style="width:320px;max-width:100%;">
        <span class="resizable-image__inner">${innerImage}</span>
        <span class="resizable-image__handle" data-direction="e" aria-hidden="true"></span>
      </span>
    `;
    let container = element;
    let placeholder =
      container &&
      container.querySelector(
        `span[data-image-token="${token}"][data-pending-image="true"]`,
      );
    if (blockId && (!placeholder || !container.isConnected)) {
      const blockRoot = document.querySelector(`.block[data-block-id="${blockId}"]`);
      if (blockRoot) {
        const liveEditable = blockRoot.querySelector('.block-text[contenteditable="true"]');
        const liveBody = liveEditable || blockRoot.querySelector('.block-text.block-body');
        if (liveBody) {
          container = liveBody;
          placeholder = container.querySelector(
            `span[data-image-token="${token}"][data-pending-image="true"]`,
          );
        }
      }
    }
    if (placeholder) {
      placeholder.removeAttribute('data-pending-image');
      placeholder.removeAttribute('data-image-token');
      placeholder.outerHTML = finalHtml;
    } else if (container) {
      clearEmptyPlaceholder(container);
      insertHtmlAtCaret(container, finalHtml);
    }
  } catch (error) {
    // Обновляем плейсхолдер сообщением об ошибке, если он ещё в DOM.
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
      if (container) {
        const placeholder = container.querySelector(
          `span[data-image-token="${token}"][data-pending-image="true"]`,
        );
        if (placeholder) {
          placeholder.textContent = `${rawName} (ошибка загрузки изображения)`;
          placeholder.removeAttribute('data-pending-image');
        }
      }
    } catch (_) {
      /* ignore */
    }
    // Дополнительный лог на сервер для диагностики проблем на мобильных устройствах.
    try {
      fetch('/api/client/log', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'insertImageFromFileError',
          data: {
            message: error && error.message ? String(error.message) : String(error),
            name: file && file.name,
            type: file && file.type,
            size: file && file.size,
          },
        }),
      }).catch(() => {});
    } catch (_) {
      // ignore logging errors
    }
    // Параллельно показываем подробный alert на фронтенде,
    // чтобы можно было увидеть причину прямо на мобильном.
    try {
      const debug = {
        where: 'insertImageFromFile',
        message: error && error.message ? String(error.message) : String(error),
        status: typeof error?.status === 'number' ? error.status : null,
        name: file && file.name,
        type: file && file.type,
        size: file && file.size,
      };
      const statusText = debug.status === null ? 'null' : String(debug.status);
      // eslint-disable-next-line no-alert
      window.alert(`upload failed (status ${statusText}):\\n${JSON.stringify(debug, null, 2)}`);
    } catch (_) {
      // ignore logging errors
    }
    const msg = String(error?.message || '').toLowerCase();
    if (msg.includes('status 0') || msg.includes('network error')) {
      showToast(
        'Не удалось загрузить изображение (проблема с соединением). Обновите страницу и, при необходимости, войдите заново.',
      );
    } else {
      showToast(error.message || 'Не удалось загрузить изображение');
    }
  }
}

let resizableImageSession = null;
let resizableImageResizingInitialized = false;

function handleResizableImagePointerDown(event) {
  if (event.button !== 0) return;
  const handle = event.target?.closest('.resizable-image__handle');
  if (!handle) return;
  const wrapper = handle.closest('.resizable-image');
  const block = wrapper?.closest('.block');
  const blockId = block?.dataset?.blockId;
  if (!wrapper || !blockId || state.mode !== 'edit' || state.editingBlockId !== blockId) return;
  event.preventDefault();
  event.stopPropagation();
  const rect = wrapper.getBoundingClientRect();
  resizableImageSession = {
    wrapper,
    startWidth: rect.width,
    startX: event.clientX,
  };
  wrapper.classList.add('resizable-image--resizing');
}

function handleResizableImagePointerMove(event) {
  if (!resizableImageSession) return;
  event.preventDefault();
  const delta = event.clientX - resizableImageSession.startX;
  const rootFontSize = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const minWidth = rootFontSize;
  const viewportMax = Math.max(minWidth, document.documentElement.clientWidth - 32);
  let width = resizableImageSession.startWidth + delta;
  width = Math.max(minWidth, Math.min(width, viewportMax));
  resizableImageSession.wrapper.style.width = `${width}px`;
}

function handleResizableImagePointerEnd() {
  if (!resizableImageSession) return;
  resizableImageSession.wrapper.classList.remove('resizable-image--resizing');
  resizableImageSession = null;
}

export function initResizableImageResizing() {
  if (resizableImageResizingInitialized) return;
  resizableImageResizingInitialized = true;
  document.addEventListener('pointerdown', handleResizableImagePointerDown);
  document.addEventListener('pointermove', handleResizableImagePointerMove);
  document.addEventListener('pointerup', handleResizableImagePointerEnd);
  document.addEventListener('pointercancel', handleResizableImagePointerEnd);
}

