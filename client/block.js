import { state } from './state.js';
import { apiRequest, uploadImageFile, uploadAttachmentFileWithProgress } from './api.js';
import { showToast } from './toast.js';
import { renderArticle } from './article.js';
import { escapeHtml, insertHtmlAtCaret, logDebug } from './utils.js';

export function flattenVisible(blocks = [], acc = []) {
  blocks.forEach((block) => {
    acc.push(block);
    if (!block.collapsed && block.children?.length) {
      flattenVisible(block.children, acc);
    }
  });
  return acc;
}

export function findBlock(blockId, blocks = state.article?.blocks || [], parent = null, ancestors = []) {
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    if (block.id === blockId) {
      return { block, parent, index: i, siblings: blocks, ancestors };
    }
    const nested = findBlock(blockId, block.children || [], block, [...ancestors, block]);
    if (nested) {
      return nested;
    }
  }
  return null;
}

export function setCurrentBlock(blockId) {
  if (!blockId || state.currentBlockId === blockId) return;
  state.currentBlockId = blockId;
  renderArticle();
}

export function moveSelection(offset) {
  if (!state.article) return;
  const ordered = flattenVisible(state.article.blocks);
  const index = ordered.findIndex((b) => b.id === state.currentBlockId);
  if (index === -1) return;
  const next = ordered[index + offset];
  if (next) {
    setCurrentBlock(next.id);
  }
}

export function isSeparatorNode(node) {
  if (!node) return false;
  if (node.nodeType === Node.TEXT_NODE) return /\n\s*\n/.test(node.textContent || '');
  if (node.nodeType === Node.ELEMENT_NODE) {
    if (node.tagName === 'BR') return true;
    if (node.tagName === 'P' || node.tagName === 'DIV') {
      const normalizedHtml = (node.innerHTML || '').replace(/<br\s*\/?>/gi, '').replace(/&(nbsp|#160);/gi, '').trim();
      if (!normalizedHtml) return true;
      const textContent = (node.textContent || '').replace(/\u00a0/g, '').trim();
      if (!textContent && !node.querySelector('img')) return true;
    }
  }
  return false;
}

function serializeNodes(nodes = []) {
  const wrapper = document.createElement('div');
  nodes.forEach((node) => wrapper.appendChild(node));
  return wrapper.innerHTML.trim();
}

function normalizeToParagraphs(html = '') {
  const template = document.createElement('template');
  template.innerHTML = html || '';
  const paragraphs = [];
  const pushParagraph = (contentHtml = '') => {
    const p = document.createElement('p');
    if (contentHtml) {
      p.innerHTML = contentHtml;
    } else {
      p.appendChild(document.createElement('br'));
    }
    paragraphs.push(p);
  };

  Array.from(template.content.childNodes).forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.textContent || '').trim();
      if (text) pushParagraph(text);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (node.tagName === 'P') {
      paragraphs.push(node.cloneNode(true));
      return;
    }
    if (node.tagName === 'BR') {
      pushParagraph('');
      return;
    }
    if (node.tagName === 'DIV') {
      pushParagraph(node.innerHTML);
      return;
    }
    // Any other element: wrap inside paragraph
    pushParagraph(node.outerHTML);
  });

  if (!paragraphs.length) pushParagraph('');
  const out = document.createElement('div');
  paragraphs.forEach((p) => out.appendChild(p));
  return out.innerHTML;
}

export function extractBlockSections(html = '') {
  const template = document.createElement('template');
  template.innerHTML = html || '';

  // Убираем возможные обертки .block-header, чтобы корректно выделять заголовок/тело
  template.content.querySelectorAll('.block-header').forEach((node) => {
    const parent = node.parentNode;
    if (!parent) return;
    while (node.firstChild) {
      parent.insertBefore(node.firstChild, node);
    }
    parent.removeChild(node);
  });

  const nodes = Array.from(template.content.childNodes);
  const titleNodes = [];
  const bodyNodes = [];
  let separatorFound = false;
  nodes.forEach((node) => {
    if (!separatorFound && isSeparatorNode(node)) {
      separatorFound = true;
      return;
    }
    if (!separatorFound) titleNodes.push(node.cloneNode(true));
    else bodyNodes.push(node.cloneNode(true));
  });

  if (!separatorFound) return { titleHtml: '', bodyHtml: serializeNodes(nodes) };
  return { titleHtml: serializeNodes(titleNodes), bodyHtml: serializeNodes(bodyNodes) };
}

export function buildEditableBlockHtml(html = '') {
  const sections = extractBlockSections(html);
  if (!sections.titleHtml) return html || '';
  const titleContent = normalizeToParagraphs(sections.titleHtml);
  const bodyContent = normalizeToParagraphs(sections.bodyHtml || '');
  return `${titleContent}<p><br /></p>${bodyContent}`;
}

export function buildStoredBlockHtml(html = '') {
  const template = document.createElement('template');
  template.innerHTML = html || '';
  // Убираем вложенные block-header, оставляя только контент
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

export function cleanupEditableHtml(html = '') {
  const template = document.createElement('template');
  template.innerHTML = html || '';

  // разворачиваем .block-header, убираем классы
  template.content.querySelectorAll('.block-header').forEach((node) => {
    const parent = node.parentNode;
    if (!parent) return;
    while (node.firstChild) parent.insertBefore(node.firstChild, node);
    parent.removeChild(node);
  });

  const convertDivsToParagraphs = (root) => {
    Array.from(root.childNodes).forEach((node) => {
      if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.tagName === 'DIV') {
          // заменяем div на p, сохраняя содержимое
          const p = document.createElement('p');
          p.innerHTML = node.innerHTML;
          node.parentNode.replaceChild(p, node);
          convertDivsToParagraphs(p);
          return;
        }
        convertDivsToParagraphs(node);
      }
    });
  };

  convertDivsToParagraphs(template.content);

  // Оборачиваем верхнеуровневые текстовые узлы в абзацы
  const wrapTextNodes = (root) => {
    const nodes = Array.from(root.childNodes || []);
    nodes.forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = (node.textContent || '').trim();
        if (!text) {
          root.removeChild(node);
          return;
        }
        const p = document.createElement('p');
        p.textContent = text;
        root.replaceChild(p, node);
      }
    });
  };
  wrapTextNodes(template.content);

  // приводим к чистым <p>, гарантируем пустые строки как <p><br/></p>
  template.content.querySelectorAll('p').forEach((p) => {
    const inner = (p.innerHTML || '').replace(/&nbsp;/g, '').trim();
    if (!inner || inner === '<br>' || inner === '<br/>') {
      p.innerHTML = '';
      p.appendChild(document.createElement('br'));
    }
  });

  // remove trailing empty paragraphs
  const nodes = Array.from(template.content.childNodes || []);
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const node = nodes[i];
    if (node.nodeType === Node.TEXT_NODE && !(node.textContent || '').trim()) {
      if (node.parentNode) node.parentNode.removeChild(node);
      continue;
    }
    if (node.tagName === 'P') {
      const inner = (node.innerHTML || '').replace(/&nbsp;/g, '').replace(/<br\s*\/?>/gi, '').trim();
      if (!inner) {
        if (node.parentNode) node.parentNode.removeChild(node);
        continue;
      }
    }
    break;
  }

  // если нет ни одного абзаца — добавляем пустой
  if (!template.content.querySelector('p')) {
    const p = document.createElement('p');
    p.appendChild(document.createElement('br'));
    template.content.appendChild(p);
  }

  return linkifyHtml(template.innerHTML);
}

export async function toggleCollapse(blockId) {
  const located = findBlock(blockId);
  if (!located) return;
  setCollapseState(blockId, !located.block.collapsed);
}

export async function setCollapseState(blockId, collapsed) {
  const located = findBlock(blockId);
  if (!located || located.block.collapsed === collapsed) return;

  located.block.collapsed = collapsed;
  renderArticle(); // Optimistic update

  try {
    const response = await apiRequest(`/api/articles/${state.articleId}/collapse`, {
      method: 'PATCH',
      body: JSON.stringify({ blockId, collapsed }),
    });
    if (response?.updatedAt) {
      state.article.updatedAt = response.updatedAt;
      renderArticle();
    }
  } catch (error) {
    located.block.collapsed = !collapsed; // Revert on error
    renderArticle();
    showToast(error.message);
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

const URL_REGEX = /((?:https?:\/\/|www\.)[^\s<>"']+)/gi;
function linkifyHtml(html = '') {
  const template = document.createElement('template');
  template.innerHTML = html || '';

  const linkifyNode = (node) => {
    if (!node) return;
    if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'A') {
      return; // skip existing links
    }
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent || '';
      URL_REGEX.lastIndex = 0;
      const hasMatch = URL_REGEX.test(text);
      if (!hasMatch) return;

      const fragment = document.createDocumentFragment();
      let lastIndex = 0;
      URL_REGEX.lastIndex = 0;
      let current;
      while ((current = URL_REGEX.exec(text)) !== null) {
        const [url] = current;
        if (current.index > lastIndex) {
          fragment.appendChild(document.createTextNode(text.slice(lastIndex, current.index)));
        }
        const href = url.startsWith('http') ? url : `https://${url}`;
        const anchor = document.createElement('a');
        anchor.href = href;
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
        anchor.textContent = url;
        fragment.appendChild(anchor);
        lastIndex = current.index + url.length;
      }
      if (lastIndex < text.length) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
      }
      if (node.parentNode) {
        node.parentNode.replaceChild(fragment, node);
      }
      return;
    }
    Array.from(node.childNodes || []).forEach(linkifyNode);
  };

  Array.from(template.content.childNodes).forEach(linkifyNode);
  return template.innerHTML;
}

function sanitizePastedHtml(html = '') {
  const template = document.createElement('template');
  template.innerHTML = html || '';

  // Remove scripts/styles entirely
  template.content.querySelectorAll('script, style').forEach((node) => node.remove());

  const isUnsafeUrl = (value = '') => /^javascript:/i.test(value.trim());

  const cleanNode = (node) => {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) {
      Array.from(node?.childNodes || []).forEach(cleanNode);
      return;
    }

    Array.from(node.attributes || []).forEach((attr) => {
      const name = attr.name.toLowerCase();
      const value = attr.value || '';
      if (name.startsWith('on') || name === 'style') {
        node.removeAttribute(attr.name);
        return;
      }
      if ((name === 'href' || name === 'src') && isUnsafeUrl(value)) {
        node.removeAttribute(attr.name);
      }
    });

    Array.from(node.childNodes || []).forEach(cleanNode);
  };

  Array.from(template.content.childNodes || []).forEach(cleanNode);
  return template.innerHTML;
}

function collectImageFiles(items = [], fallbackFiles = []) {
  const files = [];
  Array.from(items || []).forEach((item) => {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = typeof item.getAsFile === 'function' ? item.getAsFile() : null;
      if (file) files.push(file);
    }
  });
  if (!files.length && fallbackFiles?.length) {
    Array.from(fallbackFiles).forEach((file) => {
      if (file.type.startsWith('image/')) files.push(file);
    });
  }
  return files;
}

function collectNonImageFiles(items = [], fallbackFiles = []) {
  const files = [];
  Array.from(items || []).forEach((item) => {
    if (item.kind === 'file' && (!item.type || !item.type.startsWith('image/'))) {
      const file = typeof item.getAsFile === 'function' ? item.getAsFile() : null;
      if (file) files.push(file);
    }
  });
  if (!files.length && fallbackFiles?.length) {
    Array.from(fallbackFiles).forEach((file) => {
      if (!file.type || !file.type.startsWith('image/')) files.push(file);
    });
  }
  return files;
}

async function insertImageFromFile(element, file) {
  try {
    const { url } = await uploadImageFile(file);
    const safeName = (file.name || 'image').replace(/"/g, '&quot;');
    insertHtmlAtCaret(element, `<img src="${url}" alt="${safeName}" draggable="false" />`);
  } catch (error) {
    showToast(error.message);
  }
}

async function insertAttachmentFromFile(element, file) {
  if (!state.articleId) {
    showToast('Не выбрана статья для загрузки файла');
    return;
  }
  logDebug('attachment: start upload', { name: file?.name, type: file?.type, size: file?.size, articleId: state.articleId });
  const tempId = `att-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  insertHtmlAtCaret(element, `<span class="attachment-upload" data-temp-id="${tempId}">Загрузка ${escapeHtml(file?.name || '')}…</span>`);
  const placeholder = element.querySelector(`.attachment-upload[data-temp-id="${tempId}"]`);
  try {
    const meta = await uploadAttachmentFileWithProgress(state.articleId, file, (percent) => {
      if (placeholder) placeholder.textContent = `Загрузка ${file?.name || ''}… ${percent}%`;
    });
    logDebug('attachment: uploaded', meta);
    const safeUrl = escapeHtml(meta?.url || meta?.storedPath || '');
    const safeName = escapeHtml(meta?.originalName || file.name || 'file');
    const linkHtml = `<a href="${safeUrl}" class="attachment-link" target="_blank" rel="noopener noreferrer" download="${safeName}">${safeName}</a>`;
    if (placeholder) {
      placeholder.outerHTML = linkHtml;
    } else {
      insertHtmlAtCaret(element, linkHtml);
    }
    logDebug('attachment: inserted into DOM', {
      html: element.innerHTML.slice(0, 200),
    });
  } catch (error) {
    logDebug('attachment: upload failed', error);
    if (placeholder) {
      placeholder.textContent = `Ошибка загрузки: ${error.message}`;
      placeholder.classList.add('attachment-upload--error');
    }
    showToast(error.message);
  }
}

export function attachRichContentHandlers(element, blockId) {
  attachContextMenu(element, blockId);
  element.addEventListener('paste', (event) => {
    if (state.mode !== 'edit' || state.editingBlockId !== blockId) return;
    const imageFiles = collectImageFiles(event.clipboardData?.items);
    const otherFiles = collectNonImageFiles(event.clipboardData?.items);
    if (imageFiles.length > 0) {
      event.preventDefault();
      imageFiles.forEach((file) => insertImageFromFile(element, file));
    } else if (otherFiles.length > 0) {
      event.preventDefault();
      logDebug('paste: non-image files detected', otherFiles.map((f) => ({ name: f.name, type: f.type, size: f.size })));
      otherFiles.forEach((file) => insertAttachmentFromFile(element, file));
    } else {
      const htmlData = (event.clipboardData?.getData('text/html') || '').trim();
      event.preventDefault();

      if (htmlData) {
        const safeHtml = sanitizePastedHtml(htmlData);
        insertHtmlAtCaret(element, linkifyHtml(safeHtml));
      } else {
        const text = event.clipboardData?.getData('text/plain') || '';
        const trimmed = text.trim();
        const isLikelyUrl = /^https?:\/\/\S+$/i.test(trimmed);
        if (isLikelyUrl) {
          const safeUrl = escapeHtml(trimmed);
          insertHtmlAtCaret(
            element,
            `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeUrl}</a>`,
          );
        } else {
          const safeTextHtml = escapeHtml(text).replace(/\n/g, '<br />');
          const safeHtml = linkifyHtml(safeTextHtml);
          insertHtmlAtCaret(element, safeHtml);
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
    imageFiles.forEach((file) => insertImageFromFile(element, file));
    otherFiles.forEach((file) => insertAttachmentFromFile(element, file));
  });

  element.addEventListener('dragover', (event) => {
    if (state.mode !== 'edit' || state.editingBlockId !== blockId) return;
    const hasFiles =
      collectImageFiles(event.dataTransfer?.items).length > 0 ||
      collectNonImageFiles(event.dataTransfer?.items).length > 0;
    if (hasFiles) {
      event.preventDefault();
    }
  });
}

let richContextMenu = null;
let richContextRange = null;

function ensureContextMenu() {
  if (richContextMenu) return richContextMenu;
  const menu = document.createElement('div');
  menu.className = 'rich-context-menu hidden';
  menu.innerHTML = `
    <button data-action="bold"><strong>B</strong></button>
    <button data-action="italic"><em>I</em></button>
    <button data-action="underline"><u>U</u></button>
    <span class="divider"></span>
    <button data-action="ul">• Список</button>
    <button data-action="ol">1. Список</button>
    <button data-action="quote">Цитата</button>
    <button data-action="code">Код</button>
    <span class="divider"></span>
    <button data-action="link">Ссылка</button>
    <button data-action="unlink">Убрать ссылку</button>
    <button data-action="remove-format">Очистить</button>
  `;
  document.body.appendChild(menu);

  const hideContextMenu = () => {
    menu.classList.add('hidden');
    richContextRange = null;
  };

  const restoreSelection = () => {
    if (richContextRange) {
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(richContextRange);
    }
  };

  const applyAction = (action) => {
    restoreSelection();
    switch (action) {
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
        document.execCommand('insertUnorderedList');
        break;
      case 'ol':
        document.execCommand('insertOrderedList');
        break;
      case 'quote':
        document.execCommand('formatBlock', false, 'blockquote');
        break;
      case 'code':
        document.execCommand('formatBlock', false, 'pre');
        break;
      case 'link': {
        const sel = window.getSelection();
        const focusNode = sel.anchorNode;
        const anchor = focusNode ? focusNode.parentElement?.closest('a') : null;
        const currentHref = anchor?.getAttribute('href') || '';
        const url = window.prompt('Ссылка', currentHref);
        if (!url) break;
        const safeUrl = url.match(/^[a-z]+:/i) ? url : `https://${url}`;
        document.execCommand('createLink', false, safeUrl);
        const newAnchor = sel.anchorNode?.parentElement?.closest('a');
        if (newAnchor) {
          newAnchor.setAttribute('target', '_blank');
          newAnchor.setAttribute('rel', 'noopener noreferrer');
        }
        break;
      }
      case 'unlink':
        document.execCommand('unlink');
        break;
      case 'remove-format':
        document.execCommand('removeFormat');
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
  document.addEventListener('keydown', (event) => {
    if (event.code === 'Escape') hideContextMenu();
  });
  window.addEventListener('scroll', hideContextMenu, true);

  richContextMenu = menu;
  return menu;
}

function showContextMenu(event) {
  const menu = ensureContextMenu();
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0) {
    richContextRange = sel.getRangeAt(0).cloneRange();
  } else {
    richContextRange = null;
  }
  const rect = menu.getBoundingClientRect();
  const safeX = Math.min(event.clientX, window.innerWidth - rect.width - 10);
  const safeY = Math.min(event.clientY, window.innerHeight - rect.height - 10);
  menu.style.left = `${safeX}px`;
  menu.style.top = `${safeY}px`;
  menu.classList.remove('hidden');
}

function attachContextMenu(element, blockId) {
  element.addEventListener('contextmenu', (event) => {
    if (state.mode !== 'edit' || state.editingBlockId !== blockId) return;
    event.preventDefault();
    showContextMenu(event);
  });
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
