import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { readFileSync } from 'node:fs';

const srcPath = path.resolve(process.cwd(), 'client/block.js');
const source = readFileSync(srcPath, 'utf-8');

describe('plain-text paste handling', () => {
  it('не заменяет каждый одиночный перевод строки на <br>, а только абзацные разрывы', () => {
    // В обработчике paste для text/plain:
    // 1) нормализуем CRLF/CR в \n;
    const hasNormalization = /const\s+normalized\s*=\s*text\.replace\(/.test(source);
    expect(
      hasNormalization,
      'Ожидаем, что текст из буфера сначала нормализуется (CRLF/CR → \\n) в переменную normalized',
    ).toBe(true);

    // 2) строим HTML так, чтобы двойные переводы строк становились <br /><br />,
    //    а одиночные схлопывались до пробела.
    const pattern =
      /const\s+safeTextHtml\s*=\s*escapeHtml\(normalized\)\s*\.\s*replace\(/;
    expect(
      pattern.test(source),
      'Ожидаем, что для plain-text вставки используется escapeHtml(normalized) с последующими replace по \\n{2,} и одиночным \\n',
    ).toBe(true);

    // При этом старого поведения с replace(/\\n/g, '<br />') рядом с escapeHtml(text)
    // быть не должно.
    expect(
      source.includes("escapeHtml(text).replace(/\\n/g, '<br />')"),
      'Старый путь escapeHtml(text).replace(/\\n/g, \'<br />\') для plain-text вставки должен быть удалён',
    ).toBe(false);
  });

  it('после кастомной вставки для contenteditable генерируется synthetic input, чтобы сработал локальный editing-undo', () => {
    const hasHelper = /function\s+notifyEditingInput\s*\(\s*element\s*\)/.test(source);
    expect(
      hasHelper,
      'Ожидаем вспомогательную функцию notifyEditingInput(element), которая шлёт synthetic input-событие',
    ).toBe(true);

    const pasteHtmlCallsInput =
      /if\s*\(\s*htmlData\s*\)\s*{[\s\S]*?insertHtmlAtCaret\(element,\s*linkifyHtml\(trimmed\)\);\s*notifyEditingInput\(element\);/.test(
        source,
      );
    expect(
      pasteHtmlCallsInput,
      'Ожидаем, что в ветке text/html после insertHtmlAtCaret вызывается notifyEditingInput(element)',
    ).toBe(true);

    const pasteUrlCallsInput =
      /isLikelyUrl\)\s*{\s*[\s\S]*?insertHtmlAtCaret\([\s\S]*?safeUrl[\s\S]*?\);\s*notifyEditingInput\(element\);/.test(
        source,
      );
    expect(
      pasteUrlCallsInput,
      'Ожидаем, что для вставки URL после insertHtmlAtCaret вызывается notifyEditingInput(element)',
    ).toBe(true);

    const pasteTextCallsInput =
      /const\s+safeHtml\s*=\s*linkifyHtml\(trimPastedHtml\(safeTextHtml\)\);\s*[\s\S]*?insertHtmlAtCaret\(element,\s*safeHtml\);\s*notifyEditingInput\(element\);/.test(
        source,
      );
    expect(
      pasteTextCallsInput,
      'Ожидаем, что для plain-text вставки после insertHtmlAtCaret(element, safeHtml) вызывается notifyEditingInput(element)',
    ).toBe(true);
  });
});
