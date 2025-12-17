import { state, isHintVisible } from './state.js';
import { refs } from './refs.js';
import { handleUndoAction, handleRedoAction, clearPendingTextPreview } from './undo.js';
  import {
  moveCurrentBlock,
  moveSelectedBlocks,
  indentCurrentBlock,
  indentSelectedBlocks,
  outdentCurrentBlock,
  outdentSelectedBlocks,
} from './undo.js';
import {
  createSibling,
  deleteCurrentBlock,
  startEditing,
  saveEditing,
  cancelEditing,
  handleGlobalPaste,
  splitEditingBlockAtCaret,
} from './actions.js';
import {
  moveSelection,
  extendSelection,
  findCollapsibleTarget,
  setCollapseState,
  setCurrentBlock,
  applyEditingUndoStep,
} from './block.js';
import { handleSearchInput, hideSearchResults, renderSearchResults, openRagPageFromCurrentSearch } from './search.js';
import { startTitleEditingMode, handleTitleInputKeydown, handleTitleInputBlur, toggleArticleMenu, closeArticleMenu, isArticleMenuVisible, handleDeleteArticle, handleTitleClick } from './title.js';
import {
  toggleHintPopover,
  hideHintPopover,
  setTrashMode,
  toggleFavorite,
  ensureArticlesIndexLoaded,
  renderMainArticleList,
    renderSidebarArticleList,
    toggleSidebarRecentMode,
  } from './sidebar.js';
import {
  toggleSidebarCollapsed,
  handleArticleFilterInput,
  toggleSidebarMobile,
  closeSidebarMobile,
  setSidebarMobileOpen,
  setSidebarCollapsed,
  saveListCollapsedArticles,
  ensureSidebarSelectionVisible,
} from './sidebar.js';
import { createArticle, openInboxArticle, createInboxNote, toggleDragMode, toggleArticleEncryption, removeArticleEncryption, renderArticle, mergeAllBlocksIntoFirst, updateArticleHeaderUi } from './article.js';
import { navigate, routing } from './routing.js';
import { exportCurrentArticleAsHtml, exportCurrentBlockAsHtml } from './exporter.js';
import {
  apiRequest,
  importArticleFromHtml,
  importArticleFromMarkdown,
  importFromLogseqArchive,
  moveArticlePosition,
  indentArticleApi,
  outdentArticleApi,
  createTelegramLinkToken,
} from './api.js?v=2';
import { showToast, showPersistentToast, hideToast } from './toast.js';
import { insertHtmlAtCaret } from './utils.js';
import { showPrompt, showConfirm, showImportConflictDialog, showPublicLinkModal, showBlockTrashPicker } from './modal.js?v=2';
import { loadArticle } from './article.js';
import { openOutlineEditor } from './outline/editor.js?v=6';
// Вынесено из этого файла: обработка клавиш в режиме просмотра → `./events/viewKeys.js`.
import { handleViewKey, isEditableTarget } from './events/viewKeys.js';
// Вынесено из этого файла: обработка клавиш в режиме редактирования → `./events/editKeys.js`.
import { handleEditKey } from './events/editKeys.js';
// Вынесено из этого файла: навигация по главному списку статей → `./events/listKeys.js`.
import { handleArticlesListKey } from './events/listKeys.js';
// Вынесено из этого файла: логика мобильного сайдбара → `./events/sidebarMobile.js`.
import { attachSidebarMobileHandlers } from './events/sidebarMobile.js';

let sidebarQuickFilterLastTypedAt = 0;
let semanticReindexPollTimeoutId = null;
let semanticReindexIsPolling = false;
let semanticReindexBaseLabel = 'Переиндексировать поиск';
let semanticReindexRunningLabel = 'Переиндексация';

function updateSemanticReindexBtnLabel(task) {
  if (!refs.semanticReindexBtn) return;
  const label = refs.semanticReindexBtn.querySelector('.sidebar-user-menu-label');
  if (!label) return;
  if (task && task.status === 'running') {
    const processed = Number(task.processed || 0);
    const total = Number(task.total || 0);
    const indexParts = total > 0 ? `${processed}/${total}` : `${processed}`;
    label.textContent = `${semanticReindexRunningLabel}: ${indexParts}`;
    return;
  }
  let suffix = '';
  if (task && task.status === 'cooldown') {
    const remaining = Number(task.cooldownRemainingSeconds || 0);
    suffix = remaining > 0 ? ` (через ${Math.ceil(remaining / 60)} мин)` : ' (попробуйте позже)';
  } else if (task && task.status === 'completed') {
    suffix = ` (${task.indexed || 0})`;
  }
  label.textContent = `${semanticReindexBaseLabel}${suffix}`;
}

async function refreshSemanticReindexBtnStatus() {
  if (!refs.semanticReindexBtn) return;
  try {
    const response = await fetch('/api/search/semantic/reindex/status', {
      method: 'GET',
      credentials: 'include',
    });
    if (!response.ok) return;
    const task = await response.json();
    updateSemanticReindexBtnLabel(task);
  } catch {
    // ignore
  }
}

function maybeHandleSidebarQuickFilterKey(event) {
  const { key, ctrlKey, altKey, metaKey } = event;
  if (ctrlKey || altKey || metaKey) return false;
  const target = event.target;
  if (isEditableTarget(target)) return false;
  if (!refs.sidebar || !refs.sidebarQuickFilterInput || !refs.sidebarQuickFilter) return false;
  // Работает только если виден сайдбар (колонка статей).
  if (refs.sidebar.classList.contains('hidden')) return false;

  const input = refs.sidebarQuickFilterInput;
  const wrapper = refs.sidebarQuickFilter;

  if (key === 'Escape') {
    if (!state.articleFilterQuery && !input.value) return false;
    event.preventDefault();
    state.articleFilterQuery = '';
    input.value = '';
    sidebarQuickFilterLastTypedAt = 0;
    ensureSidebarSelectionVisible();
    renderSidebarArticleList();
    return true;
  }

  // Только печатные символы.
  if (key.length !== 1) return false;

  event.preventDefault();
  const now = Date.now();
  const idle = !sidebarQuickFilterLastTypedAt || now - sidebarQuickFilterLastTypedAt > 2000;
  // Берём уже существующее значение, если оно было.
  const base = idle ? '' : (input.value || state.articleFilterQuery || '');
  const next = base + key;
  input.value = next;
  state.articleFilterQuery = next;
  renderSidebarArticleList();
  // Фокусируем поле, чтобы дальнейший ввод шёл напрямую в него.
  input.focus();
  try {
    const len = input.value.length;
    input.setSelectionRange(len, len);
  } catch (_) {
    /* ignore */
  }
  sidebarQuickFilterLastTypedAt = now;
  return true;
}

async function parseMemusExportFromFile(file) {
  if (!file) return null;
  let text;
  try {
    text = await file.text();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to read HTML file', error);
    return null;
  }
  const markerIdx = text.indexOf('id="memus-export"');
  const altIdx = markerIdx === -1 ? text.indexOf("id='memus-export'") : markerIdx;
  if (altIdx === -1) return null;
  const scriptOpen = text.lastIndexOf('<script', altIdx);
  const scriptClose = text.indexOf('</script>', altIdx);
  if (scriptOpen === -1 || scriptClose === -1) return null;
  const contentStart = text.indexOf('>', scriptOpen) + 1;
  if (contentStart === 0 || contentStart > scriptClose) return null;
  const rawJson = text.slice(contentStart, scriptClose).trim();
  if (!rawJson) return null;
  try {
    const payload = JSON.parse(rawJson);
    if (!payload || typeof payload !== 'object') return null;
    if (payload.source !== 'memus' || Number(payload.version || 0) !== 1) return null;
    return payload;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to parse memus-export JSON', error);
    return null;
  }
}

async function checkArticleExists(articleId) {
  if (!articleId) return { exists: false, article: null };
  try {
    const res = await fetch(`/api/articles/${encodeURIComponent(articleId)}`, {
      method: 'GET',
      credentials: 'include',
    });
    if (res.status === 404) {
      return { exists: false, article: null };
    }
    if (!res.ok) {
      const details = await res.json().catch(() => null);
      const message = (details && details.detail) || `Ошибка проверки статьи (status ${res.status})`;
      throw new Error(message);
    }
    const article = await res.json();
    return { exists: true, article };
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to check article existence', error);
    throw error;
  }
}

function buildVersionPrefixFromFile(file) {
  const ts = typeof file.lastModified === 'number' && file.lastModified > 0 ? file.lastModified : Date.now();
  const dt = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `ver_${dt.getFullYear()}${pad(dt.getMonth() + 1)}${pad(dt.getDate())}_${pad(
    dt.getHours(),
  )}${pad(dt.getMinutes())}${pad(dt.getSeconds())}`;
}

async function importHtmlWithConflicts(file, conflictState, { allowApplyToAll } = { allowApplyToAll: false }) {
  if (!file) return null;
  const payload = await parseMemusExportFromFile(file);
  const articleMeta = payload && payload.article;
  const sourceId = (articleMeta && articleMeta.id) || '';
  const importedTitle = (articleMeta && articleMeta.title) || file.name || 'Импортированная статья';
  const importedCreatedAt = (articleMeta && articleMeta.createdAt) || null;
  const importedUpdatedAt = (articleMeta && articleMeta.updatedAt) || null;

  let existsInfo = { exists: false, article: null };
  if (sourceId) {
    existsInfo = await checkArticleExists(sourceId).catch((error) => {
      showPersistentToast(error.message || 'Не удалось проверить наличие статьи');
      throw error;
    });
  }

  if (!existsInfo.exists || !sourceId) {
    // Просто создаём новую статью.
    return importArticleFromHtml(file);
  }

  // Есть конфликт по UUID.
  let decision = conflictState && conflictState.decision;
  let applyToAll = conflictState && conflictState.applyToAll;

  if (!decision || !applyToAll) {
    const dialog = await showImportConflictDialog({
      title: 'Страница уже существует',
      message: 'Что сделать с существующей страницей при восстановлении?',
      existingTitle: existsInfo.article && existsInfo.article.title,
      importedTitle,
      existingCreatedAt: existsInfo.article && existsInfo.article.createdAt,
      existingUpdatedAt: existsInfo.article && existsInfo.article.updatedAt,
      importedCreatedAt,
      importedUpdatedAt,
      allowApplyToAll,
    });
    if (!dialog || !dialog.action) {
      // Отмена.
      return null;
    }
    decision = dialog.action;
    applyToAll = Boolean(dialog.applyToAll);
    if (conflictState) {
      conflictState.decision = decision;
      conflictState.applyToAll = applyToAll;
    }
  }

  if (decision === 'keep') {
    // Оставляем существующую статью — ничего не импортируем.
    return null;
  }

  if (decision === 'overwrite') {
    return importArticleFromHtml(file, { mode: 'overwrite' });
  }

  if (decision === 'copy') {
    const versionPrefix = buildVersionPrefixFromFile(file);
    return importArticleFromHtml(file, { mode: 'copy', versionPrefix });
  }

  return null;
}

function toggleListMenuVisibility(open) {
  if (!refs.listMenu || !refs.listMenuBtn) return;
  refs.listMenu.classList.toggle('hidden', !open);
  refs.listMenuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function closeListMenu() {
  if (!refs.listMenu || !refs.listMenuBtn) return;
  if (refs.listMenu.classList.contains('hidden')) return;
  toggleListMenuVisibility(false);
}

export function attachEvents() {
  document.addEventListener('keydown', (event) => {
    if (state.isOutlineEditing) return;
    if (maybeHandleSidebarQuickFilterKey(event)) return;
    if (state.mode === 'view') {
      handleArticlesListKey(event);
      handleViewKey(event);
    } else {
      handleEditKey(event);
    }
  });

   document.addEventListener(
     'beforeinput',
     (event) => {
       if (state.isOutlineEditing) {
         // В outline-режиме даём TipTap/ProseMirror обрабатывать undo/redo.
         return;
       }
       if (
         event.inputType === 'historyUndo' ||
         event.inputType === 'historyRedo'
       ) {
         const isEditMode =
           state.mode === 'edit' &&
           state.editingBlockId &&
           event.target instanceof HTMLElement &&
           event.target.closest('.block-text[contenteditable="true"]');
         if (isEditMode) {
           event.preventDefault();
           const dir = event.inputType === 'historyUndo' ? -1 : 1;
           applyEditingUndoStep(dir);
           return;
         }
         // В режиме просмотра используем глобальный undo/redo.
         event.preventDefault();
         if (event.inputType === 'historyUndo') {
           handleUndoAction();
         } else {
           handleRedoAction();
         }
       }
     },
     true,
   );

  document.addEventListener('paste', handleGlobalPaste);

  if (refs.createArticleBtn) {
    refs.createArticleBtn.addEventListener('click', () => {
      createArticle();
      if (state.isSidebarMobileOpen) {
        setSidebarMobileOpen(false);
      }
    });
  }
  if (refs.sidebarNewArticleBtn) {
    refs.sidebarNewArticleBtn.addEventListener('click', () => {
      createArticle();
      if (state.isSidebarMobileOpen) {
        setSidebarMobileOpen(false);
      }
    });
  }
  if (refs.openInboxBtn) {
    refs.openInboxBtn.addEventListener('click', () => {
      openInboxArticle();
      if (state.isSidebarMobileOpen) {
        setSidebarMobileOpen(false);
      }
    });
  }
  if (refs.quickNoteAddBtn) {
    refs.quickNoteAddBtn.addEventListener('click', () => {
      createInboxNote();
      if (state.isSidebarMobileOpen) {
        setSidebarMobileOpen(false);
      }
    });
  }
  if (refs.backToList) refs.backToList.addEventListener('click', () => navigate(routing.list));
  if (refs.sidebarRecentBtn) {
    refs.sidebarRecentBtn.addEventListener('click', () => {
      toggleSidebarRecentMode();
    });
  }
  if (refs.searchInput) {
    refs.searchInput.addEventListener('input', handleSearchInput);
    refs.searchInput.addEventListener('focus', () => {
      if (state.searchQuery.trim()) {
        renderSearchResults();
      }
    });
  }
  const updateSearchClearBtn = () => {
    if (!refs.searchClearBtn || !refs.searchInput) return;
    refs.searchClearBtn.classList.toggle('hidden', !(refs.searchInput.value || '').trim());
  };
  if (refs.searchInput) {
    refs.searchInput.addEventListener('input', updateSearchClearBtn);
    refs.searchInput.addEventListener('focus', updateSearchClearBtn);
    updateSearchClearBtn();
  }
  if (refs.searchClearBtn && refs.searchInput) {
    refs.searchClearBtn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      refs.searchInput.value = '';
      refs.searchInput.focus({ preventScroll: true });
      refs.searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      updateSearchClearBtn();
    });
  }
  if (refs.ragOpenBtn) {
    refs.ragOpenBtn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openRagPageFromCurrentSearch();
    });
  }
  const updateSearchModeButton = () => {
    if (!refs.searchModeToggle) return;
    const semantic = state.searchMode === 'semantic';
    refs.searchModeToggle.classList.toggle('search-panel__toggle--active', semantic);
    refs.searchModeToggle.dataset.mode = semantic ? 'semantic' : 'classic';
    refs.searchModeToggle.setAttribute(
      'title',
      semantic ? 'Семантический поиск включён' : 'Переключиться на семантический поиск'
    );
    refs.searchModeToggle.setAttribute(
      'aria-label',
      semantic ? 'Семантический поиск' : 'Классический поиск'
    );
    if (refs.searchInput) {
      refs.searchInput.placeholder = semantic ? 'Семантический поиск...' : 'Поиск...';
    }
  };
  if (refs.searchModeToggle) {
    refs.searchModeToggle.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      state.searchMode = state.searchMode === 'semantic' ? 'classic' : 'semantic';
      updateSearchModeButton();
      if (refs.searchInput) {
        refs.searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    updateSearchModeButton();
  }
  if (refs.editTitleBtn) {
    refs.editTitleBtn.addEventListener('click', startTitleEditingMode);
  }
  if (refs.articleTitle) {
    refs.articleTitle.addEventListener('dblclick', startTitleEditingMode);
    refs.articleTitle.addEventListener('click', handleTitleClick);
    // Позволяем перетаскивать текущую статью, схватившись за заголовок.
    refs.articleTitle.draggable = true;
    refs.articleTitle.addEventListener('dragstart', (event) => {
      if (!state.articleId) return;
      // Используем общий механизм DnD статей: sidebar.js читает draggingArticleId из dataTransfer.
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', state.articleId);
      }
      window.__ttreeDraggingArticleId = state.articleId;
    });
    refs.articleTitle.addEventListener('dragend', () => {
      window.__ttreeDraggingArticleId = null;
    });
  }
  if (refs.articleMenuBtn) {
    refs.articleMenuBtn.addEventListener('click', toggleArticleMenu);
  }
  if (refs.articleFavoriteBtn) {
    refs.articleFavoriteBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      if (!state.article || !state.article.id || state.article.id === 'inbox') return;
      toggleFavorite(state.article.id);
      // Списки обновляются внутри toggleFavorite;
      // здесь достаточно обновить только хедер текущей статьи.
      updateArticleHeaderUi();
    });
  }
  if (refs.listMenuBtn && refs.listMenu) {
    refs.listMenuBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      const open = refs.listMenu.classList.contains('hidden');
      toggleListMenuVisibility(open);
    });
    document.addEventListener(
      'click',
      (event) => {
        const target = event.target;
        if (!refs.listMenu || refs.listMenu.classList.contains('hidden')) return;
        if (refs.listMenu.contains(target) || refs.listMenuBtn.contains(target)) return;
        closeListMenu();
      },
      true,
    );
  }
  if (refs.articleEncryptionBtn) {
    refs.articleEncryptionBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleArticleEncryption();
    });
  }
  if (refs.articleEncryptionRemoveBtn) {
    refs.articleEncryptionRemoveBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      removeArticleEncryption();
    });
  }
  if (refs.articlePublicLinkBtn) {
    refs.articlePublicLinkBtn.addEventListener('click', async (event) => {
      event.stopPropagation();
      if (!state.article || !state.article.publicSlug) {
        showToast('Сделайте страницу публичной, чтобы получить ссылку');
        return;
      }
      const slug = state.article.publicSlug;
      const url = `${window.location.origin}/p/${encodeURIComponent(slug)}`;
      await showPublicLinkModal({ url });
    });
  }
  if (refs.articlePublicToggleBtn) {
    refs.articlePublicToggleBtn.addEventListener('click', async (event) => {
      event.stopPropagation();
      closeArticleMenu();
      if (!state.article || !state.articleId) {
        showToast('Сначала откройте статью');
        return;
      }
      if (!state.currentUser) {
        showToast('Нужно войти в систему');
        return;
      }
      const makePublic = !state.article.publicSlug;
      try {
        const updated = await apiRequest(`/api/articles/${state.articleId}/public`, {
          method: 'POST',
          body: JSON.stringify({ public: makePublic }),
        });
        const slug = updated.publicSlug || null;
        state.article = { ...state.article, publicSlug: slug };
        if (refs.articlePublicToggleBtn) {
          refs.articlePublicToggleBtn.textContent = slug ? 'Отменить доступ по ссылке' : 'Дать доступ по ссылке';
        }
        // Обновляем только хедер (иконка 🌐, updatedAt и т.п.),
        // без полной перерисовки списка блоков.
        updateArticleHeaderUi();
        if (makePublic && slug) {
          const url = `${window.location.origin}/p/${encodeURIComponent(slug)}`;
          await showPublicLinkModal({ url });
        } else if (!makePublic) {
          showToast('Публичный доступ к странице выключен');
        }
      } catch (error) {
        showToast(error.message || 'Не удалось изменить публичный доступ');
      }
    });
  }
  if (refs.exportArticleBtn) {
    refs.exportArticleBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      closeArticleMenu();
      exportCurrentArticleAsHtml();
    });
  }
  if (refs.outlineEditBtn) {
    refs.outlineEditBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      closeArticleMenu();
      openOutlineEditor();
    });
  }
  if (refs.exportCurrentBlockBtn) {
    refs.exportCurrentBlockBtn.addEventListener('click', async (event) => {
      event.preventDefault();
      await exportCurrentBlockAsHtml();
    });
  }
  if (refs.exportAllHtmlZipBtn) {
    refs.exportAllHtmlZipBtn.addEventListener('click', async (event) => {
      event.stopPropagation();
      closeListMenu();
      try {
        showPersistentToast('Готовим резервную копию (ZIP)...');
        const resp = await fetch('/api/export/html-zip', { method: 'GET' });
        if (!resp.ok) {
          hideToast();
          showToast('Не удалось создать резервную копию');
          return;
        }
        // Может прийти пустой ответ (нет статей или ошибка на сервере).
        // Сначала проверяем статус 204 / длину тела.
        if (resp.status === 204) {
          hideToast();
          showToast('Нет страниц для резервной копии');
          return;
        }
        const blob = await resp.blob();
        if (!blob || blob.size === 0) {
          hideToast();
          showToast('Нет данных для резервной копии (пустой архив)');
          return;
        }
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        const disposition = resp.headers.get('Content-Disposition') || '';
        let filename = 'memus-backup.zip';
        const match = disposition.match(/filename=\"?([^\";]+)\"?/i);
        if (match && match[1]) {
          filename = match[1];
        }
        link.href = url;
        link.download = filename;
        link.rel = 'noopener';
        document.body.appendChild(link);
        // Считаем, что загрузка начинается в момент клика по ссылке.
        hideToast();
        link.click();
        document.body.removeChild(link);
        setTimeout(() => URL.revokeObjectURL(url), 0);
        showToast('Резервная копия загружена');
      } catch (error) {
        hideToast();
        showToast(error.message || 'Не удалось создать резервную копию');
      }
    });
  }
  if (refs.importArticleBtn) {
    refs.importArticleBtn.addEventListener('click', async (event) => {
      event.stopPropagation();
      closeListMenu();
      try {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.html,text/html';
        input.multiple = false;
        input.addEventListener('change', async () => {
          const file = input.files && input.files[0];
          if (!file) return;
          try {
            showPersistentToast('Загружаем и обрабатываем HTML...');
            const conflictState = { decision: null, applyToAll: false };
            const article = await importHtmlWithConflicts(file, conflictState, {
              allowApplyToAll: false,
            });
            hideToast();
            if (article && article.id) {
              navigate(routing.article(article.id));
              showToast('Статья импортирована');
            } else {
              showToast('Импорт завершился без результата');
            }
          } catch (error) {
            hideToast();
            showPersistentToast(error.message || 'Не удалось импортировать HTML');
          }
        });
        input.click();
      } catch (error) {
        showToast(error.message || 'Не удалось запустить импорт');
      }
    });
  }
  if (refs.importMarkdownBtn) {
    refs.importMarkdownBtn.addEventListener('click', async (event) => {
      event.stopPropagation();
      closeListMenu();
      try {
        let baseUrl = '';
        try {
          const saved = window.localStorage.getItem('logseqAssetsBaseUrl') || '';
          baseUrl = await showPrompt({
            title: 'Адрес assets для Markdown',
            message:
              'Если в файле есть ссылки вида ../assets/..., укажи базовый URL, где лежат эти файлы (например https://prismatic-salamander-2afe94.netlify.app). '
              + 'Внутри него будут искаться файлы в корне или в подпапке /assets.',
            confirmText: 'Продолжить',
            cancelText: 'Отмена',
            placeholder: 'https://example.netlify.app',
            defaultValue: saved,
          });
        } catch (_) {
          return;
        }
        baseUrl = (baseUrl || '').trim();
        if (baseUrl) {
          try {
            window.localStorage.setItem('logseqAssetsBaseUrl', baseUrl);
          } catch (_) {
            // ignore
          }
        }

        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.md,text/markdown,text/plain';
        input.multiple = false;
        input.addEventListener('change', async () => {
          const file = input.files && input.files[0];
          if (!file) return;
          try {
            showPersistentToast('Загружаем и обрабатываем Markdown...');
            const article = await importArticleFromMarkdown(file, baseUrl);
            hideToast();
            if (article && article.id) {
              navigate(routing.article(article.id));
              showToast('Статья импортирована из Markdown');
            } else {
              showToast('Импорт из Markdown завершился без результата');
            }
          } catch (error) {
            hideToast();
            showPersistentToast(error.message || 'Не удалось импортировать Markdown');
          }
        });
        input.click();
      } catch (error) {
        showToast(error.message || 'Не удалось запустить импорт Markdown');
      }
    });
  }
  if (refs.importBackupFolderBtn) {
    refs.importBackupFolderBtn.addEventListener('click', async (event) => {
      event.stopPropagation();
      closeListMenu();
      try {
        const input = document.createElement('input');
        input.type = 'file';
        input.webkitdirectory = true;
        input.multiple = true;
        input.addEventListener('change', async () => {
          const files = Array.from(input.files || []);
          const htmlFiles = files.filter((f) => f.name && f.name.toLowerCase().endsWith('.html'));
          if (!htmlFiles.length) {
            showToast('В выбранной папке нет HTML‑файлов Memus');
            return;
          }
          const conflictState = { decision: null, applyToAll: false };
          let importedCount = 0;
          showPersistentToast(`Импортируем из резервной копии... (0 / ${htmlFiles.length})`);
          // Последовательно, чтобы не заспамить сервер.
          // eslint-disable-next-line no-restricted-syntax
          for (const file of htmlFiles) {
            // eslint-disable-next-line no-await-in-loop
            const article = await importHtmlWithConflicts(file, conflictState, {
              allowApplyToAll: true,
            });
            if (article && article.id) {
              importedCount += 1;
            }
            showPersistentToast(
              `Импортируем из резервной копии... (${importedCount} / ${htmlFiles.length})`,
            );
          }
          hideToast();
          if (importedCount > 0) {
            showToast(`Импортировано страниц из резервной копии: ${importedCount}`);
            // Обновляем список статей.
            navigate(routing.list);
          } else {
            showToast('Импорт из резервной копии завершился без результата');
          }
        });
        input.click();
      } catch (error) {
        showToast(error.message || 'Не удалось запустить импорт из резервной копии');
      }
    });
  }
  if (refs.importLogseqBtn) {
    refs.importLogseqBtn.addEventListener('click', async (event) => {
      event.stopPropagation();
      closeListMenu();
      try {
        const confirmed = await showConfirm({
          title: 'Импорт из Logseq',
          message:
            'Все существующие страницы с такими же названиями будут удалены и заменены версиями из архива Logseq. Продолжить?',
          confirmText: 'Импортировать',
          cancelText: 'Отмена',
        });
        if (!confirmed) return;

        let baseUrl = '';
        try {
          const saved = window.localStorage.getItem('logseqAssetsBaseUrl') || '';
          baseUrl = await showPrompt({
            title: 'Адрес assets для Logseq',
            message: 'Укажи базовый URL, где лежат assets (например https://prismatic-salamander-2afe94.netlify.app). Внутри него должны быть файлы в папке /assets.',
            confirmText: 'Продолжить',
            cancelText: 'Отмена',
            placeholder: 'https://example.netlify.app',
            defaultValue: saved,
          });
        } catch (_) {
          // Если пользователь закрыл диалог — просто выходим.
          return;
        }
        baseUrl = (baseUrl || '').trim();
        if (!baseUrl) return;
        try {
          window.localStorage.setItem('logseqAssetsBaseUrl', baseUrl);
        } catch (_) {
          // ignore
        }

        showToast('Выберите ZIP-архив Logseq с папкой pages/');
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.zip,application/zip';
        input.multiple = false;
        input.addEventListener('change', async () => {
          const file = input.files && input.files[0];
          if (!file) return;
          try {
            showPersistentToast('Загружаем и обрабатываем архив Logseq...');
            const articles = await importFromLogseqArchive(file, baseUrl);
            hideToast();
            const list = Array.isArray(articles) ? articles : [];
            if (list.length > 0 && list[0].id) {
              navigate(routing.article(list[0].id));
              if (list.length === 1) {
                showToast('Страница импортирована из Logseq');
              } else {
                showToast(`Импортировано страниц из Logseq: ${list.length}`);
              }
            } else {
              showToast('Импорт из Logseq завершился без результата');
            }
          } catch (error) {
            hideToast();
            showPersistentToast(error.message || 'Не удалось импортировать архив Logseq');
          }
        });
        input.click();
      } catch (error) {
        showToast(error.message || 'Не удалось запустить импорт Logseq');
      }
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
    refs.hintToggleBtn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const url = '/help.html';
      const win = window.open(url, '_blank', 'noopener,noreferrer');
      if (!win) {
        // Если браузер заблокировал новое окно — показываем старый поповер.
        toggleHintPopover(event);
      }
    });
  }
  if (refs.sidebarToggle) {
    refs.sidebarToggle.addEventListener('click', toggleSidebarCollapsed);
  }
  // Вынесено из этого файла: логика мобильного сайдбара → `./events/sidebarMobile.js`.
  attachSidebarMobileHandlers();
  if (refs.dragModeToggleBtn) {
    refs.dragModeToggleBtn.addEventListener('click', () => {
      toggleDragMode();
    });
  }
  if (refs.blocksContainer) {
    refs.blocksContainer.addEventListener('click', (event) => {
      if (state.mode !== 'view') return;
      if (!state.article || !Array.isArray(state.article.blocks) || !state.article.blocks.length) return;
      const target = event.target;
      if (target.closest('.block')) return;
      const blocks = refs.blocksContainer.querySelectorAll('.block[data-block-id]');
      if (!blocks.length) return;
      const lastBlockEl = blocks[blocks.length - 1];
      const lastRect = lastBlockEl.getBoundingClientRect();
      // Создаём новый блок, только если клик ниже последнего блока.
      if (event.clientY <= lastRect.bottom + 4) return;
      const lastBlockId = lastBlockEl.getAttribute('data-block-id');
      if (!lastBlockId) return;
      state.currentBlockId = lastBlockId;
      createSibling('after');
    });
  }
  if (refs.articleFilterInput) {
    refs.articleFilterInput.addEventListener('input', handleArticleFilterInput);
  }
  if (refs.sidebarQuickFilterInput) {
    refs.sidebarQuickFilterInput.addEventListener('input', handleArticleFilterInput);
    refs.sidebarQuickFilterInput.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        event.preventDefault();
        refs.sidebarQuickFilterInput.value = '';
        state.articleFilterQuery = '';
         ensureSidebarSelectionVisible();
        renderSidebarArticleList();
        sidebarQuickFilterLastTypedAt = 0;
        return;
      }
      const { key, ctrlKey, altKey, metaKey } = event;
      if (ctrlKey || altKey || metaKey) return;
      if (key.length !== 1) return;
      const now = Date.now();
      const idle = !sidebarQuickFilterLastTypedAt || now - sidebarQuickFilterLastTypedAt > 2000;
      if (idle) {
        // Очищаем поле перед началом нового "слова".
        refs.sidebarQuickFilterInput.value = '';
        state.articleFilterQuery = '';
        renderSidebarArticleList();
      }
      sidebarQuickFilterLastTypedAt = now;
    });
  }
  if (refs.sidebarQuickFilterClear && refs.sidebarQuickFilterInput) {
    refs.sidebarQuickFilterClear.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      refs.sidebarQuickFilterInput.value = '';
      state.articleFilterQuery = '';
      sidebarQuickFilterLastTypedAt = 0;
      ensureSidebarSelectionVisible();
      renderSidebarArticleList();
      refs.sidebarQuickFilterInput.focus();
    });
  }

  if (refs.articleUndoBtn) {
    refs.articleUndoBtn.addEventListener('click', (event) => {
      event.preventDefault();
      handleUndoAction();
    });
  }
  if (refs.articleRedoBtn) {
    refs.articleRedoBtn.addEventListener('click', (event) => {
      event.preventDefault();
      handleRedoAction();
    });
  }
  if (refs.deleteCurrentBlockBtn) {
    refs.deleteCurrentBlockBtn.addEventListener('click', async (event) => {
      event.preventDefault();
      await deleteCurrentBlock();
    });
  }
  if (refs.articleBlockTrashBtn) {
    refs.articleBlockTrashBtn.addEventListener('click', async (event) => {
      event.preventDefault();
      if (!state.article || !state.articleId) {
        showToast('Сначала откройте статью');
        return;
      }
      const list = Array.isArray(state.article.blockTrash) ? state.article.blockTrash : [];
      if (!list.length) {
        showToast('Корзина блоков пуста');
        return;
      }
      try {
        const picked = await showBlockTrashPicker({ items: list });
        if (!picked) return;
        const articleId = state.articleId;
        if (picked.action === 'clear') {
          await apiRequest(`/api/articles/${articleId}/blocks/trash/clear`, {
            method: 'POST',
            body: JSON.stringify({}),
          });
          if (state.article) {
            state.article.blockTrash = [];
          }
          showToast('Корзина блоков очищена');
          return;
        }
        if (!picked.id) return;
        const res = await apiRequest(`/api/articles/${articleId}/blocks/trash/restore`, {
          method: 'POST',
          body: JSON.stringify({ id: picked.id }),
        });
        const restoredId = (res && res.block && res.block.id) || res.blockId || picked.id;
        const article = await loadArticle(articleId, { desiredBlockId: restoredId || null, resetUndoStacks: true });
        state.article = article;
        renderArticle();
        showToast('Блок восстановлен из корзины');
      } catch (error) {
        showToast(error.message || 'Не удалось восстановить блок из корзины');
      }
    });
  }
  if (refs.articleNewBlockBtn) {
    refs.articleNewBlockBtn.addEventListener('click', (event) => {
      event.preventDefault();
      if (!state.article || !state.currentBlockId) {
        showToast('Нет выбранного блока');
        return;
      }
      createSibling('after');
    });
  }
  if (refs.mergeBlocksBtn) {
    refs.mergeBlocksBtn.addEventListener('click', async (event) => {
      event.preventDefault();
      await mergeAllBlocksIntoFirst();
    });
  }
  if (refs.splitBlockBtn) {
    refs.splitBlockBtn.addEventListener('click', async (event) => {
      event.preventDefault();
      if (state.mode !== 'edit' || !state.editingBlockId) {
        showToast('Сначала включите редактирование блока');
        return;
      }
      await splitEditingBlockAtCaret();
    });
  }
  if (refs.insertTableBtn) {
    refs.insertTableBtn.addEventListener('click', (event) => {
      event.preventDefault();
      if (state.mode !== 'edit' || !state.editingBlockId) {
        showToast('Сначала включите редактирование блока');
        return;
      }
      const editable = document.querySelector(
        `.block[data-block-id="${state.editingBlockId}"] .block-text[contenteditable="true"]`,
      );
      if (!editable) {
        showToast('Не удалось найти блок для вставки таблицы');
        return;
      }
      const tableHtml = [
        '<table class="memus-table">',
        '<thead>',
        '<tr>',
        '<th>Заголовок 1</th>',
        '<th>Заголовок 2</th>',
        '</tr>',
        '</thead>',
        '<tbody>',
        '<tr>',
        '<td>Ячейка 1</td>',
        '<td>Ячейка 2</td>',
        '</tr>',
        '</tbody>',
        '</table>',
        // Сразу создаём пустой абзац под таблицей, чтобы в него можно было
        // поставить курсор и ввести текст.
        '<p><br /></p>',
      ].join('');
      insertHtmlAtCaret(editable, tableHtml);
      editable.classList.remove('block-body--empty');
    });
  }
  if (refs.articlesTabBtn) {
    refs.articlesTabBtn.addEventListener('click', () => setTrashMode(false));
  }
  if (refs.trashTabBtn) {
    refs.trashTabBtn.addEventListener('click', () => setTrashMode(true));
  }
  if (refs.telegramLinkBtn) {
    refs.telegramLinkBtn.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      try {
        const data = await createTelegramLinkToken();
        const token = (data && data.token) || '';
        if (!token) {
          showToast('Не удалось получить код привязки Telegram');
          return;
        }
        const cmd = `/link ${token}`;
        const messageLines = [
          'Чтобы привязать этот аккаунт Memus к чату в Telegram:',
          '',
          '1. Откройте чат с ботом.',
          '2. Отправьте ему эту команду:',
          '',
          cmd,
        ];
        await showPrompt({
          title: 'Привязать Telegram',
          message: messageLines.join('\n'),
          defaultValue: cmd,
          placeholder: '/link …',
          confirmText: 'Закрыть',
          cancelText: 'Отмена',
          hideConfirm: true,
        });
      } catch (error) {
        showToast(error.message || 'Не удалось создать код привязки Telegram');
      }
    });
  }
  if (refs.userMenuBtn && refs.userMenu) {
    refs.userMenuBtn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const isOpen = !refs.userMenu.classList.contains('hidden');
      if (isOpen) {
        refs.userMenu.classList.add('hidden');
        refs.userMenuBtn.setAttribute('aria-expanded', 'false');
      } else {
        refs.userMenu.classList.remove('hidden');
        refs.userMenuBtn.setAttribute('aria-expanded', 'true');
        refreshSemanticReindexBtnStatus();
      }
    });
  }
  if (refs.semanticReindexBtn) {
    const labelSpan = refs.semanticReindexBtn.querySelector('.sidebar-user-menu-label');
    if (labelSpan && labelSpan.textContent) {
      semanticReindexBaseLabel = labelSpan.textContent.trim();
    }

    refs.semanticReindexBtn.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();

      if (semanticReindexIsPolling) {
        showToast('Переиндексация уже выполняется');
        return;
      }

      const fullReindex = window.confirm(
        'Переиндексировать семантический поиск:\n\nOK — всё заново (пересчитать все embeddings)\nОтмена — только отсутствующие (быстрее)',
      );
      const reindexMode = fullReindex ? 'all' : 'missing';

      refs.userMenu?.classList.add('hidden');
      refs.userMenuBtn?.setAttribute('aria-expanded', 'false');

      const btn = refs.semanticReindexBtn;
      if (btn) btn.disabled = true;

      const stopPolling = () => {
        semanticReindexIsPolling = false;
        if (semanticReindexPollTimeoutId !== null) {
          clearTimeout(semanticReindexPollTimeoutId);
          semanticReindexPollTimeoutId = null;
        }
        if (btn) btn.disabled = false;
      };

      const renderStatusToast = (task) => {
        if (!task || typeof task !== 'object') {
          showPersistentToast('Переиндексация семантического поиска...', { protect: true });
          return;
        }
        const status = task.status || 'unknown';
        if (status === 'running') {
          const total = Number(task.total || 0);
          const processed = Number(task.processed || 0);
          const failed = Number(task.failed || 0);
          const indexed = Number(task.indexed || 0);
          const parts = [];
          if (total > 0) parts.push(`${processed}/${total}`);
          else parts.push(`${processed}`);
          parts.push(`готово: ${indexed}`);
          if (failed) parts.push(`ошибки: ${failed}`);
          showPersistentToast(`Переиндексация… ${parts.join(' • ')}`, { protect: true });
          return;
        }
        if (status === 'cooldown') {
          const remaining = Number(task.cooldownRemainingSeconds || 0);
          if (remaining > 0) {
            const mins = Math.ceil(remaining / 60);
            showToast(`Слишком часто: попробуйте через ~${mins} мин`);
          } else {
            showToast('Слишком часто: попробуйте позже');
          }
          return;
        }
        if (status === 'completed') {
          showToast(`Индекс обновлён: ${task.indexed || 0} блоков`);
          return;
        }
        if (status === 'cancelled') {
          showToast('Переиндексация отменена');
          return;
        }
        if (status === 'failed') {
          showToast(task.error || 'Переиндексация завершилась с ошибкой');
          return;
        }
        showToast(`Переиндексация: ${status}`);
      };

      const pollStatus = async () => {
        try {
          const response = await fetch('/api/search/semantic/reindex/status', {
            method: 'GET',
            credentials: 'include',
          });
          if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new Error(text || response.statusText);
          }
          const task = await response.json();
          if (!task || task.status === 'idle') {
            hideToast({ force: true });
            showToast('Переиндексация не запущена');
            stopPolling();
            return;
          }
          if (task.status === 'running') {
            renderStatusToast(task);
            updateSemanticReindexBtnLabel(task);
            semanticReindexPollTimeoutId = setTimeout(pollStatus, 1000);
            return;
          }
          hideToast({ force: true });
          renderStatusToast(task);
          updateSemanticReindexBtnLabel(task);
          stopPolling();
        } catch (error) {
          hideToast({ force: true });
          showToast(error.message || 'Не удалось получить статус переиндексации');
          stopPolling();
        }
      };

      try {
        const response = await fetch('/api/search/semantic/reindex', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: reindexMode }),
        });
        if (!response.ok) {
          const text = await response.text().catch(() => '');
          throw new Error(text || response.statusText);
        }
        const task = await response.json();
        if (task && task.status === 'cooldown') {
          renderStatusToast(task);
          stopPolling();
          return;
        }
        semanticReindexIsPolling = true;
        renderStatusToast(task);
        updateSemanticReindexBtnLabel(task);
        await pollStatus();
      } catch (error) {
        hideToast({ force: true });
        showToast(error.message || 'Не удалось переиндексировать семантический поиск');
        stopPolling();
      }
    });
  }
  if (refs.telegramBotOpenBtn) {
    refs.telegramBotOpenBtn.addEventListener('click', () => {
      try {
        window.open('https://t.me/Memus_pro_bot', '_blank', 'noopener,noreferrer');
      } catch {
        window.location.href = 'https://t.me/Memus_pro_bot';
      }
    });
  }
  if (refs.telegramFeedbackBotOpenBtn) {
    refs.telegramFeedbackBotOpenBtn.addEventListener('click', () => {
      try {
        window.open('https://t.me/Memus_feedback_bot', '_blank', 'noopener,noreferrer');
      } catch {
        window.location.href = 'https://t.me/Memus_feedback_bot';
      }
    });
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
    if (refs.userMenu && refs.userMenuBtn) {
      const target = event.target;
      if (
        refs.userMenu.classList.contains('hidden') ||
        refs.userMenu.contains(target) ||
        refs.userMenuBtn.contains(target)
      ) {
        return;
      }
      refs.userMenu.classList.add('hidden');
      refs.userMenuBtn.setAttribute('aria-expanded', 'false');
    }
  });
}
