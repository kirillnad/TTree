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
import { moveSelection, extendSelection, findCollapsibleTarget, setCollapseState, setCurrentBlock } from './block.js';
import { handleSearchInput, hideSearchResults, renderSearchResults } from './search.js';
import { startTitleEditingMode, handleTitleInputKeydown, handleTitleInputBlur, toggleArticleMenu, closeArticleMenu, isArticleMenuVisible, handleDeleteArticle, handleTitleClick } from './title.js';
import { toggleHintPopover, hideHintPopover, setTrashMode, toggleFavorite } from './sidebar.js';
import {
  toggleSidebarCollapsed,
  handleArticleFilterInput,
  toggleSidebarMobile,
  closeSidebarMobile,
  setSidebarMobileOpen,
  setSidebarCollapsed,
} from './sidebar.js';
import { createArticle, openInboxArticle, createInboxNote, toggleDragMode, toggleArticleEncryption, removeArticleEncryption, renderArticle, mergeAllBlocksIntoFirst, updateArticleHeaderUi } from './article.js';
import { navigate, routing } from './routing.js';
import { exportCurrentArticleAsHtml, exportCurrentBlockAsHtml } from './exporter.js';
import { apiRequest, importArticleFromHtml, importArticleFromMarkdown, importFromLogseqArchive } from './api.js';
import { showToast, showPersistentToast, hideToast } from './toast.js';
import { insertHtmlAtCaret } from './utils.js';
import { showPrompt, showConfirm, showImportConflictDialog } from './modal.js';

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
    moveSelectedBlocks('down');
    return;
  }
  if (event.ctrlKey && event.shiftKey && event.code === 'ArrowUp') {
    event.preventDefault();
    moveSelectedBlocks('up');
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
    indentSelectedBlocks();
    return;
  }
  if (event.ctrlKey && event.code === 'ArrowLeft') {
    event.preventDefault();
    outdentSelectedBlocks();
    return;
  }
  if (event.code === 'ArrowDown') {
    if (!event.ctrlKey && event.shiftKey) {
      event.preventDefault();
      extendSelection(1);
      return;
    }
    event.preventDefault();
    moveSelection(1);
    return;
  }
  if (event.code === 'ArrowUp') {
    if (!event.ctrlKey && event.shiftKey) {
      event.preventDefault();
      extendSelection(-1);
      return;
    }
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
    if (state.mode === 'view') {
      handleViewKey(event);
    } else {
      handleEditKey(event);
    }
  });

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
    // Диагностика: проверяем, что ссылка найдена и хендлер навешан.
    // eslint-disable-next-line no-console
    console.log('[memus] articlePublicLinkBtn найден', refs.articlePublicLinkBtn);
    refs.articlePublicLinkBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      // eslint-disable-next-line no-console
      console.log('[memus] articlePublicLinkBtn click', {
        articleId: state.article && state.article.id,
        publicSlug: state.article && state.article.publicSlug,
      });
      if (!state.article || !state.article.publicSlug) {
        showToast('Эта страница ещё не опубликована');
        return;
      }
      const slug = state.article.publicSlug;
      const url = `${window.location.origin}/p/${encodeURIComponent(slug)}`;
      // Открываем вкладку синхронно, чтобы не блокировал браузер.
      window.open(url, '_blank', 'noopener,noreferrer');
      // Копирование ссылки — асинхронно, но уже после открытия вкладки.
      (async () => {
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(url);
          } else {
            const tmp = document.createElement('textarea');
            tmp.value = url;
            tmp.setAttribute('readonly', '');
            tmp.style.position = 'absolute';
            tmp.style.left = '-9999px';
            document.body.appendChild(tmp);
            tmp.select();
            const ok = document.execCommand('copy');
            document.body.removeChild(tmp);
            if (!ok) {
              throw new Error('copy command failed');
            }
          }
          showToast('Публичная ссылка скопирована');
        } catch (error) {
          showToast(error.message || 'Не удалось скопировать ссылку');
        }
      })();
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
          refs.articlePublicToggleBtn.textContent = slug ? 'Сделать приватной' : 'Сделать публичной';
        }
        // Обновляем только хедер (иконка 🌐, updatedAt и т.п.),
        // без полной перерисовки списка блоков.
        updateArticleHeaderUi();
        if (makePublic && slug) {
          const url = `${window.location.origin}/p/${encodeURIComponent(slug)}`;
          try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
              await navigator.clipboard.writeText(url);
            } else {
              // Fallback через временное текстовое поле.
              const tmp = document.createElement('textarea');
              tmp.value = url;
              tmp.setAttribute('readonly', '');
              tmp.style.position = 'absolute';
              tmp.style.left = '-9999px';
              document.body.appendChild(tmp);
              tmp.select();
              try {
                document.execCommand('copy');
              } catch (_) {
                // ignore
              }
              document.body.removeChild(tmp);
            }
          } catch (_) {
            // игнорируем ошибки буфера обмена
          }
          window.open(url, '_blank', 'noopener,noreferrer');
          showToast('Публичная ссылка скопирована');
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
  if (refs.mobileSidebarBtn) {
    refs.mobileSidebarBtn.addEventListener('click', (event) => {
      event.preventDefault();
      setSidebarCollapsed(false);
      setSidebarMobileOpen(true);
    });
  }
  if (refs.listSidebarBtn) {
    refs.listSidebarBtn.addEventListener('click', (event) => {
      event.preventDefault();
      setSidebarCollapsed(false);
      setSidebarMobileOpen(true);
    });
  }
  if (refs.dragModeToggleBtn) {
    refs.dragModeToggleBtn.addEventListener('click', () => {
      toggleDragMode();
    });
  }
  if (refs.sidebarBackdrop) {
    refs.sidebarBackdrop.addEventListener('click', () => {
      closeSidebarMobile();
    });
  }
  if (refs.sidebar) {
    refs.sidebar.addEventListener(
      'click',
      (event) => {
        if (!state.isSidebarMobileOpen) return;
        const btn = event.target.closest('button');
        if (!btn) return;
        closeSidebarMobile();
      },
      true,
    );
  }
  document.addEventListener(
    'click',
    (event) => {
      const isDesktop = window.matchMedia('(min-width: 768px)').matches;
      if (isDesktop || !state.isSidebarMobileOpen) return;
      if (!refs.sidebar) return;
      const target = event.target;
      if (refs.sidebar.contains(target)) return;
      if (refs.mobileSidebarBtn && refs.mobileSidebarBtn.contains(target)) return;
      closeSidebarMobile();
    },
    true,
  );
  if (refs.articleFilterInput) {
    refs.articleFilterInput.addEventListener('input', handleArticleFilterInput);
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
  // Автосохранение блока при клике вне него в режиме редактирования.
  let isAutoSaving = false;
  document.addEventListener(
    'click',
    (event) => {
      if (isAutoSaving) return;
      if (state.mode !== 'edit' || !state.editingBlockId) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      // Не автосохраняем при клике по панели управления таблицей, rich-context-меню
      // и по кнопкам articleToolbar (Undo/Redo/Таблица/Новый блок и т.п.).
      if (target.closest('.table-toolbar')) return;
      if (target.closest('.rich-context-menu')) return;
      if (target.closest('#articleToolbar')) return;
      // Не автосохраняем при клике внутри модальных окон (showPrompt/showLinkPrompt и т.п.),
      // чтобы не терять ввод при выборе статьи, вставке ссылки и прочих диалогах.
      if (target.closest('.modal-overlay')) return;
      const blockEl = document.querySelector(
        `.block[data-block-id="${state.editingBlockId}"]`,
      );
      if (!blockEl) return;
      if (blockEl.contains(target)) return;
      isAutoSaving = true;
      Promise.resolve()
        .then(() => saveEditing())
        .finally(() => {
          isAutoSaving = false;
        });
    },
    true,
  );
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
