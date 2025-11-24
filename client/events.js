import { state, isHintVisible } from './state.js';
import { refs } from './refs.js';
import { handleUndoAction, handleRedoAction, clearPendingTextPreview } from './undo.js';
import { moveCurrentBlock, indentCurrentBlock, outdentCurrentBlock } from './undo.js';
import { createSibling, deleteCurrentBlock, startEditing, saveEditing, cancelEditing, handleGlobalPaste } from './actions.js';
import { moveSelection, findCollapsibleTarget, setCollapseState, setCurrentBlock } from './block.js';
import { handleSearchInput, hideSearchResults, renderSearchResults } from './search.js';
import { startTitleEditingMode, handleTitleInputKeydown, handleTitleInputBlur, toggleArticleMenu, closeArticleMenu, isArticleMenuVisible, handleDeleteArticle, handleTitleClick } from './title.js';
import { toggleHintPopover, hideHintPopover, setTrashMode } from './sidebar.js';
import { toggleSidebarCollapsed, handleArticleFilterInput } from './sidebar.js';
import { createArticle, openInboxArticle, createInboxNote } from './article.js';
import { navigate, routing } from './routing.js';
import { exportCurrentArticleAsHtml } from './exporter.js';

function handleViewKey(event) {
  if (!state.article) return;
  if (
    state.isEditingTitle &&
    refs.articleTitleInput &&
    refs.articleTitleInput.contains(event.target)
  ) {
    return;
  }
  if (isHintVisible && event.code === 'Escape') {
    event.preventDefault();
    hideHintPopover();
    return;
  }
  const code = typeof event.code === 'string' ? event.code : '';
  const isCtrlZ = event.ctrlKey && !event.shiftKey && code === 'KeyZ';
  const isCtrlY = event.ctrlKey && !event.shiftKey && code === 'KeyY';
  if (state.pendingTextPreview) {
    if (state.pendingTextPreview.mode === 'undo' && isCtrlZ) {
      event.preventDefault();
      handleUndoAction();
      return;
    }
    if (state.pendingTextPreview.mode === 'redo' && isCtrlY) {
      event.preventDefault();
      handleRedoAction();
      return;
    }
    if (code === 'Escape') {
      event.preventDefault();
      clearPendingTextPreview();
      return;
    }
    event.preventDefault();
    return;
  }
  if (isCtrlZ) {
    event.preventDefault();
    handleUndoAction();
    return;
  }
  if (isCtrlY) {
    event.preventDefault();
    handleRedoAction();
    return;
  }
  if (event.ctrlKey && event.shiftKey && event.code === 'ArrowDown') {
    event.preventDefault();
    moveCurrentBlock('down');
    return;
  }
  if (event.ctrlKey && event.shiftKey && event.code === 'ArrowUp') {
    event.preventDefault();
    moveCurrentBlock('up');
    return;
  }
  if (event.ctrlKey && !event.shiftKey && event.code === 'ArrowDown') {
    event.preventDefault();
    createSibling('after');
    return;
  }
  if (event.ctrlKey && !event.shiftKey && event.code === 'ArrowUp') {
    event.preventDefault();
    createSibling('before');
    return;
  }
  if (event.ctrlKey && event.code === 'Delete') {
    event.preventDefault();
    deleteCurrentBlock();
    return;
  }
  if (event.ctrlKey && event.code === 'ArrowRight') {
    event.preventDefault();
    indentCurrentBlock();
    return;
  }
  if (event.ctrlKey && event.code === 'ArrowLeft') {
    event.preventDefault();
    outdentCurrentBlock();
    return;
  }
  if (event.code === 'ArrowDown') {
    event.preventDefault();
    moveSelection(1);
    return;
  }
  if (event.code === 'ArrowUp') {
    event.preventDefault();
    moveSelection(-1);
    return;
  }
  if (event.code === 'ArrowLeft') {
    event.preventDefault();
    const targetId = findCollapsibleTarget(state.currentBlockId, true);
    if (targetId) {
      if (state.currentBlockId !== targetId) {
        setCurrentBlock(targetId);
      }
      setCollapseState(targetId, true);
    }
    return;
  }
  if (event.code === 'ArrowRight') {
    event.preventDefault();
    const targetId = findCollapsibleTarget(state.currentBlockId, false);
    if (targetId) {
      setCollapseState(targetId, false);
    }
    return;
  }
  if (event.code === 'Enter') {
    event.preventDefault();
    startEditing();
  }
}

function handleEditKey(event) {
  if (event.ctrlKey && !event.shiftKey && event.code === 'ArrowDown') {
    event.preventDefault();
    (async () => {
      await saveEditing();
      await createSibling('after');
    })();
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

export function attachEvents() {
  document.addEventListener('keydown', (event) => {
    if (state.mode === 'view') {
      handleViewKey(event);
    } else {
      handleEditKey(event);
    }
  });

  document.addEventListener('paste', handleGlobalPaste);

  if (refs.createArticleBtn) {
    refs.createArticleBtn.addEventListener('click', createArticle);
  }
  if (refs.sidebarNewArticleBtn) {
    refs.sidebarNewArticleBtn.addEventListener('click', createArticle);
  }
  if (refs.openInboxBtn) {
    refs.openInboxBtn.addEventListener('click', () => {
      openInboxArticle();
    });
  }
  if (refs.quickNoteAddBtn) {
    refs.quickNoteAddBtn.addEventListener('click', () => {
      createInboxNote();
    });
  }
  refs.backToList.addEventListener('click', () => navigate(routing.list));
  if (refs.searchInput) {
    refs.searchInput.addEventListener('input', handleSearchInput);
    refs.searchInput.addEventListener('focus', () => {
      if (state.searchQuery.trim()) {
        renderSearchResults();
      }
    });
  }
  if (refs.editTitleBtn) {
    refs.editTitleBtn.addEventListener('click', startTitleEditingMode);
  }
  if (refs.articleTitle) {
    refs.articleTitle.addEventListener('dblclick', startTitleEditingMode);
    refs.articleTitle.addEventListener('click', handleTitleClick);
  }
  if (refs.articleMenuBtn) {
    refs.articleMenuBtn.addEventListener('click', toggleArticleMenu);
  }
  if (refs.exportArticleBtn) {
    refs.exportArticleBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      closeArticleMenu();
      exportCurrentArticleAsHtml();
    });
  }
  if (refs.deleteArticleBtn) {
    refs.deleteArticleBtn.addEventListener('click', handleDeleteArticle);
  }
  if (refs.articleTitleInput) {
    refs.articleTitleInput.addEventListener('keydown', handleTitleInputKeydown);
    refs.articleTitleInput.addEventListener('blur', handleTitleInputBlur);
  }
  if (refs.hintToggleBtn) {
    refs.hintToggleBtn.addEventListener('click', toggleHintPopover);
  }
  if (refs.sidebarToggle) {
    refs.sidebarToggle.addEventListener('click', toggleSidebarCollapsed);
  }
  if (refs.articleFilterInput) {
    refs.articleFilterInput.addEventListener('input', handleArticleFilterInput);
  }
  if (refs.articlesTabBtn) {
    refs.articlesTabBtn.addEventListener('click', () => setTrashMode(false));
  }
  if (refs.trashTabBtn) {
    refs.trashTabBtn.addEventListener('click', () => setTrashMode(true));
  }
  document.addEventListener('click', (event) => {
    if (refs.searchPanel && !refs.searchPanel.contains(event.target)) {
      hideSearchResults();
    }
    if (
      isHintVisible &&
      refs.hintPopover &&
      !refs.hintPopover.contains(event.target) &&
      !(refs.hintToggleBtn && refs.hintToggleBtn.contains(event.target))
    ) {
      hideHintPopover();
    }
    if (
      isArticleMenuVisible() &&
      refs.articleMenu &&
      !refs.articleMenu.contains(event.target) &&
      !(refs.articleMenuBtn && refs.articleMenuBtn.contains(event.target))
    ) {
      closeArticleMenu();
    }
  });
}
