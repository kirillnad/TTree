export function logDebug(...args) {
  // eslint-disable-next-line no-console
  console.log('[debug]', ...args);
}

export function escapeHtml(text = '') {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function htmlToPlainText(html = '') {
  const template = document.createElement('template');
  template.innerHTML = html || '';
  return (template.content.textContent || '').replace(/\s+/g, ' ').trim();
}

export function htmlToLines(html = '') {
  const normalized = (html || '').replace(/<br\s*\/?/gi, '\n').replace(/<\/(?:div|p|li|h[1-6])>/gi, '\n');
  const template = document.createElement('template');
  template.innerHTML = normalized;
  return (template.content.textContent || '').split('\n').map((line) => line.replace(/\s+/g, ' ').trim()).filter((line) => line.length);
}

export function isEditableElement(element) {
  if (!element) return false;
  if (element.isContentEditable) return true;
  const tag = element.tagName ? element.tagName.toLowerCase() : '';
  return tag === 'input' || tag === 'textarea' || tag === 'select';
}

export function placeCaretAtEnd(element) {
  if (!element || !element.isConnected) return;
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

export function textareaToTextContent(html = '') {
  const template = document.createElement('template');
  template.innerHTML = html || '';
  return template.content.textContent || '';
}

export function extractImagesFromHtml(html = '') {
  const template = document.createElement('template');
  template.innerHTML = html || '';
  const nodes = template.content.querySelectorAll('img');
  return Array.from(nodes).map((node) => ({
    src: node.getAttribute('src') || '',
    alt: node.getAttribute('alt') || '',
  }));
}

export function insertHtmlAtCaret(element, html) {
  element.focus();
  const selection = window.getSelection();
  if (!selection) return;
  let range = selection.rangeCount > 0 ? selection.getRangeAt(0) : document.createRange();
  if (!element.contains(range.commonAncestorContainer)) {
    range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
  }
  selection.removeAllRanges();
  selection.addRange(range);
  const fragment = range.createContextualFragment(html);
  range.deleteContents();
  range.insertNode(fragment);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}
