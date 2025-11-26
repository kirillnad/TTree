import { describe, it, expect, beforeEach } from 'vitest';
import {
  escapeHtml,
  escapeRegExp,
  htmlToPlainText,
  htmlToLines,
  isEditableElement,
  textareaToTextContent,
  extractImagesFromHtml,
} from '../utils.js';

describe('utils', () => {
  let container;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.innerHTML = '';
    document.body.appendChild(container);
  });

  it('escapeHtml экранирует спецсимволы', () => {
    expect(escapeHtml(`<span>"O'Reilly" & co</span>`)).toBe(
      '&lt;span&gt;&quot;O&#39;Reilly&quot; &amp; co&lt;/span&gt;',
    );
  });

  it('escapeRegExp экранирует служебные символы регулярного выражения', () => {
    expect(escapeRegExp('a+b*c?.')).toBe('a\\+b\\*c\\?\\.');
  });

  it('htmlToPlainText убирает теги и нормализует пробелы', () => {
    const html = '<p>Привет&nbsp;<strong>мир</strong></p><div>  ещё  текст </div>';
    expect(htmlToPlainText(html)).toBe('Привет мир ещё текст');
  });

  it('htmlToLines разбивает HTML на строки по блочным тегам и <br />', () => {
    const html = '<p>Первая строка</p><div>Вторая<br>и третья</div><li>Четвёртая</li>';
    expect(htmlToLines(html)).toEqual(['Первая строка', 'Вторая', 'и третья', 'Четвёртая']);
  });

  it('isEditableElement учитывает contenteditable и поля ввода', () => {
    const editableDiv = document.createElement('div');
    editableDiv.contentEditable = 'true';
    const input = document.createElement('input');
    const span = document.createElement('span');
    expect(isEditableElement(editableDiv)).toBe(true);
    expect(isEditableElement(input)).toBe(true);
    expect(isEditableElement(span)).toBe(false);
  });

  it('textareaToTextContent возвращает чистый текст', () => {
    const html = '<textarea>&lt;script&gt;alert(1)&lt;/script&gt;</textarea>';
    expect(textareaToTextContent(html)).toBe('<script>alert(1)</script>');
  });

  it('extractImagesFromHtml собирает src и alt', () => {
    const html = '<p><img src="/a.png" alt="А"><img src="/b.jpg"></p>';
    expect(extractImagesFromHtml(html)).toEqual([
      { src: '/a.png', alt: 'А' },
      { src: '/b.jpg', alt: '' },
    ]);
  });
});
