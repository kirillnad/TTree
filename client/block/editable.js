// Вынесено из `block.js`: утилиты для contenteditable (плейсхолдеры и т.п.).

export function clearEmptyPlaceholder(element) {
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

