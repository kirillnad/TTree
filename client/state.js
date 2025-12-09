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
  // Локальный undo/redo для текущего редактируемого блока.
  editingUndo: null,
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
  // Независимое выделение статей в сайдбаре и в списке статей.
  sidebarSelectedArticleId: null,
  listSelectedArticleId: null,
  sidebarCollapsedArticleIds: [],
  listCollapsedArticleIds: [],
  isDragModeEnabled: false,
  articleEncryptionKeys: {},
  // Процесс объединения блоков (чтобы избежать повторных кликов).
  isMergingBlocks: false,
  // Структурная операция над блоками (indent/outdent/relocate), чтобы не запускать несколько сразу.
  isMovingBlock: false,
  // Удаление блока (чтобы не слали несколько DELETE подряд).
  isDeletingBlock: false,
  // Очередь асинхронных перемещений блоков вверх/вниз.
  moveQueue: [],
  isMoveQueueProcessing: false,
  // Позиция прокрутки списка блоков перед входом в редактирование.
  editingScrollTop: null,
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
