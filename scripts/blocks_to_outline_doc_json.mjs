import { Window } from 'happy-dom';

// TipTap needs a DOM. Provide minimal globals for @tiptap/html.
// We use `happy-dom` because it's already present in this repo (used by tests/build scripts),
// so the migration can run without extra dependencies.
const window = new Window();
globalThis.document = window.document;
globalThis.Node = window.Node;
globalThis.DOMParser = window.DOMParser;
globalThis.navigator = window.navigator;

import { generateJSON } from '@tiptap/html';
import StarterKit from '@tiptap/starter-kit';
import { Link } from '@tiptap/extension-link';
import { Image } from '@tiptap/extension-image';
import { TableKit } from '@tiptap/extension-table';

const parseWidthPx = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const m = raw.match(/(\d+(?:\.\d+)?)px/i);
  if (!m) return null;
  const num = Number.parseFloat(m[1]);
  return Number.isFinite(num) ? num : null;
};

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
});

const extensions = [
  StarterKit.configure({ heading: false, link: false }),
  Link.configure({
    openOnClick: false,
    validate: () => true,
  }),
  ResizableImage,
  TableKit.configure({ table: { resizable: true } }),
];

const isEmptyParagraph = (node) => {
  if (!node || node.nodeName !== 'P') return false;
  const text = (node.textContent || '').replace(/\u00a0/g, ' ').trim();
  if (text) return false;
  const hasOnlyBr =
    node.childNodes.length === 1 && node.childNodes[0].nodeName === 'BR';
  const hasTrailingBreak =
    node.querySelector && node.querySelector('br') && !node.querySelector('img,table,ul,ol,blockquote,pre');
  return Boolean(hasOnlyBr || hasTrailingBreak);
};

function extractTitleAndBodyHtml(blockHtml) {
  const html = String(blockHtml || '').trim();
  if (!html) return { titleText: '', bodyHtml: '' };
  const container = document.createElement('div');
  container.innerHTML = html;
  const children = Array.from(container.children || []);
  if (!children.length) return { titleText: '', bodyHtml: html };

  const first = children[0];
  const second = children[1] || null;
  const firstText = (first?.textContent || '').replace(/\u00a0/g, ' ').trim();

  // Legacy heuristic: title is the first paragraph ONLY if followed by an empty paragraph.
  if (first && first.nodeName === 'P' && firstText && second && isEmptyParagraph(second)) {
    const bodyParts = children.slice(2).map((el) => el.outerHTML);
    return { titleText: firstText, bodyHtml: bodyParts.join('') };
  }

  // No explicit title marker -> no title, entire HTML is body.
  return { titleText: '', bodyHtml: html };
}

function ensureBodyContent(nodes) {
  if (Array.isArray(nodes) && nodes.length) return nodes;
  return [{ type: 'paragraph', content: [] }];
}

function convertBlock(block) {
  const id = String(block?.id || '');
  const collapsed = Boolean(block?.collapsed);
  const { titleText, bodyHtml } = extractTitleAndBodyHtml(block?.text || '');
  const bodyDoc = generateJSON(String(bodyHtml || '').trim(), extensions);
  const bodyNodes = ensureBodyContent(Array.isArray(bodyDoc?.content) ? bodyDoc.content : []);
  const children = Array.isArray(block?.children) ? block.children : [];
  return {
    type: 'outlineSection',
    attrs: { id, collapsed },
    content: [
      {
        type: 'outlineHeading',
        content: titleText ? [{ type: 'text', text: titleText }] : [],
      },
      {
        type: 'outlineBody',
        content: bodyNodes,
      },
      {
        type: 'outlineChildren',
        content: children.map(convertBlock),
      },
    ],
  };
}

async function main() {
  let input = '';
  process.stdin.setEncoding('utf-8');
  for await (const chunk of process.stdin) input += chunk;
  const payload = input ? JSON.parse(input) : {};
  const blocks = Array.isArray(payload.blocks) ? payload.blocks : [];
  const sections = blocks.map(convertBlock);
  const doc = { type: 'doc', content: sections.length ? sections : [convertBlock({ id: payload.fallbackId || 'root', text: '', collapsed: false, children: [] })] };
  process.stdout.write(JSON.stringify(doc));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
