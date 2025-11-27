export const state = {
  mode: 'view',
  articleId: null,
  article: null,
  currentBlockId: null,
  editingBlockId: null,
  undoStack: [],
  redoStack: [],
  pendingTextPreview: null,
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
};

export let isSavingTitle = false;
export let isHintVisible = false;

export function setSavingTitle(value) {
  isSavingTitle = value;
}
export function setHintVisibility(visible) {
  isHintVisible = visible;
}
