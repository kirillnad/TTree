// Вынесено из `block.js`: преобразование абзацев <p> в списки <ol>/<ul> в редакторе.

export function applyListAction({
  listTag,
  resolveTarget,
  restoreSelection,
  richContextRange,
  notifyEditingInput,
  setRichContextRange,
}) {
  const target = resolveTarget();
  if (!target || !document.contains(target)) return;
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

  const anchorElement =
    range.startContainer?.nodeType === Node.ELEMENT_NODE ? range.startContainer : range.startContainer?.parentElement;
  const insideLi = anchorElement?.closest?.('li');
  const existingList = insideLi?.closest?.('ol,ul');

  const setCaretToEnd = (node) => {
    if (!node) return;
    const caret = document.createRange();
    caret.selectNodeContents(node);
    caret.collapse(false);
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(caret);
    }
    setRichContextRange(caret);
    try {
      target.focus({ preventScroll: true });
    } catch {
      target.focus();
    }
    target.classList.remove('block-body--empty');
    notifyEditingInput(target);
  };

  const unwrapListToParagraphs = (listEl) => {
    const host =
      listEl.parentElement?.tagName === 'P' && listEl.parentElement.childNodes.length === 1
        ? listEl.parentElement
        : listEl;
    const items = Array.from(listEl.children || []).filter(
      (child) => child.nodeType === Node.ELEMENT_NODE && child.tagName === 'LI',
    );
    const frag = document.createDocumentFragment();
    const paragraphs = [];
    items.forEach((li) => {
      const p = document.createElement('p');
      while (li.firstChild) p.appendChild(li.firstChild);
      paragraphs.push(p);
      frag.appendChild(p);
    });
    host.replaceWith(frag);
    setCaretToEnd(paragraphs[0] || null);
  };

  if (existingList) {
    const existingTag = existingList.tagName.toLowerCase();
    if (existingTag === listTag) {
      unwrapListToParagraphs(existingList);
      return;
    }
    const converted = document.createElement(listTag);
    while (existingList.firstChild) converted.appendChild(existingList.firstChild);
    existingList.replaceWith(converted);
    setCaretToEnd(insideLi || converted.lastElementChild || converted);
    return;
  }

  // Иначе превращаем выбранные <p> в элементы списка. Важно: только <p>,
  // чтобы вспомогательные <span> (обёртки/ручки/картинки) не становились <li>.
  const findParagraphAtCollapsedCaret = () => {
    if (!range.collapsed) return null;
    let p = anchorElement?.closest?.('p') || null;
    if (p && target.contains(p)) return p;
    if (range.startContainer === target) {
      const nodes = Array.from(target.childNodes);
      const idx = range.startOffset;
      for (let i = idx - 1; i >= 0; i -= 1) {
        const n = nodes[i];
        if (n?.nodeType === Node.ELEMENT_NODE && n.tagName === 'P') return n;
      }
      for (let i = idx; i < nodes.length; i += 1) {
        const n = nodes[i];
        if (n?.nodeType === Node.ELEMENT_NODE && n.tagName === 'P') return n;
      }
    }
    return null;
  };

  let paragraphs = [];
  if (range.collapsed) {
    const p = findParagraphAtCollapsedCaret();
    if (p) paragraphs = [p];
  } else {
    const directParagraphs = Array.from(target.querySelectorAll(':scope > p'));
    paragraphs = directParagraphs.filter((p) => {
      try {
        return range.intersectsNode(p);
      } catch {
        return false;
      }
    });
    if (!paragraphs.length) {
      const fallback = anchorElement?.closest?.('p');
      if (fallback && target.contains(fallback)) paragraphs = [fallback];
    }
  }
  if (!paragraphs.length) return;

  const listEl = document.createElement(listTag);
  paragraphs.forEach((p) => {
    const li = document.createElement('li');
    while (p.firstChild) li.appendChild(p.firstChild);
    listEl.appendChild(li);
  });
  const first = paragraphs[0];
  first.replaceWith(listEl);
  paragraphs.slice(1).forEach((p) => p.remove());
  setCaretToEnd(listEl.firstElementChild || listEl);
}

