import { state, isHintVisible } from './state.js';
import { refs } from './refs.js';
import { handleUndoAction, handleRedoAction, clearPendingTextPreview } from './undo.js';
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
  extractBlockSections,
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
import {
  apiRequest,
  fetchArticleHistory,
  createArticleVersion,
  fetchArticleVersions,
  fetchArticleVersion,
  restoreArticleVersion,
  importArticleFromHtml,
  importArticleFromMarkdown,
  importFromLogseqArchive,
  moveArticlePosition,
  indentArticleApi,
  outdentArticleApi,
  createTelegramLinkToken,
} from './api.js';
import { getCachedArticlesIndex } from './offline/cache.js';
import { resetOfflineCacheForCurrentUser } from './offline/index.js';
import { showToast, showPersistentToast, hideToast } from './toast.js';
import { insertHtmlAtCaret, htmlToLines } from './utils.js';
import {
  showPrompt,
  showConfirm,
  showImportConflictDialog,
  showPublicLinkModal,
  showBlockTrashPicker,
  showVersionsPicker,
  showVersionCompareTargetPicker,
  showVersionDiffModal,
  showBlockHistoryModal,
  showArticleHistoryModal,
} from './modal.js';
import { loadArticle } from './article.js';
import {
  getMediaProgressForArticle,
  isMediaPrefetchPaused,
  resetFailedMediaAssets,
  startMediaPrefetchLoop,
  toggleMediaPrefetchPaused,
} from './offline/media.js';
import { setMediaPrefetchPaused } from './offline/media.js';
import { getOfflineCoverageSummary } from './offline/status.js';
import { startBackgroundFullPull, getBackgroundFullPullStatus } from './offline/sync.js';
import { countOutbox } from './offline/outbox.js';
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

const SIDEBAR_SEARCH_VIEW_STORAGE_KEY = 'ttree_sidebar_search_view_v1';
let mediaStatusTimerId = null;
let mediaStatusInFlight = false;

function loadOutlineEditorModule() {
  return import('./outline/editor.js');
}

function loadExporterModule() {
  return import('./exporter.js');
}

function normalizeSidebarSearchView(value) {
  return value === 'search' ? 'search' : 'list';
}

function loadSidebarSearchViewFromStorage() {
  try {
    return normalizeSidebarSearchView(localStorage.getItem(SIDEBAR_SEARCH_VIEW_STORAGE_KEY) || '');
  } catch (_) {
    return 'list';
  }
}

function saveSidebarSearchViewToStorage() {
  try {
    localStorage.setItem(SIDEBAR_SEARCH_VIEW_STORAGE_KEY, state.sidebarSearchView || 'list');
  } catch (_) {
    /* ignore */
  }
}

function updateSidebarSearchViewUi() {
  const view = normalizeSidebarSearchView(state.sidebarSearchView);
  const isSearch = view === 'search';
  const nextLabel = isSearch ? 'Фильтр' : 'Поиск';

  if (refs.sidebarSearchViewToggle) {
    refs.sidebarSearchViewToggle.dataset.view = view;
    const labelEl = refs.sidebarSearchViewToggle.querySelector('span') || refs.sidebarSearchViewToggle;
    // В кнопке показываем НЕ текущий режим, а следующий (что будет после клика).
    labelEl.textContent = nextLabel;
    const title = isSearch
      ? 'Переключить в режим фильтра статей'
      : 'Переключить в режим поиска';
    refs.sidebarSearchViewToggle.setAttribute('title', title);
    refs.sidebarSearchViewToggle.setAttribute('aria-label', title);
    // Активная подсветка = сейчас в режиме поиска.
    refs.sidebarSearchViewToggle.classList.toggle('search-panel__toggle--active', isSearch);
  }

  if (refs.searchModeToggle) refs.searchModeToggle.classList.toggle('hidden', !isSearch);
  if (!isSearch) {
    hideSearchResults();
    if (refs.ragOpenBtn) refs.ragOpenBtn.classList.add('hidden');
  }

  if (refs.searchInput) {
    refs.searchInput.placeholder = isSearch
      ? state.searchMode === 'semantic'
        ? 'Семантический поиск...'
        : 'Поиск...'
      : 'Фильтр статей…';
  }
}

function setSidebarSearchView(nextView, { persist = true } = {}) {
  const normalized = normalizeSidebarSearchView(nextView);
  if (state.sidebarSearchView === normalized) return;

  state.sidebarSearchView = normalized;
  if (persist) saveSidebarSearchViewToStorage();

  // Переключение смысла одного поля: сбрасываем неактуальные состояния.
  if (state.sidebarSearchView === 'list') {
    state.searchQuery = '';
    state.searchResults = [];
    state.searchError = '';
    state.searchLoading = false;
    state.searchRequestId = 0;
  } else {
    state.articleFilterQuery = '';
    renderSidebarArticleList();
    ensureSidebarSelectionVisible();
  }

  sidebarQuickFilterLastTypedAt = 0;
  updateSidebarSearchViewUi();

  if (refs.searchInput) {
    refs.searchInput.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

function outlineDocJsonToIndexTextMap(docJson) {
  const map = new Map();
  const order = [];

  const normalize = (value) =>
    String(value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\r\n/g, '\n');

  const joinNonEmpty = (parts, sep = '\n') => parts.map((x) => normalize(x)).filter(Boolean).join(sep);

  const renderNodeText = (node) => {
    if (!node) return '';
    if (Array.isArray(node)) return node.map(renderNodeText).join('');

    if (node.type === 'text') return normalize(node.text || '');
    if (node.type === 'hardBreak') return '\n';

    if (node.type === 'table') {
      const rows = [];
      (node.content || []).forEach((rowNode) => {
        if (rowNode?.type !== 'tableRow') return;
        const cells = [];
        (rowNode.content || []).forEach((cellNode) => {
          if (!cellNode || (cellNode.type !== 'tableCell' && cellNode.type !== 'tableHeader')) return;
          cells.push(renderNodeText(cellNode).trim());
        });
        rows.push(cells.join('\t'));
      });
      return `${rows.join('\n')}\n`;
    }

    const children = Array.isArray(node.content) ? node.content : [];
    const inner = children.map(renderNodeText).join('');

    if (node.type === 'paragraph' || node.type === 'heading') return `${inner}\n`;

    if (node.type === 'bulletList') {
      const items = children
        .filter((x) => x?.type === 'listItem')
        .map((item) => {
          const t = renderNodeText(item).trimEnd();
          if (!t) return '';
          const lines = t.split('\n');
          lines[0] = `- ${lines[0]}`;
          return lines.join('\n');
        })
        .filter(Boolean);
      return `${items.join('\n')}\n`;
    }

    if (node.type === 'orderedList') {
      let idx = 1;
      const items = children
        .filter((x) => x?.type === 'listItem')
        .map((item) => {
          const t = renderNodeText(item).trimEnd();
          if (!t) return '';
          const lines = t.split('\n');
          lines[0] = `${idx}. ${lines[0]}`;
          idx += 1;
          return lines.join('\n');
        })
        .filter(Boolean);
      return `${items.join('\n')}\n`;
    }

    return inner;
  };

  const visit = (node) => {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }

    if (node.type === 'outlineSection') {
      const id = String(node?.attrs?.id || node?.attrs?.sectionId || '');
      const headingNode = (node.content || []).find((x) => x?.type === 'outlineHeading') || null;
      const bodyNode = (node.content || []).find((x) => x?.type === 'outlineBody') || null;
      const childrenNode = (node.content || []).find((x) => x?.type === 'outlineChildren') || null;

      const titlePlain = normalize(renderNodeText(headingNode)).trim();
      const bodyPlain = normalize(renderNodeText(bodyNode)).trim();
      const indexText = joinNonEmpty([titlePlain, bodyPlain], '\n').trim();

      if (id) {
        map.set(id, { indexText, label: titlePlain || id });
        order.push(id);
      }
      if (childrenNode?.content) visit(childrenNode.content);
      return;
    }

    if (node.content) visit(node.content);
  };

  visit(docJson?.content || []);
  return { map, order };
}

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
  if (state.sidebarSearchView !== 'list') return false;
  if (!refs.sidebar || !refs.searchInput) return false;
  // Работает только если виден сайдбар (колонка статей).
  if (refs.sidebar.classList.contains('hidden')) return false;

  const input = refs.searchInput;

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
  state.sidebarSearchView = loadSidebarSearchViewFromStorage();
  updateSidebarSearchViewUi();

  const refreshMediaStatusOnce = async () => {
    if (mediaStatusInFlight) return;
    mediaStatusInFlight = true;
    try {
      const paused = isMediaPrefetchPaused();
      state.mediaPrefetchPaused = paused;
      let label = '';
      try {
        const { total, ok, error } = await getMediaProgressForArticle(state.articleId);
        if (total > 0) {
          label = `Медиа: ${ok}/${total}`;
          if (error > 0) label += `, ошибок: ${error}`;
        }
      } catch {
        // offline db может быть недоступна в этом браузере/профиле
      }
      if (!label && paused) label = 'Медиа: пауза';
      if (label && paused) label += ' (пауза)';
      state.mediaStatusText = label;
      updateArticleHeaderUi();
    } finally {
      mediaStatusInFlight = false;
    }
  };

  const startMediaStatusPolling = () => {
    if (mediaStatusTimerId) return;
    if (!refs.mediaStatusText && !refs.mediaPrefetchToggleBtn) return;
    refreshMediaStatusOnce().catch(() => {});
    mediaStatusTimerId = window.setInterval(() => {
      refreshMediaStatusOnce().catch(() => {});
    }, 2000);
  };

  startMediaStatusPolling();
  let offlineStatusInFlight = false;
  let lastOfflineInitWarnAt = 0;
  let lastOfflineUiLogAt = 0;
  let syncStatusInFlight = false;
  const offlineDebugEnabled = () => {
    try {
      return window?.localStorage?.getItem?.('ttree_debug_offline_v1') === '1';
    } catch {
      return false;
    }
  };
  const shouldSendOfflineUiLog = () => {
    try {
      const ua = String(navigator?.userAgent || '');
      // Only auto-log on mobile Huawei browser where DevTools are not available.
      if (!/HuaweiBrowser/i.test(ua)) return false;
    } catch {
      return false;
    }
    const now = Date.now();
    if (now - lastOfflineUiLogAt < 15_000) return false;
    lastOfflineUiLogAt = now;
    return true;
  };
  const postClientLog = (kind, data) => {
    try {
      fetch('/api/client/log', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, data }),
      }).catch(() => {});
    } catch {
      // ignore
    }
  };
  const refreshOfflineStatusOnce = async () => {
    if (offlineStatusInFlight) return;
    if (!refs.sidebarSyncStatusPill && !refs.offlineStatusLabel && !refs.offlineFetchBtn && !refs.offlineRepairBtn) return;
    offlineStatusInFlight = true;
    try {
      if (shouldSendOfflineUiLog()) {
        postClientLog('offline.ui.tick', {
          t: new Date().toISOString(),
          serverStatus: String(state.serverStatus || ''),
          serverStatusText: String(state.serverStatusText || ''),
          offlineReady: Boolean(state.offlineReady),
          offlineInitStatus: String(state.offlineInitStatus || ''),
          offlineInitError: String(state.offlineInitError || ''),
          offlineInitStartedAt: state.offlineInitStartedAt || null,
          buildId: (() => {
            try {
              return String(window.__BUILD_ID__ || '');
            } catch {
              return '';
            }
          })(),
          hasOfflineStatusLabel: Boolean(refs.offlineStatusLabel),
        });
      }

      const setBtnState = (stateId, title) => {
        if (refs.sidebarSyncStatusPill) {
          refs.sidebarSyncStatusPill.dataset.offline = stateId;
          if (title) {
            refs.sidebarSyncStatusPill.dataset.offlineTitle = title;
            refs.sidebarSyncStatusPill.title = title;
          }
        }
      };

      // Server status has higher priority than offline cache readiness: do not confuse "not logged in" with "offline".
      if (state.serverStatus === 'auth') {
        const label = 'Требуется вход';
        if (refs.offlineStatusLabel) refs.offlineStatusLabel.textContent = label;
        if (refs.offlineFetchBtn) refs.offlineFetchBtn.classList.add('hidden');
        if (refs.offlineRepairBtn) refs.offlineRepairBtn.classList.add('hidden');
        setBtnState('auth', `Аккаунт · ${label}`);
        return;
      }
      const isOnline = (() => {
        try {
          return navigator?.onLine !== false;
        } catch {
          return true;
        }
      })();
      // If offline cache is ready, still show offline coverage/progress even when the server is down/offline.
      // Only show "server down" as the primary status when offline features are unavailable.
      if (state.serverStatus === 'down' && !state.offlineReady) {
        const label = isOnline ? 'Нет доступа к серверу' : 'Нет интернета';
        if (refs.offlineStatusLabel) refs.offlineStatusLabel.textContent = label;
        if (refs.offlineFetchBtn) refs.offlineFetchBtn.classList.add('hidden');
        if (refs.offlineRepairBtn) refs.offlineRepairBtn.classList.add('hidden');
        setBtnState('off', `Аккаунт · ${label}`);
        if (shouldSendOfflineUiLog()) {
          postClientLog('offline.ui.not_ready', {
            t: new Date().toISOString(),
            reason: 'server_down_no_offline',
            serverStatus: state.serverStatus,
            offlineReady: Boolean(state.offlineReady),
            offlineInitStatus: String(state.offlineInitStatus || ''),
            offlineInitError: String(state.offlineInitError || ''),
            onLine: (() => {
              try {
                return navigator?.onLine !== false;
              } catch {
                return null;
              }
            })(),
            buildId: (() => {
              try {
                return String(window.__BUILD_ID__ || '');
              } catch {
                return '';
              }
            })(),
          });
        }
        return;
      }

      if (!state.offlineReady) {
        const initStatus = String(state.offlineInitStatus || 'idle');
        const errText = String(state.offlineInitError || '').trim();
        if (initStatus === 'initializing') {
          const startedAt = Number(state.offlineInitStartedAt || 0) || 0;
          const now = Date.now();
          const ms = startedAt ? now - startedAt : 0;
          if (ms > 8000 && now - lastOfflineInitWarnAt > 8000) {
            lastOfflineInitWarnAt = now;
            try {
              if (offlineDebugEnabled()) {
                // eslint-disable-next-line no-console
                console.warn('[offline] still initializing', { ms });
              }
            } catch {
              // ignore
            }
          }
          if (refs.offlineStatusLabel) refs.offlineStatusLabel.textContent = 'Оффлайн: инициализация…';
          if (refs.offlineFetchBtn) refs.offlineFetchBtn.classList.add('hidden');
          if (refs.offlineRepairBtn) refs.offlineRepairBtn.classList.add('hidden');
          setBtnState('loading', 'Аккаунт · Оффлайн: инициализация…');
          if (shouldSendOfflineUiLog()) {
            postClientLog('offline.ui.not_ready', {
              t: new Date().toISOString(),
              reason: 'initializing',
              initStatus,
              offlineInitError: errText,
              offlineInitStartedAt: state.offlineInitStartedAt || null,
              buildId: (() => {
                try {
                  return String(window.__BUILD_ID__ || '');
                } catch {
                  return '';
                }
              })(),
            });
          }
          return;
        }
        const label = errText ? `Оффлайн: недоступно (${errText})` : 'Оффлайн: недоступно';
        if (refs.offlineStatusLabel) refs.offlineStatusLabel.textContent = label;
        if (refs.offlineFetchBtn) refs.offlineFetchBtn.classList.add('hidden');
        if (refs.offlineRepairBtn) {
          const btn = refs.offlineRepairBtn;
          const labelEl = btn.querySelector('.sidebar-user-menu-label');
          btn.classList.remove('hidden');
          if (labelEl) {
            if (initStatus === 'quota') labelEl.textContent = 'Освободить место';
            else if (initStatus === 'blocked') labelEl.textContent = 'Перезагрузить (закрыть другие вкладки)';
            else if (initStatus === 'timeout') labelEl.textContent = 'Перезагрузить';
            else if (initStatus === 'unavailable') labelEl.textContent = 'Подробнее';
            else labelEl.textContent = 'Сбросить оффлайн‑кэш';
          }
        }
        setBtnState('off', `Аккаунт · ${label}`);
        if (shouldSendOfflineUiLog()) {
          postClientLog('offline.ui.not_ready', {
            t: new Date().toISOString(),
            reason: 'not_ready',
            initStatus,
            offlineInitError: errText,
            serverStatus: state.serverStatus,
            onLine: (() => {
              try {
                return navigator?.onLine !== false;
              } catch {
                return null;
              }
            })(),
            buildId: (() => {
              try {
                return String(window.__BUILD_ID__ || '');
              } catch {
                return '';
              }
            })(),
          });
        }
        return;
      }

      let summary = null;
      try {
        summary = await Promise.race([
          getOfflineCoverageSummary(),
          // Some mobile browsers can be extremely slow at large IDB scans.
          // Never block UI status on a full coverage calculation.
          new Promise((resolve) => setTimeout(() => resolve(null), 700)),
        ]);
      } catch {
        summary = null;
      }
      if (!summary) {
        if (refs.offlineStatusLabel) refs.offlineStatusLabel.textContent = 'Оффлайн: …';
        if (refs.offlineFetchBtn) refs.offlineFetchBtn.classList.remove('hidden');
        if (refs.offlineRepairBtn) refs.offlineRepairBtn.classList.add('hidden');
        setBtnState('loading', 'Аккаунт · Оффлайн: …');
        if (shouldSendOfflineUiLog()) {
          postClientLog('offline.ui.summary_pending', {
            t: new Date().toISOString(),
            serverStatus: state.serverStatus,
            offlineReady: Boolean(state.offlineReady),
            buildId: (() => {
              try {
                return String(window.__BUILD_ID__ || '');
              } catch {
                return '';
              }
            })(),
          });
        }
        return;
      }

      const articlesTotal = Number(summary.articles?.total || 0);
      const articlesWithDoc = Number(summary.articles?.withDoc || 0);
      const mediaTotal = Number(summary.media?.total || 0);
      const mediaOk = Number(summary.media?.ok || 0);
      const mediaError = Number(summary.media?.error || 0);
      const mediaErrorKinds = summary.media?.errorKinds || null;

      const articlesOk = articlesTotal === 0 ? true : articlesWithDoc >= articlesTotal;
      const mediaOkAll = mediaTotal === 0 ? true : mediaOk >= mediaTotal;
      const ok = articlesOk && mediaOkAll && mediaError === 0;
      const missingArticles = Math.max(0, articlesTotal - articlesWithDoc);
      const missingMedia = Math.max(0, mediaTotal - mediaOk);

      try {
        state.offlineArticlesTotal = Number.isFinite(articlesTotal) ? Math.max(0, articlesTotal) : null;
        state.offlineArticlesWithDoc = Number.isFinite(articlesWithDoc) ? Math.max(0, articlesWithDoc) : null;
      } catch {
        // ignore
      }

      const needsLoginForMedia =
        missingMedia > 0 &&
        mediaErrorKinds &&
        Number(mediaErrorKinds.noAccess || 0) > 0 &&
        navigator.onLine;

      const pull = getBackgroundFullPullStatus?.() || null;
      const pullRunning = Boolean(pull?.running);
      const pullProcessed = Number(pull?.processed || 0);
      const pullTotal = Number(pull?.total || 0);
      const pullErrors = Number(pull?.errors || 0);
      const pullLastError = String(pull?.lastError || '').trim();

      if (ok) {
        if (refs.offlineStatusLabel) refs.offlineStatusLabel.textContent = 'Оффлайн режим OK';
        if (refs.offlineFetchBtn) refs.offlineFetchBtn.classList.add('hidden');
        if (refs.offlineRepairBtn) refs.offlineRepairBtn.classList.add('hidden');
        setBtnState('ok', 'Аккаунт · Оффлайн OK');
      } else {
        const parts = [];
        if (pullRunning) {
          parts.push(`докачка: ${pullProcessed}/${pullTotal || '…'}`);
          if (pullErrors > 0) parts.push(`ошибок: ${pullErrors}`);
        } else if (pullLastError) {
          parts.push(`ошибка: ${pullLastError}`);
        }
        if (needsLoginForMedia) {
          parts.push('нужно войти, чтобы докачать картинки');
        }

        // Show user-meaningful progress (articles first) in a stable format.
        // Even when all articles are already cached, keep the "статьи X/Y" part so the label doesn't "jump"
        // between formats (this is user-facing, not a debugging counter).
        if (articlesTotal > 0) parts.push(`статьи: ${articlesWithDoc}/${articlesTotal}`);
        if (mediaTotal > 0) parts.push(`картинки: ${mediaOk}/${mediaTotal}`);

        // Expose *why* missing media happens, but keep it short.
        if (missingMedia > 0 && mediaErrorKinds) {
          const nf = Number(mediaErrorKinds.notFound || 0);
          const na = Number(mediaErrorKinds.noAccess || 0);
          const net = Number(mediaErrorKinds.network || 0);
          if (nf > 0) parts.push(`битые: ${nf}`);
          else if (na > 0) parts.push(`нет доступа: ${na}`);
          else if (net > 0) parts.push(`ошибкок сети: ${net}`);
        }

        const label = parts.length ? `Оффлайн: ${parts.join(' · ')}` : 'Оффлайн: докачка…';
        if (refs.offlineStatusLabel) refs.offlineStatusLabel.textContent = label;
        if (refs.offlineFetchBtn) {
          // Button only when it can actually help.
          const paused = Boolean(state.mediaPrefetchPaused);
          const show =
            !pullRunning &&
            !needsLoginForMedia &&
            (paused || missingArticles > 0 || missingMedia > 0);
          refs.offlineFetchBtn.classList.toggle('hidden', !show);
          try {
            const labelEl = refs.offlineFetchBtn.querySelector('.sidebar-user-menu-label');
            if (labelEl) {
              if (paused) labelEl.textContent = 'Возобновить докачку';
              else if (missingMedia > 0 && mediaError > 0) labelEl.textContent = 'Повторить докачку';
              else labelEl.textContent = 'Докачать сейчас';
            }
          } catch {
            // ignore
          }
        }
        if (refs.offlineRepairBtn) refs.offlineRepairBtn.classList.add('hidden');
        setBtnState('loading', `Аккаунт · ${label}`);
      }
    } finally {
      offlineStatusInFlight = false;
    }
  };

  const refreshSidebarSyncStatusOnce = async () => {
    if (syncStatusInFlight) return;
    if (!refs.sidebarSyncStatusPill) return;
    syncStatusInFlight = true;
    try {
      const pill = refs.sidebarSyncStatusPill;
      let net = 'offline';
      if (state.serverStatus === 'auth') net = 'auth';
      else if (state.serverStatus === 'ok') net = 'online';
      else {
        // `serverStatus` is set based on a real server request; while it's unknown/down,
        // still show a best-effort network hint based on the browser signal.
        try {
          net = navigator?.onLine === false ? 'offline' : 'online';
        } catch {
          net = 'offline';
        }
      }

      // Never block the UI on IndexedDB init: show network state immediately,
      // and only append outbox count when offline DB is ready.
      let outboxN = null;
      if (state.offlineReady) {
        try {
          outboxN = await Promise.race([
            countOutbox(),
            new Promise((resolve) => setTimeout(() => resolve(null), 300)),
          ]);
          if (!Number.isFinite(Number(outboxN))) outboxN = null;
          outboxN = outboxN == null ? null : Number(outboxN) || 0;
        } catch {
          outboxN = null;
        }
      }
      try {
        state.outboxCount = outboxN == null ? null : Number(outboxN) || 0;
      } catch {
        // ignore
      }

      const sync = outboxN != null && outboxN > 0 ? 'dirty' : 'clean';
      let text = '';
      if (net === 'auth') text = outboxN != null && outboxN > 0 ? `Вход · ${outboxN}` : 'Вход';
      else if (net === 'online') text = outboxN != null && outboxN > 0 ? `Синхр… ${outboxN}` : 'Онлайн';
      else text = outboxN != null && outboxN > 0 ? `Оффлайн · ${outboxN}` : 'Оффлайн';

      pill.dataset.net = net;
      pill.dataset.sync = sync;
      pill.textContent = text;
      const offlineTitle = String(pill.dataset.offlineTitle || '').trim();
      const syncTitle =
        outboxN != null && outboxN > 0
          ? `В очереди изменений: ${outboxN}`
          : net === 'online'
            ? 'Онлайн: синхронизировано'
            : net === 'auth'
              ? 'Требуется вход'
              : 'Оффлайн: изменений нет';
      pill.title = offlineTitle ? `${syncTitle} · ${offlineTitle}` : syncTitle;

      if (refs.syncMenuStatusLabel) {
        refs.syncMenuStatusLabel.textContent =
          net === 'online' ? 'Статус: онлайн' : net === 'auth' ? 'Статус: требуется вход' : 'Статус: оффлайн';
      }
      if (refs.syncMenuArticlesLabel) {
        const have = state.offlineArticlesWithDoc;
        const total = state.offlineArticlesTotal;
        if (net === 'auth') {
          refs.syncMenuArticlesLabel.textContent = 'Статьи: требуется вход';
        } else if (Number.isFinite(total) && total > 0 && Number.isFinite(have)) {
          const pct = Math.max(0, Math.min(100, Math.round((Number(have) / Number(total)) * 100)));
          refs.syncMenuArticlesLabel.textContent = `Статьи: ${have}/${total} (${pct}%)`;
        } else {
          refs.syncMenuArticlesLabel.textContent = 'Статьи: —';
        }
      }
      if (refs.syncMenuOutboxLabel) {
        refs.syncMenuOutboxLabel.textContent =
          outboxN == null ? 'Очередь: —' : outboxN > 0 ? `Очередь: ${outboxN}` : 'Очередь: пусто';
      }
    } finally {
      syncStatusInFlight = false;
    }
  };

  refreshOfflineStatusOnce().catch(() => {});
  refreshSidebarSyncStatusOnce().catch(() => {});
  window.setInterval(() => {
    refreshOfflineStatusOnce().catch(() => {});
    refreshSidebarSyncStatusOnce().catch(() => {});
  }, 4000);

  window.addEventListener('offline-full-pull-status', () => {
    refreshOfflineStatusOnce().catch(() => {});
  });

  window.addEventListener('media-prefetch-paused', () => {
    refreshMediaStatusOnce().catch(() => {});
    refreshOfflineStatusOnce().catch(() => {});
    refreshSidebarSyncStatusOnce().catch(() => {});
  });
  window.addEventListener('online', () => {
    refreshMediaStatusOnce().catch(() => {});
    refreshOfflineStatusOnce().catch(() => {});
    refreshSidebarSyncStatusOnce().catch(() => {});
  });
  window.addEventListener('offline', () => {
    refreshMediaStatusOnce().catch(() => {});
    refreshOfflineStatusOnce().catch(() => {});
    refreshSidebarSyncStatusOnce().catch(() => {});
  });
  window.addEventListener('offline-outbox-changed', () => {
    refreshSidebarSyncStatusOnce().catch(() => {});
  });

  if (refs.sidebarSyncStatusPill && refs.syncMenu) {
    refs.sidebarSyncStatusPill.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const isOpen = !refs.syncMenu.classList.contains('hidden');
      try {
        refs.userMenu?.classList.add('hidden');
        refs.userMenuBtn?.setAttribute('aria-expanded', 'false');
      } catch {
        // ignore
      }
      if (isOpen) {
        refs.syncMenu.classList.add('hidden');
        refs.sidebarSyncStatusPill.setAttribute('aria-expanded', 'false');
      } else {
        refs.syncMenu.classList.remove('hidden');
        refs.sidebarSyncStatusPill.setAttribute('aria-expanded', 'true');
        refreshSidebarSyncStatusOnce().catch(() => {});
        refreshOfflineStatusOnce().catch(() => {});
      }
    });
  }

  if (refs.mediaPrefetchToggleBtn) {
    refs.mediaPrefetchToggleBtn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleMediaPrefetchPaused();
      refreshMediaStatusOnce().catch(() => {});
    });
  }

  if (refs.offlineFetchBtn) {
    refs.offlineFetchBtn.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      try {
        if (!state.offlineReady) {
          showToast('Offline база недоступна в этом браузере');
          return;
        }
        setMediaPrefetchPaused(false);
        // If some images reached retry limit, "Докачать" should reset and try again.
        resetFailedMediaAssets({ maxFailCountOnly: true }).catch(() => {});
        // Media prefetch can run even when server sync is disabled (e.g. user is not authenticated right now).
        try {
          startMediaPrefetchLoop();
        } catch {
          // ignore
        }
        startBackgroundFullPull({ force: true });
        showToast('Докачиваем офлайн‑данные в фоне…');
        refs.syncMenu?.classList.add('hidden');
        refs.sidebarSyncStatusPill?.setAttribute('aria-expanded', 'false');
        refreshOfflineStatusOnce().catch(() => {});
      } catch (err) {
        showToast(err?.message || 'Не удалось запустить докачку');
      }
    });
  }

  if (refs.offlineRepairBtn) {
    refs.offlineRepairBtn.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const initStatus = String(state.offlineInitStatus || '').trim();
      if (initStatus === 'blocked' || initStatus === 'timeout') {
        try {
          window.location.reload();
        } catch {
          // ignore
        }
        return;
      }
      if (initStatus === 'quota') {
        showToast('Мало места для локального кэша. Освободите место в браузере/ОС или очистите кэш картинок.');
        return;
      }
      if (initStatus === 'unavailable') {
        showToast(String(state.offlineInitError || 'Оффлайн недоступен в этом браузере'));
        return;
      }
      try {
        showToast('Сбрасываем оффлайн‑кэш…');
        await resetOfflineCacheForCurrentUser();
      } catch {
        // ignore
      }
      try {
        window.location.reload();
      } catch {
        // ignore
      }
    });
  }

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

  const handleUnifiedSearchInput = (event) => {
    const view = normalizeSidebarSearchView(state.sidebarSearchView);
    if (view === 'search') {
      handleSearchInput(event);
      return;
    }
    // list mode: treat the same input as filter for the sidebar article list.
    state.searchQuery = '';
    state.searchResults = [];
    state.searchError = '';
    state.searchLoading = false;
    state.searchRequestId = 0;
    hideSearchResults();
    if (refs.ragOpenBtn) refs.ragOpenBtn.classList.add('hidden');
    handleArticleFilterInput(event);
  };

  if (refs.searchInput) {
    refs.searchInput.addEventListener('input', handleUnifiedSearchInput);
    refs.searchInput.addEventListener('focus', () => {
      if (state.sidebarSearchView === 'search' && state.searchQuery.trim()) {
        renderSearchResults();
      }
    });
  }
  if (refs.sidebarSearchViewToggle) {
    refs.sidebarSearchViewToggle.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const next = state.sidebarSearchView === 'search' ? 'list' : 'search';
      setSidebarSearchView(next);
      if (refs.searchInput) {
        refs.searchInput.focus({ preventScroll: true });
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
    updateSidebarSearchViewUi();
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
    refs.exportArticleBtn.addEventListener('click', async (event) => {
      event.stopPropagation();
      closeArticleMenu();
      try {
        const { exportCurrentArticleAsHtml } = await loadExporterModule();
        exportCurrentArticleAsHtml?.();
      } catch {
        showToast('Не удалось экспортировать');
      }
    });
  }
  if (refs.saveVersionBtn) {
    refs.saveVersionBtn.addEventListener('click', async (event) => {
      event.stopPropagation();
      closeArticleMenu();
      if (!state.articleId) return;
      try {
        const label = await showPrompt({
          title: 'Сохранить версию',
          message: 'Название версии (можно пустым)',
          placeholder: 'Например: перед рефакторингом',
          confirmText: 'Сохранить',
          cancelText: 'Отмена',
          allowEmpty: true,
        });
        // Если пользователь отменил — просто выходим.
        if (label === null) return;

        showPersistentToast('Сохраняем версию…');
        await createArticleVersion(state.articleId, (label || '').trim() || null);
        hideToast();
        showToast('Версия сохранена');
      } catch (error) {
        hideToast();
        showToast(error?.message || 'Не удалось сохранить версию');
      }
    });
  }
  if (refs.versionsBtn) {
    refs.versionsBtn.addEventListener('click', async (event) => {
      event.stopPropagation();
      closeArticleMenu();
      if (!state.articleId) return;
      if (state.article?.encrypted) {
        showToast('Сравнение версий пока недоступно для зашифрованных статей');
        return;
      }
      try {
        showPersistentToast('Загружаем версии…');
        const result = await fetchArticleVersions(state.articleId);
        hideToast();
        const versions = Array.isArray(result?.versions) ? result.versions : [];
        const choiceRaw = await showVersionsPicker({ versions });
        if (!choiceRaw) return;
        const choice =
          typeof choiceRaw === 'string'
            ? { action: 'restore', versionId: choiceRaw }
            : choiceRaw;
        if (!choice || !choice.versionId) return;
        const { action, versionId } = choice;
        if (action === 'compare') {
          const formatTime = (iso) => {
            try {
              const d = new Date(iso);
              if (Number.isNaN(d.getTime())) return String(iso || '');
              return new Intl.DateTimeFormat('ru-RU', {
                year: '2-digit',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
              }).format(d);
            } catch {
              return String(iso || '');
            }
          };

          const labelForVersion = (id) => {
            const v = versions.find((x) => String(x?.id || '') === String(id));
            if (!v) return String(id);
            return String(v?.label || formatTime(v?.created_at || v?.createdAt) || id);
          };

          const target = await showVersionCompareTargetPicker({
            versions,
            excludeId: versionId,
          });
          if (!target) return;

          showPersistentToast('Сравниваем…');
          const verA = await fetchArticleVersion(state.articleId, versionId);
          const docA = verA?.docJson || verA?.doc_json || null;

          let docB = null;
          let beforeTitle = `Версия: ${labelForVersion(versionId)}`;
          let afterTitle = 'Текущая';
          if (target.target === 'current') {
            docB = state.article?.docJson || state.article?.doc_json || null;
          } else {
            const verB = await fetchArticleVersion(state.articleId, target.versionId);
            docB = verB?.docJson || verB?.doc_json || null;
            afterTitle = `Версия: ${labelForVersion(target.versionId)}`;
          }
          hideToast();

          const version = outlineDocJsonToIndexTextMap(docA || {});
          const current = outlineDocJsonToIndexTextMap(docB || {});

          const changes = [];
          const seen = new Set();
          version.order.forEach((id) => {
            seen.add(id);
            const a = version.map.get(id);
            const b = current.map.get(id);
            if (!b) {
              changes.push({ type: 'removed', id, label: a?.label || id, before: a?.indexText || '', after: '' });
              return;
            }
            if ((a?.indexText || '') !== (b?.indexText || '')) {
              changes.push({
                type: 'changed',
                id,
                label: b?.label || a?.label || id,
                before: a?.indexText || '',
                after: b?.indexText || '',
              });
            }
          });
          current.order.forEach((id) => {
            if (seen.has(id)) return;
            const b = current.map.get(id);
            changes.push({ type: 'added', id, label: b?.label || id, before: '', after: b?.indexText || '' });
          });

          await showVersionDiffModal({
            title: 'Отличия',
            beforeTitle,
            afterTitle,
            changes,
          });
          return;
        }

        const ok = await showConfirm({
          title: 'Восстановить версию?',
          message: 'Текущее содержимое статьи будет заменено выбранной версией.',
          confirmText: 'Восстановить',
          cancelText: 'Отмена',
        });
        if (!ok) return;
        const wasOutline = Boolean(state.isOutlineEditing);
        showPersistentToast('Восстанавливаем…');
        await restoreArticleVersion(state.articleId, versionId);
        await loadArticle(state.articleId, { resetUndoStacks: true });
        if (wasOutline) {
          // Если пользователь находится в outline-режиме, нужно пересобрать TipTap документ,
          // иначе экран останется на старом содержимом.
          const { closeOutlineEditor, openOutlineEditor } = await loadOutlineEditorModule();
          closeOutlineEditor?.();
          await openOutlineEditor?.();
        } else {
          renderArticle('events.restoreVersion.fullRender');
        }
        hideToast();
        showToast('Версия восстановлена');
      } catch (error) {
        hideToast();
        showToast(error?.message || 'Не удалось открыть версии');
      }
    });
  }
  if (refs.blockHistoryBtn) {
    refs.blockHistoryBtn.addEventListener('click', async (event) => {
      event.stopPropagation();
      closeArticleMenu();
      if (!state.articleId || !state.article) return;
      if (state.article.encrypted) {
        showToast('История блоков пока недоступна для зашифрованных статей');
        return;
      }
      try {
        let blockId = state.currentBlockId || null;
        if (state.isOutlineEditing) {
          try {
		            const outline = await import('./outline/editor.js');
          if (outline?.getOutlineActiveSectionId) {
            blockId = outline.getOutlineActiveSectionId() || blockId;
          }
          } catch {
            // ignore
          }
        }
        if (!blockId) {
          showToast('Не выбран блок');
          return;
        }
        showPersistentToast('Загружаем историю…');
        const result = await apiRequest(
          `/api/articles/${encodeURIComponent(state.articleId)}/blocks/${encodeURIComponent(blockId)}/history?limit=200`,
        );
        hideToast();
        const entriesRaw = Array.isArray(result?.entries) ? result.entries : [];
        const entries = entriesRaw.map((e) => ({
          ...e,
          // В outline-first истории `before/after` уже plain text (не HTML).
          beforePlain: String(e.beforePlain ?? e.before ?? ''),
          afterPlain: String(e.afterPlain ?? e.after ?? ''),
        }));

        const choice = await showBlockHistoryModal({
          title: 'История блока',
          entries,
          canRestore: true,
          beforeTitle: 'До',
          afterTitle: 'После',
        });
        if (!choice || choice.action !== 'restore' || !choice.entry) return;

        const ok = await showConfirm({
          title: 'Восстановить блок?',
          message: 'Блок будет заменён на состояние после выбранного изменения.',
          confirmText: 'Восстановить',
          cancelText: 'Отмена',
        });
        if (!ok) return;

        if (state.isOutlineEditing) {
          const outline = await import('./outline/editor.js');
          const frags = {
            heading: choice.entry.afterHeadingJson || null,
            body: choice.entry.afterBodyJson || null,
          };
          if (outline?.restoreOutlineSectionFromSectionFragments) {
            const restored = outline.restoreOutlineSectionFromSectionFragments(blockId, frags);
            if (restored) {
              showToast('Восстановлено (будет сохранено автоматически)');
              return;
            }
            // Section might be deleted from current docJson; offer to re-insert at the end.
            if (outline?.insertOutlineSectionFromSectionFragmentsAtEnd) {
              const okInsert = await showConfirm({
                title: 'Блок удалён',
                message: 'Секция с этим ID не найдена в текущей статье. Вставить восстановленную секцию в конец статьи?',
                confirmText: 'Вставить в конец',
                cancelText: 'Отмена',
              });
              if (!okInsert) return;
              const inserted = outline.insertOutlineSectionFromSectionFragmentsAtEnd(blockId, frags);
              if (inserted) {
                showToast('Вставлено в конец (будет сохранено автоматически)');
                return;
              }
            }
            showToast('Не удалось восстановить: секция не найдена');
            return;
          }
        }

        const htmlToRestore = String(choice.entry.after || '');
        showPersistentToast('Восстанавливаем…');
        await apiRequest(`/api/articles/${encodeURIComponent(state.articleId)}/blocks/${encodeURIComponent(blockId)}`, {
          method: 'PATCH',
          body: JSON.stringify({ text: htmlToRestore }),
        });
        hideToast();
        await loadArticle(state.articleId, { desiredBlockId: blockId, resetUndoStacks: true });
        renderArticle('events.blockHistory.restore.fullRender');
        showToast('Блок восстановлен');
      } catch (error) {
        hideToast();
        showToast(error?.message || 'Не удалось загрузить историю блока');
      }
    });
  }
  if (refs.articleHistoryBtn) {
    refs.articleHistoryBtn.addEventListener('click', async (event) => {
      event.stopPropagation();
      closeArticleMenu();
      if (!state.articleId || !state.article) return;
      if (state.article.encrypted) {
        showToast('История пока недоступна для зашифрованных статей');
        return;
      }
      try {
        let history = Array.isArray(state.article.history) ? state.article.history : [];
        if (!history.length) {
          showPersistentToast('Загружаем историю…');
          const res = await fetchArticleHistory(state.articleId);
          hideToast();
          if (state.article && state.articleId) {
            state.article.history = Array.isArray(res?.history) ? res.history : [];
            state.article.redoHistory = Array.isArray(res?.redoHistory) ? res.redoHistory : [];
            state.article.blockTrash = Array.isArray(res?.blockTrash) ? res.blockTrash : [];
          }
          history = Array.isArray(state.article?.history) ? state.article.history : [];
        }
        // Only outline-first history entries: those contain section fragments.
        const outlineEntries = history.filter(
          (e) => e && (e.beforeHeadingJson || e.beforeBodyJson || e.afterHeadingJson || e.afterBodyJson),
        );
        await showArticleHistoryModal({
          title: 'История статьи',
          entries: outlineEntries,
          canRestore: true,
          beforeTitle: 'До',
          afterTitle: 'После',
          onRestore: async (entry) => {
            try {
              if (!state.articleId || !state.article) return;
              const blockId = String(entry?.blockId || '').trim();
              if (!blockId) {
                showToast('Не удалось восстановить: нет ID секции');
                return;
              }
              const ok = await showConfirm({
                title: 'Восстановить?',
                message: 'Если секция удалена, она будет вставлена в конец статьи.',
                confirmText: 'Восстановить',
                cancelText: 'Отмена',
              });
              if (!ok) return;

              if (!state.isOutlineEditing) {
                showToast('Откройте outline-режим, чтобы восстановить секцию');
                return;
              }

              const outline = await import('./outline/editor.js');
              const frags = {
                heading: entry.afterHeadingJson || null,
                body: entry.afterBodyJson || null,
              };
              if (outline?.restoreOutlineSectionFromSectionFragments) {
                const restored = outline.restoreOutlineSectionFromSectionFragments(blockId, frags);
                if (restored) {
                  showToast('Восстановлено (будет сохранено автоматически)');
                  return;
                }
              }
              if (outline?.insertOutlineSectionFromSectionFragmentsAtEnd) {
                const inserted = outline.insertOutlineSectionFromSectionFragmentsAtEnd(blockId, frags);
                if (inserted) {
                  showToast('Вставлено в конец (будет сохранено автоматически)');
                  return;
                }
              }
              showToast('Не удалось восстановить секцию');
            } catch (error) {
              showToast(error?.message || 'Не удалось восстановить секцию');
            }
          },
        });
      } catch (error) {
        showToast(error?.message || 'Не удалось открыть историю статьи');
      }
    });
  }
  if (refs.exportCurrentBlockBtn) {
    refs.exportCurrentBlockBtn.addEventListener('click', async (event) => {
      event.preventDefault();
      try {
        const { exportCurrentBlockAsHtml } = await loadExporterModule();
        await exportCurrentBlockAsHtml?.();
      } catch {
        showToast('Не удалось экспортировать');
      }
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
  if (refs.searchInput) {
    refs.searchInput.addEventListener('keydown', (event) => {
      if (state.sidebarSearchView !== 'list') return;
      if (event.key === 'Escape') {
        event.stopPropagation();
        event.preventDefault();
        refs.searchInput.value = '';
        state.articleFilterQuery = '';
        ensureSidebarSelectionVisible();
        renderSidebarArticleList();
        sidebarQuickFilterLastTypedAt = 0;
        updateSearchClearBtn();
        return;
      }
      const { key, ctrlKey, altKey, metaKey } = event;
      if (ctrlKey || altKey || metaKey) return;
      if (key.length !== 1) return;
      const now = Date.now();
      const idle = !sidebarQuickFilterLastTypedAt || now - sidebarQuickFilterLastTypedAt > 2000;
      if (idle) {
        // Очищаем поле перед началом нового "слова".
        refs.searchInput.value = '';
        state.articleFilterQuery = '';
        renderSidebarArticleList();
        updateSearchClearBtn();
      }
      sidebarQuickFilterLastTypedAt = now;
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
        renderArticle('events.blockTrash.restore.fullRender');
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
          'Чтобы создавать быстрые заметки из Телеграмм',
          '1. Откройте чат с ботом.',
          '2. Отправьте ему эту команду:',
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
        try {
          refs.syncMenu?.classList.add('hidden');
          refs.sidebarSyncStatusPill?.setAttribute('aria-expanded', 'false');
        } catch {
          // ignore
        }
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
      const keepOpen =
        refs.userMenu.classList.contains('hidden') ||
        refs.userMenu.contains(target) ||
        refs.userMenuBtn.contains(target);
      if (!keepOpen) {
        refs.userMenu.classList.add('hidden');
        refs.userMenuBtn.setAttribute('aria-expanded', 'false');
      }
    }
    if (refs.syncMenu && refs.sidebarSyncStatusPill) {
      const target = event.target;
      const keepOpen =
        refs.syncMenu.classList.contains('hidden') ||
        refs.syncMenu.contains(target) ||
        refs.sidebarSyncStatusPill.contains(target);
      if (!keepOpen) {
        refs.syncMenu.classList.add('hidden');
        refs.sidebarSyncStatusPill.setAttribute('aria-expanded', 'false');
      }
    }
  });
}
