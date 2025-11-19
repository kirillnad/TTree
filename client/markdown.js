import { escapeHtml, escapeRegExp } from './utils.js';
import { buildStoredBlockHtml } from './block.js';

const MARKDOWN_BLOCK_INDENT = 2;
const BLOCK_SECTION_MAP = {
  '\u043d\u0430\u0438\u043c\u0435\u043d\u043e\u0432\u0430\u043d\u0438\u0435': 'title',
  '\u043d\u0430\u0437\u0432\u0430\u043d\u0438\u0435': 'title',
  '\u0441\u043e\u0434\u0435\u0440\u0436\u0438\u043c\u043e\u0435': 'content',
  '\u0442\u0435\u043a\u0441\u0442': 'content',
  '\u043a\u043e\u043c\u043c\u0435\u043d\u0442\u0430\u0440\u0438\u0438': 'comments',
  '\u0430\u0442\u0440\u0438\u0431\u0443\u0442\u044b': 'attributes',
};

export function looksLikeMarkdownBlocks(text = '') {
  return text.split(/\r?\n/).some((line) => /^(\s*)-\s+/.test(line));
}

function transformInlinePlaceholders(text = '') {
  if (!text) return '';
  const placeholders = [];
  let index = 0;
  const replaced = text.replace(
    /\[\[block\s+id=([a-zA-Z0-9_-]+)\]\]([\s\S]*?)\[\[\/block\]\]/gi,
    (_, id, body) => {
      const token = `__INLINE_BLOCK_${index}__`;
      placeholders.push({
        token,
        html: `<span class="inline-fragment" data-inline-block-id="${escapeHtml(id.trim())}">${escapeHtml(
          (body || '').trim(),
        )}</span>`,
      });
      index += 1;
      return token;
    },
  );
  let escaped = escapeHtml(replaced);
  placeholders.forEach(({ token, html }) => {
    const safeToken = new RegExp(escapeRegExp(token), 'g');
    escaped = escaped.replace(safeToken, html);
  });
  return escaped;
}

function convertPlainTextToHtml(text = '') {
  if (!text || !text.trim()) return '';
  const normalized = text.replace(/\r/g, '');
  const paragraphs = normalized.split(/\n{2,}/).map((chunk) => chunk.trim()).filter(Boolean);
  if (!paragraphs.length) {
    return `<div>${transformInlinePlaceholders(normalized.trim()).replace(/\n/g, '<br />')}</div>`;
  }
  return paragraphs.map((chunk) => `<div>${transformInlinePlaceholders(chunk).replace(/\n/g, '<br />')}</div>`).join('');
}

function parseBlockDetailLines(lines = []) {
  const buffers = { title: '', content: '', comments: [], attributes: [] };
  let currentSection = 'content';
  lines.forEach((rawLine) => {
    const line = rawLine.replace(/^\s+/, '');
    if (!line) return;
    const sectionMatch = line.match(/^([A-Za-zА-Яа-яЁё]+)\s*:(.*)$/);
    if (sectionMatch) {
      const label = sectionMatch[1].toLowerCase();
      if (BLOCK_SECTION_MAP[label]) {
        currentSection = BLOCK_SECTION_MAP[label];
        const rest = sectionMatch[2]?.trim() || '';
        if (rest) {
          if (currentSection === 'comments') buffers.comments.push(rest.replace(/^[-*+]\s*/, ''));
          else if (currentSection === 'attributes') buffers.attributes.push(rest);
          else if (currentSection === 'title') buffers.title = rest;
          else buffers.content = buffers.content ? `${buffers.content}\n${rest}` : rest;
        }
        return;
      }
    }
    if (currentSection === 'comments') buffers.comments.push(line.replace(/^[-*+]\s*/, ''));
    else if (currentSection === 'attributes') buffers.attributes.push(line);
    else if (currentSection === 'title') buffers.title = buffers.title ? `${buffers.title}\n${line}` : line;
    else buffers.content = buffers.content ? `${buffers.content}\n${line}` : line;
  });

  const attributes = {};
  buffers.attributes.forEach((entry) => {
    const attrMatch = entry.match(/^\s*(?:[-*+]\s*)?([^:=]+):=$/);
    if (attrMatch) {
      const key = attrMatch[1].trim();
      const value = attrMatch[2].trim();
      if (key) attributes[key] = value;
    }
  });

  return {
    title: buffers.title.trim(),
    content: buffers.content.trim(),
    comments: buffers.comments.filter(Boolean),
    attributes,
  };
}

export function parseMarkdownBlocksInput(text = '') {
  const lines = text.replace(/\t/g, '  ').split(/\r?\n/);
  const root = { level: -1, children: [] };
  const stack = [root];
  lines.forEach((line) => {
    if (!line.trim()) return;
    const match = line.match(/^(\s*)-\s+(.*)$/);
    if (match) {
      const indent = match[1].length;
      const level = Math.floor(indent / MARKDOWN_BLOCK_INDENT);
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      const parent = stack[stack.length - 1];
      const parentChildren = parent.block ? parent.block.children : parent.children;
      const block = { title: match[2].trim(), detailLines: [], children: [] };
      parentChildren.push(block);
      stack.push({ level, block, children: block.children });
      return;
    }
    const current = stack[stack.length - 1];
    if (current?.block) current.block.detailLines.push(line);
  });

  const normalize = (node) => {
    const sections = parseBlockDetailLines(node.detailLines || []);
    return {
      title: sections.title || node.title,
      content: sections.content,
      comments: sections.comments,
      attributes: sections.attributes,
      children: (node.children || []).map((child) => normalize(child)),
    };
  };

  return root.children.map((child) => normalize(child));
}

function renderCommentsHtml(comments = []) {
  if (!comments?.length) return '';
  const items = comments.map((comment) => `<li>${escapeHtml(comment)}</li>`).join('');
  return `<div class="block-section block-section--comments"><strong>Комментарии:</strong><ul>${items}</ul></div>`;
}

function renderAttributesHtml(attributes = {}) {
  const entries = Object.entries(attributes || {});
  if (!entries.length) return '';
  const items = entries.map(([key, value]) => `<li><strong>${escapeHtml(key)}:</strong> ${escapeHtml(value)}</li>`).join('');
  return `<div class="block-section block-section--attributes"><strong>Атрибуты:</strong><ul>${items}</ul></div>`;
}

export function buildBlockPayloadFromParsed(parsed) {
  if (!parsed) return null;
  const title = parsed.title?.trim() || 'Новый блок';
  const contentHtml = convertPlainTextToHtml(parsed.content);
  const commentsHtml = renderCommentsHtml(parsed.comments);
  const attrsHtml = renderAttributesHtml(parsed.attributes);
  const bodySections = [contentHtml, commentsHtml, attrsHtml].filter(Boolean).join('');
  const rawHtml = bodySections ? `${title}<div><br /></div>${bodySections}` : title;
  return {
    text: buildStoredBlockHtml(rawHtml),
    collapsed: false,
    children: (parsed.children || []).map((child) => buildBlockPayloadFromParsed(child)).filter(Boolean),
  };
}
