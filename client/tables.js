import { refs } from './refs.js';
import { state } from './state.js';

function getTableFromEvent(event) {
  if (!event) return null;
  const target = event.target;
  if (!target || !(target instanceof Element)) return null;
  return target.closest('table.memus-table');
}

function getCellFromEvent(event) {
  if (!event) return null;
  const target = event.target;
  if (!target || !(target instanceof Element)) return null;
  return target.closest('td,th');
}

function addRowAfter(cell) {
  if (!cell) return;
  const row = cell.parentElement;
  const table = row && row.closest('table.memus-table');
  if (!row || !table) return;
  const tbody = table.tBodies[0] || table.createTBody();
  const rows = Array.from(tbody.rows);
  const rowIndex = rows.indexOf(row);
  const colCount = row.cells.length;
  const newRow = document.createElement('tr');
  for (let i = 0; i < colCount; i += 1) {
    const td = document.createElement('td');
    // Ненулевая высота новой строки
    td.innerHTML = '&nbsp;';
    newRow.appendChild(td);
  }
  if (rowIndex >= 0 && rowIndex < rows.length - 1) {
    tbody.insertBefore(newRow, rows[rowIndex + 1]);
  } else {
    tbody.appendChild(newRow);
  }
}

function deleteRow(cell) {
  if (!cell) return;
  const row = cell.parentElement;
  const table = row && row.closest('table.memus-table');
  if (!row || !table) return;
  const tbody = table.tBodies[0];
  if (!tbody) return;
  if (tbody.rows.length <= 1) return;
  tbody.removeChild(row);
}

function addColumnAfter(cell) {
  if (!cell) return;
  const table = cell.closest('table.memus-table');
  if (!table) return;
  const colIndex = cell.cellIndex;
  const rows = Array.from(table.rows);
  rows.forEach((row) => {
    const newCell = document.createElement(
      row.sectionRowIndex === 0 && row.parentElement === table.tHead ? 'th' : 'td',
    );
    // Ненулевая ширина новой колонки
    newCell.innerHTML = '&nbsp;';
    if (colIndex >= 0 && colIndex < row.cells.length - 1) {
      row.insertBefore(newCell, row.cells[colIndex + 1]);
    } else {
      row.appendChild(newCell);
    }
  });

  // Обновляем colgroup для новой колонки.
  let colgroup = table.querySelector('colgroup');
  if (!colgroup) {
    colgroup = document.createElement('colgroup');
    table.insertBefore(colgroup, table.firstChild);
  }
  let cols = Array.from(colgroup.querySelectorAll('col'));
  const newCount = rows[0]?.cells.length || cols.length + 1 || 1;
  while (cols.length < newCount) {
    const col = document.createElement('col');
    colgroup.appendChild(col);
    cols = Array.from(colgroup.querySelectorAll('col'));
  }
  const width = 100 / newCount;
  cols.forEach((col) => {
    col.setAttribute('width', `${width}%`);
  });
}

function deleteColumn(cell) {
  if (!cell) return;
  const table = cell.closest('table.memus-table');
  if (!table) return;
  const colIndex = cell.cellIndex;
  if (colIndex < 0) return;
  const rows = Array.from(table.rows);
  // Не удаляем, если останется 0 колонок.
  if (rows.length && rows[0].cells.length <= 1) return;
  rows.forEach((row) => {
    if (row.cells[colIndex]) {
      row.deleteCell(colIndex);
    }
  });
  // Обновляем colgroup после удаления.
  const colgroup = table.querySelector('colgroup');
  if (colgroup) {
    const cols = Array.from(colgroup.querySelectorAll('col'));
    if (cols[colIndex]) cols[colIndex].remove();
    const remaining = Array.from(colgroup.querySelectorAll('col'));
    const count = remaining.length || (table.tHead?.rows[0]?.cells.length || 0);
    if (count > 0) {
      const width = 100 / count;
      if (!remaining.length) {
        for (let i = 0; i < count; i += 1) {
          const col = document.createElement('col');
          col.setAttribute('width', `${width}%`);
          colgroup.appendChild(col);
        }
      } else {
        remaining.forEach((col) => {
          col.setAttribute('width', `${width}%`);
        });
      }
    }
  }
}

let currentToolbar = null;

function closeToolbar() {
  if (currentToolbar && currentToolbar.parentElement) {
    currentToolbar.parentElement.removeChild(currentToolbar);
  }
  currentToolbar = null;
}

function openToolbarForCell(cell) {
  closeToolbar();
  if (!cell) return;
  const table = cell.closest('table.memus-table');
  if (!table) return;
  const toolbar = document.createElement('div');
  toolbar.className = 'table-toolbar';

  const makeButton = (label, title) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'table-toolbar-btn';
    btn.textContent = label;
    if (title) btn.title = title;
    return btn;
  };

  const btnAddRow = makeButton('+стр', 'Добавить строку ниже');
  const btnDelRow = makeButton('−стр', 'Удалить строку');
  const btnAddCol = makeButton('+кол', 'Добавить колонку справа');
  const btnDelCol = makeButton('−кол', 'Удалить колонку');

  btnAddRow.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    addRowAfter(cell);
  });
  btnDelRow.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    deleteRow(cell);
  });
  btnAddCol.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    addColumnAfter(cell);
  });
  btnDelCol.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    deleteColumn(cell);
  });

  toolbar.appendChild(btnAddRow);
  toolbar.appendChild(btnDelRow);
  toolbar.appendChild(btnAddCol);
  toolbar.appendChild(btnDelCol);

  const container = table.parentElement || table;
  container.insertBefore(toolbar, table);
  currentToolbar = toolbar;
}

let resizeState = null;

function startResize(event, th, colIndex) {
  const table = th.closest('table.memus-table');
  if (!table) return;
  const colgroup = table.querySelector('colgroup');
  if (!colgroup) return;
  const cols = Array.from(colgroup.querySelectorAll('col'));
  if (!cols[colIndex]) return;
  const tableRect = table.getBoundingClientRect();
  const startX = event.clientX;
  const startWidths = cols.map((col) => {
    const w = col.getAttribute('width') || '';
    if (w.endsWith('%')) {
      return parseFloat(w.replace('%', '').trim()) || 0;
    }
    return 0;
  });
  const totalPercent = startWidths.reduce((sum, v) => sum + v, 0) || 100;
  resizeState = {
    table,
    colgroup,
    cols,
    startX,
    startWidths,
    totalPercent,
    colIndex,
    tableWidthPx: tableRect.width || 1,
  };
  event.preventDefault();
  event.stopPropagation();
}

function onMouseMove(event) {
  if (!resizeState) return;
  const { cols, colIndex, startX, startWidths, totalPercent, tableWidthPx } = resizeState;
  const dxPx = event.clientX - startX;
  const deltaPercent = (dxPx / tableWidthPx) * totalPercent;
  const newWidths = [...startWidths];
  const current = newWidths[colIndex] || totalPercent / cols.length;
  const nextIndex = colIndex + 1;
  const next = newWidths[nextIndex] || totalPercent / cols.length;
  let newCurrent = current + deltaPercent;
  let newNext = next - deltaPercent;
  const minPercent = totalPercent * 0.05;
  if (newCurrent < minPercent) {
    const diff = minPercent - newCurrent;
    newCurrent = minPercent;
    newNext -= diff;
  }
  if (newNext < minPercent) {
    const diff = minPercent - newNext;
    newNext = minPercent;
    newCurrent -= diff;
  }
  newWidths[colIndex] = newCurrent;
  if (cols[nextIndex]) {
    newWidths[nextIndex] = newNext;
  }
  newWidths.forEach((w, idx) => {
    if (cols[idx]) {
      const pct = (w / totalPercent) * 100;
      cols[idx].setAttribute('width', `${pct}%`);
    }
  });
}

function onMouseUp() {
  resizeState = null;
}

function attachResizeHandles(table) {
  const thead = table.tHead;
  if (!thead) return;

  const headerRow = thead.rows[0];
  if (!headerRow) return;

  // Гарантируем наличие colgroup для новых таблиц (например, вставленных из редактора),
  // чтобы столбцы занимали всю ширину и работал ресайз колонок.
  let colgroup = table.querySelector('colgroup');
  if (!colgroup) {
    const colCount = Math.max(headerRow.cells.length || 1, 1);
    const width = 100 / colCount;
    colgroup = document.createElement('colgroup');
    for (let i = 0; i < colCount; i += 1) {
      const col = document.createElement('col');
      col.setAttribute('width', `${width.toFixed(4)}%`);
      colgroup.appendChild(col);
    }
    table.insertBefore(colgroup, thead);
  }

  Array.from(headerRow.cells).forEach((th, index) => {
    const handle = document.createElement('div');
    handle.className = 'table-col-resize-handle';
    handle.addEventListener('mousedown', (event) => startResize(event, th, index));
    th.style.position = 'relative';
    th.appendChild(handle);
  });
}

export function initTables() {
  // Управление строками/столбцами по клику в ячейку.
  if (refs.articleView) {
    refs.articleView.addEventListener(
      'click',
      (event) => {
        const cell = getCellFromEvent(event);
        // Панель показываем только:
        // - в режиме редактирования блока;
        // - когда клик пришёлся по ячейке таблицы внутри редактируемого блока.
        if (!cell || state.mode !== 'edit' || !state.editingBlockId) {
          closeToolbar();
          return;
        }
        // Показываем панель только если таблица находится внутри редактируемого блока.
        const editableContainer = cell.closest('[contenteditable="true"]');
        if (!editableContainer) {
          closeToolbar();
          return;
        }
        openToolbarForCell(cell);
      },
      true,
    );

    // Прокрутка колёсиком внутри таблицы должна скроллить список блоков.
    refs.articleView.addEventListener(
      'wheel',
      (event) => {
        const target = event.target;
        if (!target || !(target instanceof Element)) return;
        if (!target.closest('table.memus-table')) return;
        if (!refs.blocksContainer) return;
        refs.blocksContainer.scrollTop += event.deltaY;
        event.preventDefault();
      },
      { capture: true, passive: false },
    );
  }

  // Глобальные обработчики для ресайза колонок.
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);

  // При первоначальной загрузке статьи навешиваем ручки на таблицы.
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((m) => {
      m.addedNodes.forEach((node) => {
        if (!(node instanceof HTMLElement)) return;
        if (node.matches && node.matches('table.memus-table')) {
          attachResizeHandles(node);
        } else {
          node.querySelectorAll?.('table.memus-table').forEach((table) => {
            attachResizeHandles(table);
          });
        }
      });
    });
  });

  if (refs.articleView) {
    observer.observe(refs.articleView, { childList: true, subtree: true });
    refs.articleView.querySelectorAll('table.memus-table').forEach((table) => {
      attachResizeHandles(table);
    });
  }
}
