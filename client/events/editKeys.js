// Вынесено из `TTree/client/events.js`:
// - обработка горячих клавиш в режиме редактирования блока (undo/redo, split, indent/outdent, save/cancel).
import { applyEditingUndoStep } from '../block.js';
import { indentCurrentBlock, outdentCurrentBlock } from '../undo.js';
import { splitEditingBlockAtCaret, saveEditing, cancelEditing, createSibling } from '../actions.js';

export function handleEditKey(event) {
  const code = typeof event.code === 'string' ? event.code : '';
  const isCtrlZ = event.ctrlKey && !event.shiftKey && code === 'KeyZ';
  const isCtrlY = event.ctrlKey && !event.shiftKey && code === 'KeyY';
  const isCtrlShiftZ = event.ctrlKey && event.shiftKey && code === 'KeyZ';

  if (isCtrlZ) {
    if (applyEditingUndoStep(-1)) {
      event.preventDefault();
      return;
    }
  }
  if (isCtrlY || isCtrlShiftZ) {
    if (applyEditingUndoStep(1)) {
      event.preventDefault();
      return;
    }
  }

  if (event.ctrlKey && !event.shiftKey && event.code === 'ArrowDown') {
    event.preventDefault();
    splitEditingBlockAtCaret();
    return;
  }
  if (event.ctrlKey && !event.shiftKey && event.code === 'ArrowUp') {
    event.preventDefault();
    (async () => {
      await saveEditing();
      await createSibling('before');
    })();
    return;
  }
  if (event.code === 'Enter' && event.ctrlKey) {
    event.preventDefault();
    saveEditing();
    return;
  }
  if (
    event.code === 'Tab' &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    !event.metaKey
  ) {
    // Tab в режиме редактирования: сохраняем блок и выходим в просмотр,
    // вместо перехода фокуса на другие элементы.
    event.preventDefault();
    saveEditing();
    return;
  }
  if (event.ctrlKey && event.code === 'ArrowRight') {
    event.preventDefault();
    indentCurrentBlock({ keepEditing: true });
    return;
  }
  if (event.ctrlKey && event.code === 'ArrowLeft') {
    event.preventDefault();
    outdentCurrentBlock({ keepEditing: true });
    return;
  }
  if (event.code === 'Escape') {
    event.preventDefault();
    cancelEditing();
  }
}

