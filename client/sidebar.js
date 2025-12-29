// Этот файл оставлен как фасад (публичный API) для остального клиента.
// Большая часть логики вынесена в модули в папке `./sidebar/*`.

import { refs } from './refs.js';
import { state } from './state.js';
import { initRecentFromStorage } from './sidebar/recent.js';
import {
  loadSidebarCollapsedFromStorage,
  loadCollapsedArticlesFromStorage,
  loadListCollapsedArticlesFromStorage,
} from './sidebar/storage.js';
import { setSidebarCollapsed } from './sidebar/layout.js';
import { setSidebarDndCallbacks } from './sidebar/dnd.js';
import { renderSidebarArticleList, renderMainArticleList, setArticlesIndex } from './sidebar/render.js';

// Важно: DnD статей живёт в отдельном модуле и требует callbacks,
// чтобы избежать циклических импортов.
setSidebarDndCallbacks({ renderSidebarArticleList, renderMainArticleList, setArticlesIndex });

// Вынесено из этого файла: localStorage состояния → `./sidebar/storage.js`.
export {
  saveCollapsedArticles,
  saveListCollapsedArticles,
  ensureSidebarSelectionVisible,
} from './sidebar/storage.js';

// Вынесено из этого файла: режим "Последние" → `./sidebar/recent.js`.
export { toggleSidebarRecentMode, recordArticleOpened } from './sidebar/recent.js';

// Вынесено из этого файла: UI сайдбара → `./sidebar/layout.js`.
export {
  setViewMode,
  toggleHintPopover,
  hideHintPopover,
  setSidebarCollapsed,
  toggleSidebarCollapsed,
  setSidebarMobileOpen,
  closeSidebarMobile,
  toggleSidebarMobile,
} from './sidebar/layout.js';

// Вынесено из этого файла: рендер списков и индекс статей → `./sidebar/render.js`.
export {
  toggleFavorite,
  setTrashMode,
  setArticlesIndex,
  setDeletedArticlesIndex,
  handleArticleFilterInput,
  scrollSidebarArticleIntoView,
  scrollSidebarSelectionIntoView,
  upsertArticleIndex,
  removeArticleFromIndex,
  removeArticleFromTrashIndex,
  renderSidebarArticleList,
  renderMainArticleList,
  ensureArticlesIndexLoaded,
  ensureDeletedArticlesIndexLoaded,
} from './sidebar/render.js';

export function initSidebarStateFromStorage() {
  loadSidebarCollapsedFromStorage();
  loadCollapsedArticlesFromStorage();
  loadListCollapsedArticlesFromStorage();
  initRecentFromStorage();
  if (refs.sidebar) {
    // setSidebarCollapsed также сохранит состояние в storage;
    // это ок, но главное — применить класс и aria.
    setSidebarCollapsed(Boolean(state.isSidebarCollapsed));
  }
}
