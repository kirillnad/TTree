import { state, isHintVisible } from './state.js';
import { refs } from './refs.js';
import { handleUndoAction, handleRedoAction, clearPendingTextPreview } from './undo.js';
import { moveCurrentBlock, indentCurrentBlock, outdentCurrentBlock } from './undo.js';
import {
  createSibling,
  deleteCurrentBlock,
  startEditing,
  saveEditing,
  cancelEditing,
  handleGlobalPaste,
  splitEditingBlockAtCaret,
} from './actions.js';
import { moveSelection, findCollapsibleTarget, setCollapseState, setCurrentBlock } from './block.js';
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
import { createArticle, openInboxArticle, createInboxNote, toggleDragMode, toggleArticleEncryption, removeArticleEncryption, renderArticle } from './article.js';
import { navigate, routing } from './routing.js';
import { exportCurrentArticleAsHtml } from './exporter.js';
import { apiRequest, importArticleFromHtml, importArticleFromMarkdown, importFromLogseqArchive } from './api.js';
import { showToast, showPersistentToast, hideToast } from './toast.js';
import { showPrompt, showConfirm } from './modal.js';

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
      // Обновляем заголовок текущей статьи; списки обновляются внутри toggleFavorite.
      renderArticle();
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
        renderArticle();
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
            const article = await importArticleFromHtml(file);
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
    refs.hintToggleBtn.addEventListener('click', toggleHintPopover);
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
