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
    const declarations = selectorMap.get('.block.block--no-title');
    expect(declarations).toBeTruthy();
    expect(declarations).toMatchObject({
      display: 'grid',
      'grid-template-columns': 'auto 1fr auto',
      'grid-template-rows': 'auto auto',
      'align-items': 'flex-start',
      'column-gap': '0.5rem',
      'padding-top': '0.15rem',
      'padding-bottom': '0.15rem',
    });
    expect(normalizeValue(declarations['grid-template-areas'])).toBe(
      "'collapse body drag' 'children children children'",
    );
  });

  it('держит header, текст и drag-handle в одной строке', () => {
    expect(expectDeclaration('.block.block--no-title .block-header__left', 'grid-area')).toBe('collapse');
    expect(expectDeclaration('.block.block--no-title .block-text', 'grid-area')).toBe('body');
    expect(expectDeclaration('.block.block--no-title .block-children', 'grid-area')).toBe('children');
    expect(expectDeclaration('.block.block--no-title .block-title-spacer', 'display')).toBe('none');
  });

  it('фиксирует положение кнопок collapse и drag', () => {
    expect(expectDeclaration('.block.block--no-title .block-header__left', 'display')).toBe('flex');
    expect(expectDeclaration('.block.block--no-title .block-header__left', 'align-items')).toBe('flex-start');
    const dragDecls = selectorMap.get('.drag-handle');
    expect(dragDecls).toBeTruthy();
    expect(dragDecls).toMatchObject({
      width: '28px',
      'min-width': '28px',
      display: 'inline-flex',
      'justify-content': 'center',
      'align-items': 'center',
    });
    expect(expectDeclaration('.block.block--no-title .block-text', 'align-self')).toBe('center');
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
    expect(expectDeclaration('.block.block--no-title .block-children', 'margin-left')).toBe('-1.25rem');
    expect(expectDeclaration('.block.block--no-title .block-children', 'width')).toBe('calc(100% + 1.25rem)');
  });
});
