import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { readFileSync } from 'node:fs';

const srcPath = path.resolve(process.cwd(), 'client/article.js');
const source = readFileSync(srcPath, 'utf-8');

function expectFloatConst(name, expected) {
  const match = source.match(new RegExp(`const\\s+${name}\\s*=\\s*([0-9.]+)`));
  expect(match, `Не нашли константу ${name} в client/article.js`).toBeTruthy();
  const value = parseFloat(match[1]);
  expect(value).toBeCloseTo(expected);
}

describe('DND thresholds', () => {
  it('фиксирует зоны before/after в 35%/65%', () => {
    expectFloatConst('DROP_BEFORE_THRESHOLD', 0.35);
    expectFloatConst('DROP_AFTER_THRESHOLD', 0.65);
  });

  it('использует константы в расчёте placement', () => {
    const placementLogic = /placement\s*=\s*ratio\s*<\s*DROP_BEFORE_THRESHOLD\s*\?\s*'before'\s*:\s*ratio\s*>\s*DROP_AFTER_THRESHOLD\s*\?\s*'after'\s*:\s*'inside'/;
    expect(
      placementLogic.test(source),
      'Тернарное условие placement должно опираться на DROP_BEFORE_THRESHOLD и DROP_AFTER_THRESHOLD',
    ).toBe(true);
  });
});

describe('DND touch / selection safeguards', () => {
  it('в режиме просмотра блоки не помечаются contenteditable=\"false\"', () => {
    // Мы намеренно удаляем атрибут целиком, чтобы мобильные браузеры
    // не пытались включать режим редактирования/selection.
    expect(
      source.includes("body.removeAttribute('contenteditable');"),
    ).toBe(true);
    expect(
      source.includes("setAttribute('contenteditable', 'false')"),
    ).toBe(false);
  });

  it('pointerdown добавляет special-case для touch/pen с preventDefault в drag-режиме', () => {
    const hasTouchGuard =
      /const\s+isTouchPointer\s*=\s*event\.pointerType\s*===\s*'touch'\s*\|\|\s*event\.pointerType\s*===\s*'pen';/.test(
        source,
      ) &&
      /if\s*\(\s*isTouchPointer\s*&&\s*isDragModeOperational\(\)\s*\)\s*{\s*event\.preventDefault\(\);/.test(source);
    expect(
      hasTouchGuard,
      'Ожидаем, что registerBlockDragSource гасит нативное поведение для touch/pen при включённом drag-режиме',
    ).toBe(true);
  });

  it('selectionchange сбрасывает выделение только в рабочем drag-режиме', () => {
    const selectionHandlerRe =
      /function\s+handleDragSelectionChange\s*\([\s\S]*?if\s*\(\s*!activeDrag\s*\|\|\s*!isDragModeOperational\(\)\s*\)\s*return;[\s\S]+?sel\.removeAllRanges\(\);[\s\S]*?document\.addEventListener\('selectionchange',\s*handleDragSelectionChange\);[\s\S]*?document\.removeEventListener\('selectionchange',\s*handleDragSelectionChange\);/;
    expect(
      selectionHandlerRe.test(source),
      'Ожидаем локальный handler handleDragSelectionChange, который в активной DnD-сессии очищает selection через removeAllRanges() и навешивается только на время перетаскивания',
    ).toBe(true);
  });

  it('selectionchange-guard игнорирует события мыши и работает только для touch/pen', () => {
    const mouseBypassRe =
      /function\s+handleDragSelectionChange[\s\S]*?if\s*\(\s*!activeDrag\s*\|\|\s*!isDragModeOperational\(\)\s*\)\s*return;[\s\S]*?if\s*\(\s*activeDrag\.pointerType\s*===\s*'mouse'\s*\)\s*return;[\s\S]*?const\s+sel\s*=\s*window\.getSelection/;
    expect(
      mouseBypassRe.test(source),
      'Ожидаем, что handleDragSelectionChange сначала проверяет activeDrag и режим, а затем отдельно игнорирует pointerType === "mouse", чтобы не сбрасывать выделение на десктопе',
    ).toBe(true);
  });

  it('block-dnd-active включается только для touch/pen во время движения указателя', () => {
    const beginSessionStoresPointerType =
      /activeDrag\s*=\s*{\s*[\s\S]*?pointerType\s*:\s*event\.pointerType\s*\|\|\s*'mouse'[\s\S]*?startX\s*:\s*event\.clientX/.test(
        source,
      );
    expect(
      beginSessionStoresPointerType,
      'Ожидаем, что beginDragSession сохраняет pointerType в activeDrag (event.pointerType || "mouse")',
    ).toBe(true);

    const handleMoveTouchOnlyRe =
      /function\s+handlePointerMove\([\s\S]*?if\s*\(!activeDrag\.dragging\)\s*{\s*[\s\S]*?activeDrag\.dragging\s*=\s*true;[\s\S]*?const\s+pointerType\s*=\s*activeDrag\.pointerType\s*\|\|\s*event\.pointerType\s*\|\|\s*'mouse';[\s\S]*?if\s*\(\s*pointerType\s*===\s*'touch'\s*\|\|\s*pointerType\s*===\s*'pen'\s*\)\s*{\s*document\.body\.classList\.add\('block-dnd-active'\);/.test(
        source,
      );
    expect(
      handleMoveTouchOnlyRe,
      'Ожидаем, что handlePointerMove включает body.block-dnd-active только для pointerType === "touch" или "pen", а не для мыши',
    ).toBe(true);
  });
});
