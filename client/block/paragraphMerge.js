// Вынесено из `TTree/client/block.js`:
// - определение "пустой строки" (разделителя) внутри rich text,
// - выделение заголовка/тела блока через первый <p> + пустая строка,
// - склейка абзацев <p> по Backspace/Delete в contenteditable.
//
// Цель: чтобы текст внутри contenteditable вёл себя как текстовый редактор,
// без "сакральности" отдельных <p>, и при этом поддерживались span-обёртки
// (включая resizable-image) без дробления.

export function isSeparatorNode(node) {
  if (!node) return false;
  if (node.nodeType === Node.TEXT_NODE) return /\n\s*\n/.test(node.textContent || '');
  if (node.nodeType === Node.ELEMENT_NODE) {
    if (node.tagName === 'BR') return true;
    if (node.tagName === 'P' || node.tagName === 'DIV') {
      const normalizedHtml = (node.innerHTML || '')
        .replace(/<br\s*\/?>/gi, '')
        .replace(/&(nbsp|#160);/gi, '')
        .trim();
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

export function normalizeToParagraphs(html = '') {
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

  // Убираем возможные обёртки .block-header, чтобы корректно выделять заголовок/тело.
  template.content.querySelectorAll('.block-header').forEach((node) => {
    const parent = node.parentNode;
    if (!parent) return;
    while (node.firstChild) {
      parent.insertBefore(node.firstChild, node);
    }
    parent.removeChild(node);
  });

  const nodes = Array.from(template.content.childNodes);
  const isIgnorableWhitespaceText = (node) => node?.nodeType === Node.TEXT_NODE && !(node.textContent || '').trim();

  // Новый принцип заголовка:
  // заголовок — это только первый <p>, но только если СРАЗУ после него идёт
  // пустая строка (разделитель), иначе заголовка нет вообще.
  let firstIdx = 0;
  while (firstIdx < nodes.length && isIgnorableWhitespaceText(nodes[firstIdx])) firstIdx += 1;
  const first = nodes[firstIdx];
  if (!first || first.nodeType !== Node.ELEMENT_NODE || first.tagName !== 'P' || isSeparatorNode(first)) {
    return { titleHtml: '', bodyHtml: serializeNodes(nodes) };
  }

  let secondIdx = firstIdx + 1;
  while (secondIdx < nodes.length && isIgnorableWhitespaceText(nodes[secondIdx])) secondIdx += 1;
  const second = nodes[secondIdx];
  const isImmediateEmptyLine =
    Boolean(second) &&
    isSeparatorNode(second) &&
    (second.nodeType === Node.ELEMENT_NODE
      ? second.tagName === 'P' || second.tagName === 'DIV' || second.tagName === 'BR'
      : false);

  if (!isImmediateEmptyLine) {
    // Если пустая строка встречается после 2+ абзацев — это не заголовок.
    return { titleHtml: '', bodyHtml: serializeNodes(nodes) };
  }

  const titleNodes = [first.cloneNode(true)];
  const bodyNodes = [];
  for (let i = secondIdx + 1; i < nodes.length; i += 1) {
    bodyNodes.push(nodes[i].cloneNode(true));
  }
  return { titleHtml: serializeNodes(titleNodes), bodyHtml: serializeNodes(bodyNodes) };
}

export function maybeHandleParagraphMergeKeydown({
  event,
  element,
  range,
  selection,
  notifyEditingInput,
  logDebug,
}) {
  if (!event || !element || !range || !selection) return false;
  if (!range.collapsed) return false;

  // Склейка <p> как «текст»:
  // - Backspace в начале абзаца склеивает с предыдущим
  // - Delete в конце абзаца склеивает со следующим
  const isBackspaceKey = event.key === 'Backspace' || event.code === 'Backspace' || event.keyCode === 8;
  const isDeleteKey =
    event.key === 'Delete' ||
    event.key === 'Del' ||
    event.code === 'Delete' ||
    event.code === 'Del' ||
    event.keyCode === 46;

  if (!isBackspaceKey && !isDeleteKey) return false;

  const focusRange = (r) => {
    try {
      selection.removeAllRanges();
      selection.addRange(r);
    } catch (_) {
      // ignore
    }
    try {
      element.focus({ preventScroll: true });
    } catch {
      element.focus();
    }
  };

  const resolveParagraphAtCaret = (key) => {
    const raw =
      range.commonAncestorContainer?.nodeType === Node.ELEMENT_NODE
        ? range.commonAncestorContainer
        : range.commonAncestorContainer?.parentElement;
    const direct = raw?.closest?.('p');
    if (direct) return direct;

    const root = element;
    const childNodes = Array.from(root.childNodes);
    let topChild = range.startContainer;
    while (topChild && topChild.parentNode !== root) {
      topChild = topChild.parentNode;
    }
    const startIndex = topChild ? childNodes.indexOf(topChild) : -1;

    const search = (direction) => {
      const step = direction === 'prev' ? -1 : 1;
      let idx = startIndex;
      if (idx === -1) {
        idx = direction === 'prev' ? childNodes.length - 1 : 0;
      } else {
        idx = direction === 'prev' ? idx - 1 : idx;
      }
      while (idx >= 0 && idx < childNodes.length) {
        const candidate = childNodes[idx];
        if (candidate?.nodeType === Node.ELEMENT_NODE && candidate.tagName === 'P') {
          return candidate;
        }
        idx += step;
      }
      return null;
    };

    if (key === 'Delete') {
      return search('next') || search('prev');
    }
    if (key === 'Backspace') {
      return search('prev') || search('next');
    }
    return null;
  };

  const findParagraphsAroundBoundary = () => {
    if (range.startContainer !== element) return { prev: null, next: null };
    const nodes = Array.from(element.childNodes);
    const idx = range.startOffset;
    let prev = null;
    let next = null;
    for (let i = idx - 1; i >= 0; i -= 1) {
      const candidate = nodes[i];
      if (candidate?.nodeType === Node.ELEMENT_NODE && candidate.tagName === 'P') {
        prev = candidate;
        break;
      }
    }
    for (let i = idx; i < nodes.length; i += 1) {
      const candidate = nodes[i];
      if (candidate?.nodeType === Node.ELEMENT_NODE && candidate.tagName === 'P') {
        next = candidate;
        break;
      }
    }
    return { prev, next };
  };

  const findPrevParagraph = (p) => {
    let cur = p?.previousElementSibling;
    while (cur && cur.tagName !== 'P') cur = cur.previousElementSibling;
    return cur && cur.tagName === 'P' ? cur : null;
  };

  const findNextParagraph = (p) => {
    let cur = p?.nextElementSibling;
    while (cur && cur.tagName !== 'P') cur = cur.nextElementSibling;
    return cur && cur.tagName === 'P' ? cur : null;
  };

  const isEmptyFragment = (frag) => {
    if (!frag) return true;
    const transparentTags = new Set(['span', 'b', 'strong', 'i', 'em', 'u', 's', 'mark', 'code']);
    const mediaTags = new Set(['img', 'video', 'audio', 'iframe']);
    const hasMeaningful = (node) => {
      if (!node) return false;
      if (node.nodeType === Node.TEXT_NODE) {
        const text = (node.textContent || '').replace(/\u00a0/g, '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
        return text.length > 0;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return false;
      const tag = (node.tagName || '').toLowerCase();
      if (tag === 'br') return false;
      if (mediaTags.has(tag)) return true;
      if (tag === 'span') {
        const cls = node.getAttribute('class') || '';
        if (cls.includes('resizable-image__handle')) return false;
      }
      if (transparentTags.has(tag)) {
        return Array.from(node.childNodes || []).some(hasMeaningful);
      }
      // любой другой элемент считаем содержимым
      return true;
    };
    return !Array.from(frag.childNodes || []).some(hasMeaningful);
  };

  const isCaretAtStartOfP = (p) => {
    if (!p) return false;
    const pre = document.createRange();
    pre.selectNodeContents(p);
    try {
      pre.setEnd(range.startContainer, range.startOffset);
    } catch (_) {
      return false;
    }
    if (isEmptyFragment(pre.cloneContents())) return true;
    try {
      const start = document.createRange();
      start.selectNodeContents(p);
      start.collapse(true);
      return range.compareBoundaryPoints(Range.START_TO_START, start) === 0;
    } catch (_) {
      return false;
    }
  };

  const isCaretAtEndOfP = (p) => {
    if (!p) return false;
    const post = document.createRange();
    post.selectNodeContents(p);
    try {
      post.setStart(range.startContainer, range.startOffset);
    } catch (_) {
      return false;
    }
    if (isEmptyFragment(post.cloneContents())) return true;
    try {
      const end = document.createRange();
      end.selectNodeContents(p);
      end.collapse(false);
      return range.compareBoundaryPoints(Range.END_TO_END, end) === 0;
    } catch (_) {
      return false;
    }
  };

  if (window.__debugMergeP) {
    logDebug('mergeP.keydown', {
      key: event.key,
      code: event.code,
      keyCode: event.keyCode,
      startContainer: range.startContainer?.nodeName,
      startOffset: range.startOffset,
      collapsed: range.collapsed,
    });
  }

  if (isBackspaceKey) {
    if (range.startContainer === element) {
      const boundary = findParagraphsAroundBoundary();
      if (boundary.prev && boundary.next) {
        event.preventDefault();
        event.stopPropagation();
        const caret = document.createRange();
        caret.selectNodeContents(boundary.prev);
        caret.collapse(false);
        while (boundary.next.firstChild) boundary.prev.appendChild(boundary.next.firstChild);
        boundary.next.remove();
        focusRange(caret);
        notifyEditingInput(element);
        return true;
      }
      return false;
    }
    const p = resolveParagraphAtCaret('Backspace');
    if (!p || !element.contains(p)) return false;
    if (!isCaretAtStartOfP(p)) return false;
    const prev = findPrevParagraph(p);
    if (!prev || !element.contains(prev)) return false;

    event.preventDefault();
    event.stopPropagation();

    const caret = document.createRange();
    caret.selectNodeContents(prev);
    caret.collapse(false);

    while (p.firstChild) prev.appendChild(p.firstChild);
    p.remove();

    focusRange(caret);
    notifyEditingInput(element);
    return true;
  }

  if (isDeleteKey) {
    let p = resolveParagraphAtCaret('Delete');
    if (!p || !element.contains(p)) {
      const boundary = findParagraphsAroundBoundary();
      if (boundary.prev && boundary.next) {
        event.preventDefault();
        event.stopPropagation();
        const caret = document.createRange();
        caret.selectNodeContents(boundary.prev);
        caret.collapse(false);
        while (boundary.next.firstChild) boundary.prev.appendChild(boundary.next.firstChild);
        boundary.next.remove();
        focusRange(caret);
        notifyEditingInput(element);
        return true;
      }
      return false;
    }
    if (!isCaretAtEndOfP(p)) return false;
    const next = findNextParagraph(p);
    if (!next || !element.contains(next)) return false;

    event.preventDefault();
    event.stopPropagation();

    const caret = document.createRange();
    caret.selectNodeContents(p);
    caret.collapse(false);

    while (next.firstChild) p.appendChild(next.firstChild);
    next.remove();

    focusRange(caret);
    notifyEditingInput(element);
    return true;
  }

  return false;
}

