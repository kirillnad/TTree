// Вынесено из `block.js`: очистка/санитайз HTML для contenteditable (paste/save).

import { isSeparatorNode } from './paragraphMerge.js';

const URL_REGEX = /((?:https?:\/\/|www\.)[^\s<>"']+)/gi;

export function linkifyHtml(html = '') {
  const template = document.createElement('template');
  template.innerHTML = html || '';

  const linkifyNode = (node) => {
    if (!node) return;
    if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'A') {
      return; // skip existing links
    }
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent || '';
      URL_REGEX.lastIndex = 0;
      const hasMatch = URL_REGEX.test(text);
      if (!hasMatch) return;

      const fragment = document.createDocumentFragment();
      let lastIndex = 0;
      URL_REGEX.lastIndex = 0;
      let current;
      while ((current = URL_REGEX.exec(text)) !== null) {
        const [url] = current;
        if (current.index > lastIndex) {
          fragment.appendChild(document.createTextNode(text.slice(lastIndex, current.index)));
        }
        const href = url.startsWith('http') ? url : `https://${url}`;
        const anchor = document.createElement('a');
        anchor.href = href;
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
        anchor.textContent = url;
        fragment.appendChild(anchor);
        lastIndex = current.index + url.length;
      }
      if (lastIndex < text.length) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
      }
      if (node.parentNode) {
        node.parentNode.replaceChild(fragment, node);
      }
      return;
    }
    Array.from(node.childNodes || []).forEach(linkifyNode);
  };

  Array.from(template.content.childNodes).forEach(linkifyNode);
  return template.innerHTML;
}

export function sanitizePastedHtml(html = '') {
  const template = document.createElement('template');
  template.innerHTML = html || '';

  // Remove scripts/styles entirely
  template.content.querySelectorAll('script, style').forEach((node) => node.remove());

  const isUnsafeUrl = (value = '') => /^javascript:/i.test(value.trim());

  const cleanNode = (node) => {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) {
      Array.from(node?.childNodes || []).forEach(cleanNode);
      return;
    }

    Array.from(node.attributes || []).forEach((attr) => {
      const name = attr.name.toLowerCase();
      const value = attr.value || '';
      if (name.startsWith('on') || name === 'style') {
        node.removeAttribute(attr.name);
        return;
      }
      if ((name === 'href' || name === 'src') && isUnsafeUrl(value)) {
        node.removeAttribute(attr.name);
      }
    });

    Array.from(node.childNodes || []).forEach(cleanNode);
  };

  Array.from(template.content.childNodes || []).forEach(cleanNode);
  return template.innerHTML;
}

export function trimPastedHtml(html = '') {
  const template = document.createElement('template');
  template.innerHTML = html || '';

  const isEmptyNode = (node) => {
    if (!node) return true;
    if (node.nodeType === Node.TEXT_NODE) {
      return !(node.textContent || '').replace(/\u00a0/g, '').trim();
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return false;
    if (node.tagName === 'BR') return true;
    const content = (node.innerHTML || '').replace(/<br\s*\/?>/gi, '').replace(/&nbsp;/gi, '').trim();
    const text = (node.textContent || '').replace(/\u00a0/g, '').trim();
    const hasMedia = !!node.querySelector('img,video,audio,iframe');
    return !content && !text && !hasMedia;
  };

  while (template.content.firstChild && isEmptyNode(template.content.firstChild)) {
    template.content.removeChild(template.content.firstChild);
  }
  while (template.content.lastChild && isEmptyNode(template.content.lastChild)) {
    template.content.removeChild(template.content.lastChild);
  }

  return template.innerHTML;
}

export function cleanupEditableHtml(html = '') {
  const originalTemplate = document.createElement('template');
  originalTemplate.innerHTML = html || '';
  const originalText = (originalTemplate.content.textContent || '')
    .replace(/\u00a0/g, ' ')
    .trim();
  const originalHasAnchors = Boolean(originalTemplate.content.querySelector('a'));
  // Запоминаем, была ли в исходном HTML ведущая «пустая» строка
  // (первый осмысленный узел — пустой абзац/див, как в isSeparatorNode).
  let hasLeadingEmptyLine = false;
  {
    const nodes = Array.from(originalTemplate.content.childNodes || []);
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i];
      if (node.nodeType === Node.TEXT_NODE) {
        if (!(node.textContent || '').trim()) continue;
        // Ненулевая текстовая нода — значит, пустой строки в начале не было.
        break;
      }
      if (isSeparatorNode(node)) {
        hasLeadingEmptyLine = true;
      }
      break;
    }
  }

  const template = document.createElement('template');
  template.innerHTML = html || '';

  // blob:/filesystem: URL'ы в <img> существуют только в рамках конкретной вкладки/сессии
  // и всегда ломаются после перезагрузки. Если такие попали в сохранение — заменяем
  // на текстовый плейсхолдер, чтобы не хранить «битые» картинки.
  {
    template.content.querySelectorAll('img').forEach((img) => {
      const src = String(img.getAttribute('src') || '').trim();
      if (!/^(blob:|filesystem:)/i.test(src)) return;
      const alt = String(img.getAttribute('alt') || '').trim() || 'image';
      const wrapper = img.closest?.('.resizable-image') || img;
      try {
        wrapper.replaceWith(
          document.createTextNode(`[${alt} — изображение было blob: и не было сохранено]`),
        );
      } catch {
        // ignore
      }
    });
  }

  // Специальный случай: блок состоит только из строк вида "|...|...|"
  // Превращаем их сразу в HTML-таблицу и выходим.
  const tryConvertPipeTable = () => {
    const children = Array.from(template.content.childNodes || []);
    if (!children.length) return false;
    const paras = Array.from(template.content.querySelectorAll('p'));
    if (paras.length < 2) return false;
    const isTableRow = (line) => {
      const trimmed = line.trim();
      return trimmed.startsWith('|') && trimmed.indexOf('|', 1) !== -1;
    };
    const lines = paras.map((p) => (p.textContent || '').replace(/\u00a0/g, ' ').trim());
    const nonEmptyLines = lines.filter((t) => t);
    if (nonEmptyLines.length < 2) return false;
    if (!nonEmptyLines.every(isTableRow)) return false;

    const allRows = nonEmptyLines.map((raw) => {
      const stripped = raw.trim();
      const inner = stripped.endsWith('|') ? stripped.slice(1, -1) : stripped.slice(1);
      return inner.split('|').map((cell) => cell.trim());
    });
    const header = allRows[0];
    const body = allRows.slice(1);
    const colCount = body.reduce((max, row) => Math.max(max, row.length), header.length);
    const table = document.createElement('table');
    table.className = 'memus-table';
    const colgroup = document.createElement('colgroup');
    const width = 100 / Math.max(colCount, 1);
    for (let i = 0; i < colCount; i += 1) {
      const col = document.createElement('col');
      col.setAttribute('width', `${width.toFixed(4)}%`);
      colgroup.appendChild(col);
    }
    table.appendChild(colgroup);
    const thead = document.createElement('thead');
    const trHead = document.createElement('tr');
    for (let i = 0; i < colCount; i += 1) {
      const th = document.createElement('th');
      th.textContent = header[i] || '';
      trHead.appendChild(th);
    }
    thead.appendChild(trHead);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    body.forEach((row) => {
      const tr = document.createElement('tr');
      const cells = [...row];
      for (let i = 0; i < colCount; i += 1) {
        const td = document.createElement('td');
        td.textContent = cells[i] || '';
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    template.content.innerHTML = '';
    template.content.appendChild(table);
    const cleanedTable = linkifyHtml(template.innerHTML);
    return cleanedTable.replace(/<\/a>\s*<a/gi, '</a> <a');
  };

  const tableResult = tryConvertPipeTable();
  if (tableResult) {
    return tableResult;
  }

  // Удаляем служебные элементы UI (панель управления таблицей и её кнопки),
  // чтобы они не попадали в сохранённый HTML блока.
  template.content.querySelectorAll('.table-toolbar, .table-toolbar-btn').forEach((node) => {
    node.remove();
  });

  // СЂР°Р·РІРѕСЂР°С‡РёРІР°РµРј .block-header, СѓР±РёСЂР°РµРј РєР»Р°СЃСЃС‹
  template.content.querySelectorAll('.block-header').forEach((node) => {
    const parent = node.parentNode;
    if (!parent) return;
    while (node.firstChild) parent.insertBefore(node.firstChild, node);
    parent.removeChild(node);
  });

  const convertDivsToParagraphs = (root) => {
    Array.from(root.childNodes).forEach((node) => {
      if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.tagName === 'DIV') {
          // Р·Р°РјРµРЅСЏРµРј div РЅР° p, СЃРѕС…СЂР°РЅСЏСЏ СЃРѕРґРµСЂР¶РёРјРѕРµ
          const p = document.createElement('p');
          p.innerHTML = node.innerHTML;
          node.parentNode.replaceChild(p, node);
          convertDivsToParagraphs(p);
          return;
        }
        convertDivsToParagraphs(node);
      }
    });
  };

  convertDivsToParagraphs(template.content);

  // РћР±РѕСЂР°С‡РёРІР°РµРј РІРµСЂС…РЅРµСѓСЂРѕРІРЅРµРІС‹Рµ С‚РµРєСЃС‚РѕРІС‹Рµ СѓР·Р»С‹ РІ Р°Р±Р·Р°С†С‹
  const wrapTextNodes = (root) => {
    const nodes = Array.from(root.childNodes || []);
    nodes.forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const raw = node.textContent || '';
        const collapsed = raw.replace(/\u00a0/g, ' ');
        const trimmed = collapsed.trim();
        if (!trimmed) {
          // Keep a spacer between inline siblings, otherwise drop
          if (node.previousSibling && node.nextSibling) {
            node.textContent = ' ';
            return;
          }
          root.removeChild(node);
          return;
        }
        const p = document.createElement('p');
        p.textContent = collapsed;
        root.replaceChild(p, node);
      }
    });
  };
  wrapTextNodes(template.content);

  // Нормализация пустых строк:
  // При сохранении НЕ удаляем пустые абзацы и НЕ схлопываем их —
  // пользователь явно управляет пустыми строками.
  // Единственное: приводим «пустой <p>» к <p><br/></p>, чтобы caret работал.
  template.content.querySelectorAll('p').forEach((p) => {
    const inner = (p.innerHTML || '').replace(/&nbsp;/gi, '').replace(/<br\s*\/?>/gi, '').trim();
    if (!inner) {
      p.innerHTML = '';
      p.appendChild(document.createElement('br'));
    }
  });

  const root = template.content;
  const hasAnyParagraph = Boolean(root.querySelector('p'));

  // Гарантируем наличие хотя бы одного абзаца.
  if (!hasAnyParagraph) {
    const p = document.createElement('p');
    p.appendChild(document.createElement('br'));
    root.appendChild(p);
  } else if (hasLeadingEmptyLine) {
    // Если в исходном блоке первая строка была пустой,
    // восстанавливаем одну пустую строку в начале.
    const nodesTop = Array.from(root.childNodes || []);
    let anchor = null;
    for (let i = 0; i < nodesTop.length; i += 1) {
      const node = nodesTop[i];
      if (node.nodeType === Node.TEXT_NODE && !(node.textContent || '').trim()) {
        // Пропускаем ведущие пробельные текстовые узлы.
        // Они всё равно не влияют на разметку.
        continue;
      }
      anchor = node;
      break;
    }
    if (!anchor) {
      // Нет видимых узлов — просто добавляем один пустой абзац.
      const p = document.createElement('p');
      p.appendChild(document.createElement('br'));
      root.appendChild(p);
    } else if (!(anchor.tagName === 'P' && isSeparatorNode(anchor))) {
      // Если первый видимый узел уже не является пустым <p>,
      // вставляем пустую строку перед ним.
      const p = document.createElement('p');
      p.appendChild(document.createElement('br'));
      root.insertBefore(p, anchor);
    }
  }

  const cleaned = linkifyHtml(template.innerHTML);
  // Ensure adjacent links remain visually separated after cleanup
  const normalized = cleaned.replace(/<\/a>\s*<a/gi, '</a> <a');

  // Защита от «слишком агрессивной» очистки: если после всех преобразований
  // HTML стал пустым, но в исходном содержимом был текст или ссылки —
  // возвращаем исходный HTML как есть, чтобы не терять данные пользователя.
  if (!normalized.trim() && (originalText || originalHasAnchors)) {
    return html || '';
  }

  return normalized;
}
