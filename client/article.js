// Этот файл оставлен как фасад (публичный API) для остального клиента.
// Большая часть логики вынесена в модули в папке `./article/*`.

// Вынесено из этого файла: UI заголовка → `./article/header.js`.
export { updateArticleHeaderUi } from './article/header.js';

// Вынесено из этого файла: шифрование → `./article/encryption.js`.
export { toggleArticleEncryption, removeArticleEncryption } from './article/encryption.js';

// Вынесено из этого файла: загрузка статьи в state → `./article/loadCore.js`.
export { loadArticle } from './article/loadCore.js';

// Вынесено из этого файла: рендер блоков и DOM-утилиты → `./article/render.js`.
export {
  renderArticle,
  rerenderSingleBlock,
  reorderDomBlock,
  removeDomBlockById,
  pushLocalBlockTrashEntry,
} from './article/render.js';

// Вынесено из этого файла: view-функции и inbox/merge сценарии → `./article/views.js`.
export {
  mergeAllBlocksIntoFirst,
  loadArticleView,
  loadListView,
  loadPublicArticleView,
  createArticle,
  openInboxArticle,
  createInboxNote,
} from './article/views.js';

// Вынесено из этого файла: DnD блоков и UI режима перетаскивания → `./article/dnd.js`.
export { toggleDragMode } from './article/dnd.js';

import { updateDragModeUi } from './article/dnd.js';

// Инициализируем состояние кнопки режима перетаскивания сразу при загрузке клиента.
updateDragModeUi();

