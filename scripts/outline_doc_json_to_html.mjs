import { generateHTML } from '@tiptap/html';
import StarterKit from '@tiptap/starter-kit';
import { Link } from '@tiptap/extension-link';
import { Image } from '@tiptap/extension-image';
import { TableKit } from '@tiptap/extension-table';

function clamp(n, a, b) {
  const x = Number(n);
  if (!Number.isFinite(x)) return a;
  return Math.max(a, Math.min(b, x));
}

function parseWidthPx(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const m = raw.match(/(\d+(?:\.\d+)?)px/i);
  if (!m) return null;
  const num = Number.parseFloat(m[1]);
  return Number.isFinite(num) ? num : null;
}

const ResizableImage = Image.extend({
  inline: true,
  group: 'inline',
  addAttributes() {
    const parentAttrs = typeof this.parent === 'function' ? this.parent() : {};
    return {
      ...parentAttrs,
      width: {
        default: 320,
        parseHTML: (element) => {
          try {
            const el = element;
            const wrapper =
              el && el.classList && el.classList.contains('resizable-image')
                ? el
                : el?.closest?.('.resizable-image');
            const fromStyle = parseWidthPx(wrapper?.style?.width || '');
            if (fromStyle !== null) return Math.round(fromStyle);
            const fromAttr =
              parseWidthPx(wrapper?.getAttribute?.('style') || '') || parseWidthPx(el?.getAttribute?.('style') || '');
            if (fromAttr !== null) return Math.round(fromAttr);
            const data = wrapper?.getAttribute?.('data-width') || el?.getAttribute?.('data-width') || '';
            const fromData = Number.parseFloat(String(data || ''));
            if (Number.isFinite(fromData) && fromData > 0) return Math.round(fromData);
            return 320;
          } catch {
            return 320;
          }
        },
        renderHTML: () => ({}),
      },
      uploadToken: {
        default: null,
        parseHTML: () => null,
        renderHTML: () => ({}),
      },
    };
  },
  parseHTML() {
    return [
      {
        tag: 'span.resizable-image',
        getAttrs: (element) => {
          const el = element;
          const img = el?.querySelector?.('img');
          const src = img?.getAttribute?.('src') || '';
          if (!src) return false;
          const alt = img?.getAttribute?.('alt') || '';
          const title = img?.getAttribute?.('title') || '';
          const width = parseWidthPx(el?.style?.width || '') ?? 320;
          return { src, alt, title, width: Math.round(width) };
        },
      },
      {
        tag: 'img[src]',
        getAttrs: (element) => {
          const el = element;
          const src = el?.getAttribute?.('src') || '';
          if (!src) return false;
          const alt = el?.getAttribute?.('alt') || '';
          const title = el?.getAttribute?.('title') || '';
          return { src, alt, title, width: 320 };
        },
      },
    ];
  },
  renderHTML({ node, HTMLAttributes }) {
    const rawWidth = node?.attrs?.width;
    const width = Number.isFinite(Number(rawWidth)) ? Math.round(Number(rawWidth)) : 320;
    const imgAttrs = { ...HTMLAttributes };
    delete imgAttrs.width;
    delete imgAttrs.uploadToken;
    return [
      'span',
      {
        class: 'resizable-image',
        style: `width:${width}px;max-width:100%;`,
      },
      ['span', { class: 'resizable-image__inner' }, ['img', { ...imgAttrs, draggable: 'false' }]],
      ['span', { class: 'resizable-image__handle', 'data-direction': 'e', 'aria-hidden': 'true' }],
    ];
  },
});

const extensions = [
  StarterKit.configure({
    // We'll create heading nodes ourselves, but StarterKit provides the heading node.
    link: false,
  }),
  Link.configure({
    openOnClick: false,
    validate: () => true,
  }),
  ResizableImage,
  TableKit.configure({ table: { resizable: true } }),
];

function escapeAttr(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function htmlForSection(sectionNode, depth) {
  const id = String(sectionNode?.attrs?.id || '');
  const content = Array.isArray(sectionNode?.content) ? sectionNode.content : [];
  const headingNode = content.find((n) => n?.type === 'outlineHeading') || null;
  const bodyNode = content.find((n) => n?.type === 'outlineBody') || null;
  const childrenNode = content.find((n) => n?.type === 'outlineChildren') || null;

  const level = clamp(depth, 1, 6);

  const headingContent = Array.isArray(headingNode?.content) ? headingNode.content : [];
  const bodyContent = Array.isArray(bodyNode?.content) ? bodyNode.content : [];

  // Build a plain TipTap doc for this section: heading + body nodes.
  const doc = {
    type: 'doc',
    content: [
      {
        type: 'heading',
        attrs: { level },
        content: headingContent,
      },
      ...bodyContent,
    ],
  };

  let html = generateHTML(doc, extensions) || '';
  html = String(html || '').trim();
  // @tiptap/html server renderer may include XHTML xmlns attributes; strip them for cleaner HTML.
  html = html.replaceAll(' xmlns="http://www.w3.org/1999/xhtml"', '');
  const children = Array.isArray(childrenNode?.content) ? childrenNode.content : [];
  const childHtml = children.map((c) => htmlForSection(c, depth + 1)).join('');

  const safeId = escapeAttr(id);
  return `<section class="doc-section" data-section-id="${safeId}">${html}${childHtml}</section>`;
}

async function main() {
  let input = '';
  process.stdin.setEncoding('utf-8');
  for await (const chunk of process.stdin) input += chunk;
  const payload = input ? JSON.parse(input) : {};
  const docJson = payload?.docJson || null;
  const content = Array.isArray(docJson?.content) ? docJson.content : [];
  const sections = content.filter((n) => n?.type === 'outlineSection');
  const html = sections.map((s) => htmlForSection(s, 1)).join('\n');
  process.stdout.write(String(html || ''));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
