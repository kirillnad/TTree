import { state } from './state.js';
import { apiRequest, uploadImageFile, uploadAttachmentFileWithProgress } from './api.js';
import { showToast } from './toast.js';
import { renderArticle } from './article.js';
import { escapeHtml, insertHtmlAtCaret, logDebug } from './utils.js';
import { showPrompt, showImagePreview, showLinkPrompt } from './modal.js';
import { fetchArticlesIndex } from './api.js';
import { routing } from './routing.js';
import { navigate } from './routing.js';

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
  if (state.mode === 'view') {
    state.scrollTargetBlockId = blockId;
  }
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

  // РЈР±РёСЂР°РµРј РІРѕР·РјРѕР¶РЅС‹Рµ РѕР±РµСЂС‚РєРё .block-header, С‡С‚РѕР±С‹ РєРѕСЂСЂРµРєС‚РЅРѕ РІС‹РґРµР»СЏС‚СЊ Р·Р°РіРѕР»РѕРІРѕРє/С‚РµР»Рѕ
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

export function cleanupEditableHtml(html = '') {
  const template = document.createElement('template');
  template.innerHTML = html || '';

  // СЂР°Р·РІРѕСЂР°С‡РёРІР°РµРј .block-header, СѓР±РёСЂР°РµРј РєР»Р°СЃСЃС‹
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
          // Р·Р°РјРµРЅСЏРµРј div РЅР° p, СЃРѕС…СЂР°РЅСЏСЏ СЃРѕРґРµСЂР¶РёРјРѕРµ
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

  // РћР±РѕСЂР°С‡РёРІР°РµРј РІРµСЂС…РЅРµСѓСЂРѕРІРЅРµРІС‹Рµ С‚РµРєСЃС‚РѕРІС‹Рµ СѓР·Р»С‹ РІ Р°Р±Р·Р°С†С‹
  const wrapTextNodes = (root) => {
    const nodes = Array.from(root.childNodes || []);
    nodes.forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const raw = node.textContent || '';
        const collapsed = raw.replace(/\u00a0/g, ' ');
        const trimmed = collapsed.trim();
        if (!trimmed) {
          // Keep a spacer between inline siblings, otherwise drop
          if (node.previousSibling && node.nextSibling) {
            node.textContent = ' ';
            return;
          }
          root.removeChild(node);
          return;
        }
        const p = document.createElement('p');
        p.textContent = collapsed;
        root.replaceChild(p, node);
      }
    });
  };
  wrapTextNodes(template.content);

  // РїСЂРёРІРѕРґРёРј Рє С‡РёСЃС‚С‹Рј <p>, РіР°СЂР°РЅС‚РёСЂСѓРµРј РїСѓСЃС‚С‹Рµ СЃС‚СЂРѕРєРё РєР°Рє <p><br/></p>
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
      // preserve inner spacers between siblings, but drop stray edges
      if (!(node.previousSibling && node.nextSibling)) {
        if (node.parentNode) node.parentNode.removeChild(node);
        continue;
      }
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

  // РµСЃР»Рё РЅРµС‚ РЅРё РѕРґРЅРѕРіРѕ Р°Р±Р·Р°С†Р° вЂ” РґРѕР±Р°РІР»СЏРµРј РїСѓСЃС‚РѕР№
  if (!template.content.querySelector('p')) {
    const p = document.createElement('p');
    p.appendChild(document.createElement('br'));
    template.content.appendChild(p);
  }

  const cleaned = linkifyHtml(template.innerHTML);
  // Ensure adjacent links remain visually separated after cleanup
  return cleaned.replace(/<\/a>\s*<a/gi, '</a> <a');
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

function trimPastedHtml(html = '') {
  const template = document.createElement('template');
  template.innerHTML = html || '';

  const isEmptyNode = (node) => {
    if (!node) return true;
    if (node.nodeType === Node.TEXT_NODE) {
      return !(node.textContent || '').replace(/\u00a0/g, '').trim();
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return false;
    if (node.tagName === 'BR') return true;
    const content = (node.innerHTML || '').replace(/<br\s*\/?>/gi, '').replace(/&nbsp;/gi, '').trim();
    const text = (node.textContent || '').replace(/\u00a0/g, '').trim();
    const hasMedia = !!node.querySelector('img,video,audio,iframe');
    return !content && !text && !hasMedia;
  };

  while (template.content.firstChild && isEmptyNode(template.content.firstChild)) {
    template.content.removeChild(template.content.firstChild);
  }
  while (template.content.lastChild && isEmptyNode(template.content.lastChild)) {
    template.content.removeChild(template.content.lastChild);
  }

  return template.innerHTML;
}

function clearEmptyPlaceholder(element) {
  if (!element) return;
  const inner = (element.innerHTML || '').replace(/<br\s*\/?>/gi, '').replace(/&nbsp;/gi, '').trim();
  if (!inner) {
    element.innerHTML = '';
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(true);
    const sel = window.getSelection();
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }
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
    showToast('РќРµ РІС‹Р±СЂР°РЅР° СЃС‚Р°С‚СЊСЏ РґР»СЏ Р·Р°РіСЂСѓР·РєРё С„Р°Р№Р»Р°');
    return;
  }
  logDebug('attachment: start upload', { name: file?.name, type: file?.type, size: file?.size, articleId: state.articleId });
  const tempId = `att-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  insertHtmlAtCaret(element, `<span class="attachment-upload" data-temp-id="${tempId}">Р—Р°РіСЂСѓР·РєР° ${escapeHtml(file?.name || '')}вЂ¦</span>`);
  const placeholder = element.querySelector(`.attachment-upload[data-temp-id="${tempId}"]`);
  try {
    const meta = await uploadAttachmentFileWithProgress(state.articleId, file, (percent) => {
      if (placeholder) placeholder.textContent = `Р—Р°РіСЂСѓР·РєР° ${file?.name || ''}вЂ¦ ${percent}%`;
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
      placeholder.textContent = `РћС€РёР±РєР° Р·Р°РіСЂСѓР·РєРё: ${error.message}`;
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
        const trimmed = trimPastedHtml(safeHtml);
        clearEmptyPlaceholder(element);
        insertHtmlAtCaret(element, linkifyHtml(trimmed));
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
        } else {
          const safeTextHtml = escapeHtml(text).replace(/\n/g, '<br />');
          const safeHtml = linkifyHtml(trimPastedHtml(safeTextHtml));
          clearEmptyPlaceholder(element);
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

  element.addEventListener('click', (event) => {
    const img = event.target?.closest('img');
    if (!img) return;
    event.preventDefault();
    showImagePreview(img.src, img.alt || '');
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
    if (event.code === 'PageDown' || event.code === 'PageUp') {
      event.preventDefault();
      const distance = element.clientHeight || 0;
      const delta = event.code === 'PageDown' ? distance : -distance;
      const maxScroll = element.scrollHeight - element.clientHeight;
      if (maxScroll > 0) {
        element.scrollTop = Math.min(Math.max(element.scrollTop + delta, 0), maxScroll);
      }
    }
  });

  element.addEventListener('wheel', (event) => {
    if (state.mode !== 'edit' || state.editingBlockId !== blockId) return;
    // РџСЂРѕРєСЂСѓС‡РёРІР°РµРј С‚РѕР»СЊРєРѕ РІРЅСѓС‚СЂРё Р±Р»РѕРєР°, РЅРµ С†РµРїР»СЏСЏ РєРѕРЅС‚РµР№РЅРµСЂ СЃС‚Р°С‚СЊРё
    const maxScroll = element.scrollHeight - element.clientHeight;
    if (maxScroll <= 0) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const next = Math.min(Math.max(element.scrollTop + event.deltaY, 0), maxScroll);
    element.scrollTop = next;
  });
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

function ensureContextMenu() {
  if (richContextMenu) return richContextMenu;
  const menu = document.createElement('div');
  menu.className = 'rich-context-menu hidden';
  menu.innerHTML = `
    <div class="rich-context-menu__col rich-context-menu__col--buffer">
      <div class="rich-context-menu__label" aria-label="Буфер">Буфер</div>
      <div class="rich-context-menu__grid">
        <button class="rich-context-menu__icon-btn" data-action="copy" aria-label="Копировать" title="Копировать">⧉</button>
        <button class="rich-context-menu__icon-btn" data-action="cut" aria-label="Вырезать" title="Вырезать">✂</button>
        <button class="rich-context-menu__icon-btn" data-action="paste" aria-label="Вставить" title="Вставить">▣</button>
        <button class="rich-context-menu__icon-btn" data-action="select-all" aria-label="Выбрать всё" title="Выбрать всё">⛶</button>
      </div>
    </div>
    <div class="rich-context-menu__col">
      <div class="rich-context-menu__label" aria-label="\u0422\u0435\u043a\u0441\u0442">\u0422\u0435\u043a\u0441\u0442</div>
      <div class="rich-context-menu__grid">
        <button data-action="bold" aria-label="\u041f\u043e\u043b\u0443\u0436\u0438\u0440\u043d\u044b\u0439" title="\u041f\u043e\u043b\u0443\u0436\u0438\u0440\u043d\u044b\u0439"><strong>\u0416</strong></button>
        <button data-action="italic" aria-label="\u041a\u0443\u0440\u0441\u0438\u0432" title="\u041a\u0443\u0440\u0441\u0438\u0432"><em>/</em></button>
        <button data-action="underline" aria-label="\u041f\u043e\u0434\u0447\u0435\u0440\u043a\u043d\u0443\u0442\u044c" title="\u041f\u043e\u0434\u0447\u0435\u0440\u043a\u043d\u0443\u0442\u044c"><u>\u0427</u></button>
        <button data-action="remove-format" aria-label="\u041e\u0447\u0438\u0441\u0442\u0438\u0442\u044c \u0444\u043e\u0440\u043c\u0430\u0442" title="\u041e\u0447\u0438\u0441\u0442\u0438\u0442\u044c \u0444\u043e\u0440\u043c\u0430\u0442">✕</button>
      </div>
    </div>
    <div class="rich-context-menu__col">
      <div class="rich-context-menu__label" aria-label="\u0421\u0442\u0440\u0443\u043a\u0442\u0443\u0440\u0430">\u0421\u0442\u0440\u0443\u043a\u0442\u0443\u0440\u0430</div>
      <div class="rich-context-menu__grid">
        <button data-action="ul" aria-label="\u041c\u0430\u0440\u043a\u0438\u0440\u043e\u0432\u0430\u043d\u043d\u044b\u0439 \u0441\u043f\u0438\u0441\u043e\u043a" title="\u041c\u0430\u0440\u043a\u0438\u0440\u043e\u0432\u0430\u043d\u043d\u044b\u0439 \u0441\u043f\u0438\u0441\u043e\u043a">\u2022</button>
        <button data-action="ol" aria-label="\u041d\u0443\u043c\u0435\u0440\u043e\u0432\u0430\u043d\u043d\u044b\u0439 \u0441\u043f\u0438\u0441\u043e\u043a" title="\u041d\u0443\u043c\u0435\u0440\u043e\u0432\u0430\u043d\u043d\u044b\u0439 \u0441\u043f\u0438\u0441\u043e\u043a">1.</button>
        <button data-action="quote" aria-label="\u0426\u0438\u0442\u0430\u0442\u0430" title="\u0426\u0438\u0442\u0430\u0442\u0430">\u0426\u0438\u0442\u0430\u0442\u0430</button>
        <button data-action="code" aria-label="\u041a\u043e\u0434" title="\u041a\u043e\u0434">&lt;/&gt;</button>
      </div>
    </div>
    <div class="rich-context-menu__col">
      <div class="rich-context-menu__label" aria-label="\u0421\u0441\u044b\u043b\u043a\u0438">\u0421\u0441\u044b\u043b\u043a\u0438</div>
      <div class="rich-context-menu__grid">
        <button data-action="link" aria-label="\u0412\u0441\u0442\u0430\u0432\u0438\u0442\u044c \u0441\u0441\u044b\u043b\u043a\u0443" title="\u0412\u0441\u0442\u0430\u0432\u0438\u0442\u044c \u0441\u0441\u044b\u043b\u043a\u0443">\u0421\u0441\u044b\u043b\u043a\u0430</button>
        <button data-action="unlink" aria-label="\u0423\u0431\u0440\u0430\u0442\u044c \u0441\u0441\u044b\u043b\u043a\u0443" title="\u0423\u0431\u0440\u0430\u0442\u044c \u0441\u0441\u044b\u043b\u043a\u0443">\u0423\u0431\u0440\u0430\u0442\u044c</button>
        <button data-action="insert-article-link" aria-label="\u0421\u0441\u044b\u043b\u043a\u0430 \u043d\u0430 \u0441\u0442\u0430\u0442\u044c\u044e" title="\u0421\u0441\u044b\u043b\u043a\u0430 \u043d\u0430 \u0441\u0442\u0430\u0442\u044c\u044e">\u0421\u0442\u0430\u0442\u044c\u044f</button>
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
  menu.classList.remove('hidden');
  menu.style.visibility = 'hidden';
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0) {
    richContextRange = sel.getRangeAt(0).cloneRange();
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

function attachContextMenu(element, blockId) {
  element.addEventListener('focusin', () => {
    richLastActiveEditable = element;
  });
  element.addEventListener('contextmenu', (event) => {
    if (state.mode !== 'edit' || state.editingBlockId !== blockId) return;
    event.preventDefault();
    richContextTarget = element;
    showContextMenu(event);
  });
  element.addEventListener('click', (event) => {
    if (state.mode !== 'edit' || state.editingBlockId !== blockId) return;
    richContextTarget = element;
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
