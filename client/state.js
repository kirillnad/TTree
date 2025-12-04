export const state = {
  mode: 'view',
  currentUser: null,
  articleId: null,
  article: null,
  currentBlockId: null,
  editingBlockId: null,
  // Мультивыделение блоков в режиме просмотра.
  selectionAnchorBlockId: null,
  selectedBlockIds: [],
  undoStack: [],
  redoStack: [],
  pendingTextPreview: null,
  editingInitialText: '',
  searchQuery: '',
  searchResults: [],
  searchError: '',
  searchLoading: false,
  searchRequestId: 0,
  scrollTargetBlockId: null,
  pendingEditBlockId: null,
  isEditingTitle: false,
  isSidebarCollapsed: false,
  isSidebarMobileOpen: false,
  articlesIndex: [],
  deletedArticlesIndex: [],
  articleFilterQuery: '',
  lastChangeTimestamp: null,
  isMarkdownInserting: false,
  isTrashView: false,
  favoriteArticles: [],
  isDragModeEnabled: false,
  articleEncryptionKeys: {},
  // Процесс объединения блоков (чтобы избежать повторных кликов).
  isMergingBlocks: false,
  // Предпочтительная позиция каретки при входе в режим редактирования блока: 'start' | 'end'.
  editingCaretPosition: 'end',
};

export let isSavingTitle = false;
export let isHintVisible = false;

export function setSavingTitle(value) {
  isSavingTitle = value;
}
export function setHintVisibility(visible) {
  isHintVisible = visible;
}
