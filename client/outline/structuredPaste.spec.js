import { describe, expect, it } from 'vitest';
import { buildOutlineSectionTree, parseMarkdownOutlineSections } from './structuredPaste.js';

describe('structuredPaste', () => {
  it('parses markdown headings into sections', () => {
    const text = `
preface ignored

## A

one
two

## B
bbb
`;
    const res = parseMarkdownOutlineSections(text);
    expect(res.startsWithHeading).toBe(false);
    expect(res.sections.map((s) => s.title)).toEqual(['A', 'B']);
    expect(res.sections[0].bodyText.startsWith('\n')).toBe(false);
    expect(res.sections[0].bodyText).toContain('one');
    expect(res.sections[0].bodyText).toContain('two');
  });

  it('builds nested tree by heading level', () => {
    const { sections } = parseMarkdownOutlineSections(`## A\n### A.1\n## B\n#### B.deep\n`);
    let id = 0;
    const roots = buildOutlineSectionTree(sections, { makeId: () => `id${(id += 1)}` });
    expect(roots.map((r) => r.title)).toEqual(['A', 'B']);
    expect(roots[0].children.map((c) => c.title)).toEqual(['A.1']);
    // Jump from ## to #### clamps to one deeper than current stack.
    expect(roots[1].children.map((c) => c.title)).toEqual(['B.deep']);
  });
});
