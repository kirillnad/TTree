import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { parse } from 'css';

const cssPath = path.resolve(process.cwd(), 'client/style.css');
const cssSource = readFileSync(cssPath, 'utf-8');

const selectorMap = new Map();

function ingestRules(rules = []) {
  rules.forEach((rule) => {
    if (rule.type === 'rule') {
      const selectors = rule.selectors || [];
      selectors.forEach((selector) => {
        const trimmed = selector.trim();
        if (!selectorMap.has(trimmed)) selectorMap.set(trimmed, {});
        const bucket = selectorMap.get(trimmed);
        (rule.declarations || []).forEach((decl) => {
          if (decl.type !== 'declaration') return;
          bucket[decl.property] = decl.value;
        });
      });
      return;
    }
    if (rule.type === 'media' && rule.rules) {
      ingestRules(rule.rules);
    }
  });
}

const ast = parse(cssSource);
ingestRules(ast.stylesheet?.rules || []);

function expectDeclaration(selector, property) {
  const declarations = selectorMap.get(selector);
  expect(
    declarations,
    `Правило "${selector}" отсутствует в client/style.css — оно нужно для стабильного layout статьи.`,
  ).toBeTruthy();
  expect(
    declarations?.[property],
    `В правиле "${selector}" отсутствует свойство "${property}" — поведение статьи на разных ширинах могло измениться.`,
  ).toBeTruthy();
  return declarations[property];
}

function normalizeValue(value = '') {
  return value.replace(/\s+/g, ' ').trim();
}

describe('article layout and scroll', () => {
  it('articleView имеет верхний паддинг, чтобы контент не уходил под заголовок', () => {
    const decls = selectorMap.get('#articleView.panel');
    expect(decls).toBeTruthy();
    expect(normalizeValue(decls.padding)).toBe('0.75rem 0.3rem 0.3rem');
  });

  it('blocksContainer скроллится вертикально без горизонтального и имеет отступ сверху', () => {
    const decls = selectorMap.get('#blocksContainer');
    expect(decls).toBeTruthy();
    expect(expectDeclaration('#blocksContainer', 'overflow-y')).toBe('auto');
    expect(expectDeclaration('#blocksContainer', 'overflow-x')).toBe('hidden');
    expect(normalizeValue(decls['padding-top'] || '')).toBe('0.75rem');
  });

  it('articleHeader прилипающий на мобильных и перекрывает блоки корректно', () => {
    const decls = selectorMap.get('#articleHeader');
    expect(decls).toBeTruthy();
    expect(expectDeclaration('#articleHeader', 'position')).toBe('sticky');
    expect(normalizeValue(decls.top || '')).toBe('0');
    expect(expectDeclaration('#articleHeader', 'z-index')).toBe('200');
  });
});

describe('text selection behaviour', () => {
  it('внутри редактируемых блоков выделение и каретка разрешены', () => {
    const editable = selectorMap.get(".block-text[contenteditable='true']");
    expect(editable).toBeTruthy();
    expect(expectDeclaration(".block-text[contenteditable='true']", 'user-select')).toBe('text');
  });
});

describe('drag mode on touch devices', () => {
  it('в drag-mode жесты касания идут в DnD, а не в скролл/selection', () => {
    const decls = selectorMap.get(
      '.drag-mode-enabled #blocksContainer .block:not(.editing) .block-text',
    );
    expect(decls).toBeTruthy();
    expect(expectDeclaration(
      '.drag-mode-enabled #blocksContainer .block:not(.editing) .block-text',
      'touch-action',
    )).toBe('none');
  });

  it('body.drag-mode-enabled гасит выделение и системное меню долгого тапа', () => {
    const decls = selectorMap.get('body.drag-mode-enabled');
    expect(decls).toBeTruthy();
    expect(expectDeclaration('body.drag-mode-enabled', 'user-select')).toBe('none');
    expect(expectDeclaration('body.drag-mode-enabled', '-webkit-touch-callout')).toBe('none');
  });
}
);
