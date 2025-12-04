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
  // Структурная операция над блоками (move/indent/outdent), чтобы не запускать несколько сразу.
  isMovingBlock: false,
  // Удаление блока (чтобы не слали несколько DELETE подряд).
  isDeletingBlock: false,
  // Предпочтительная позиция каретки при входе в режим редактирования блока: 'start' | 'end'.
  editingCaretPosition: 'start',
};

export let isSavingTitle = false;
export let isHintVisible = false;

export function setSavingTitle(value) {
  isSavingTitle = value;
}
export function setHintVisibility(visible) {
  isHintVisible = visible;
}
