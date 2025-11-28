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
    `Правило "${selector}" отсутствует в client/style.css — убедитесь, что markup блоков без заголовка не поменялся.`,
  ).toBeTruthy();
  expect(
    declarations?.[property],
    `В правиле "${selector}" отсутствует свойство "${property}" — отступы/позиционирование могло измениться.`,
  ).toBeTruthy();
  return declarations[property];
}

function normalizeValue(value = '') {
  return value.replace(/\s+/g, ' ').trim();
}

describe('layout блоков без заголовка', () => {
  it('оставляет сетку и отступы как в текущем макете', () => {
    const declarations = selectorMap.get('.block.block--no-title > .block-surface');
    expect(declarations).toBeTruthy();
    expect(declarations).toMatchObject({
      display: 'grid',
      'grid-template-columns': 'auto 1fr auto',
      'grid-template-areas': "'collapse content drag'",
      'align-items': 'flex-start',
      'column-gap': '0.5rem',
    });
    expect(normalizeValue(declarations['grid-template-areas'])).toBe("'collapse content drag'");
  });

  it('держит header, текст и drag-handle в одной строке', () => {
    expect(expectDeclaration('.block.block--no-title > .block-surface > .collapse-btn', 'grid-area')).toBe('collapse');
    expect(expectDeclaration('.block.block--no-title > .block-surface .block-content', 'grid-area')).toBe('content');
    expect(expectDeclaration('.block.block--no-title > .block-surface > .drag-handle', 'grid-area')).toBe('drag');
  });

  it('фиксирует положение кнопок collapse и drag', () => {
    expect(expectDeclaration('.block.block--no-title > .block-surface .block-header__left', 'display')).toBe('flex');
    expect(expectDeclaration('.block.block--no-title > .block-surface .block-header__left', 'align-items')).toBe(
      'flex-start',
    );
    const dragDecls = selectorMap.get('.drag-handle');
    expect(dragDecls).toBeTruthy();
    expect(dragDecls).toMatchObject({
      width: '22px',
      'min-width': '22px',
      display: 'inline-flex',
      'justify-content': 'center',
      'align-items': 'center',
    });
    expect(expectDeclaration('.block.block--no-title > .block-surface .block-text', 'align-self')).toBe('center');
    expect(expectDeclaration('.collapse-btn', 'box-sizing')).toBe('border-box');
    expect(expectDeclaration('.collapse-btn', 'padding')).toBe('0');
    expect(expectDeclaration('.collapse-btn', 'width')).toBe('22px');
    expect(expectDeclaration('.collapse-btn', 'height')).toBe('22px');
    expect(expectDeclaration('.collapse-btn', 'align-self')).toBe('flex-start');
    expect(expectDeclaration('.collapse-btn', 'display')).toBe('inline-flex');
    expect(expectDeclaration('.collapse-btn', 'justify-content')).toBe('center');
    expect(expectDeclaration('.collapse-btn', 'align-items')).toBe('center');
  });

  it('обеспечивает общую правую границу для всех уровней', () => {
    expect(expectDeclaration('.block-children', 'margin-left')).toBe('1.25rem');
    expect(expectDeclaration('.block-children', 'width')).toBe('calc(100% - 1.25rem)');
  });

  it('фиксирует внутренние отступы и размер drag', () => {
    expect(expectDeclaration('.block .block-content', 'padding')).toBe('0.3rem');
    expect(expectDeclaration('.drag-handle', 'min-height')).toBe('22px');
  });

  it('фиксирует положение и размеры кнопок редактирования', () => {
    const actions = selectorMap.get('.block-edit-actions');
    expect(actions).toBeTruthy();
    expect(actions).toMatchObject({
      display: 'flex',
      'justify-content': 'space-between',
      'align-items': 'center',
      gap: '0.75rem',
      margin: '0.35rem 0 0.6rem',
      padding: '0 0.2rem',
      width: '100%',
    });
    expect(expectDeclaration('.block.editing > .block-surface .block-edit-actions', 'grid-column')).toBe('1 / -1');
    const iconButton = selectorMap.get('.block-edit-actions .icon-button');
    expect(iconButton).toBeTruthy();
    expect(iconButton).toMatchObject({
      'min-width': '32px',
      height: '32px',
      display: 'inline-flex',
      padding: '0',
      'border-radius': '16px',
    });
  });
});
