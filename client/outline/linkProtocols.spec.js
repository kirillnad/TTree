// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { generateHTML } from '@tiptap/html/server';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import { OUTLINE_ALLOWED_LINK_PROTOCOLS } from './linkProtocols.js';

describe('outline link protocols', () => {
  it('keeps app:/ href when protocols are allowed', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'uploading',
              marks: [{ type: 'link', attrs: { href: 'app:/Memus/Uploads/file.pdf' } }],
            },
          ],
        },
      ],
    };

    const htmlWithoutProtocols = generateHTML(doc, [
      StarterKit.configure({ link: false }),
      Link.configure({ openOnClick: false }),
    ]);
    expect(htmlWithoutProtocols).toContain('href=""');

    const htmlWithProtocols = generateHTML(doc, [
      StarterKit.configure({ link: false }),
      Link.configure({ openOnClick: false, protocols: OUTLINE_ALLOWED_LINK_PROTOCOLS }),
    ]);
    expect(htmlWithProtocols).toContain('href="app:/Memus/Uploads/file.pdf"');
  });
});
