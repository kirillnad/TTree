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
