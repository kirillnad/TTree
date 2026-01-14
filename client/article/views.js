// Вынесено из `article.js`: view-функции (load*View), создание/объединение и inbox-сценарии.

import { state } from '../state.js';
import { refs } from '../refs.js';
import { fetchArticlesIndex, createArticle as createArticleApi, moveArticleTree } from '../api.js';
import { showToast } from '../toast.js';
import { showPrompt } from '../modal.js';
import { navigate, routing } from '../routing.js';
import { markCachedArticleDeleted } from '../offline/cache.js';
import {
  ensureArticlesIndexLoaded,
  ensureDeletedArticlesIndexLoaded,
  renderMainArticleList,
  removeArticleFromIndex,
  upsertArticleIndex,
} from '../sidebar.js';
import { recordArticleOpened } from '../sidebar.js';
import { setViewMode } from '../sidebar.js';
import { clearPendingTextPreview } from '../undo.js';
import { flattenVisible, findBlock, setCurrentBlock } from '../block.js';
import { loadArticle } from './loadCore.js';
import { renderArticle, setMoveBlockFromInboxHandler } from './render.js';
import { updateDragModeUi } from './dnd.js';
import { refreshInboxCacheFromServer } from '../quickNotes/pending.js';

async function moveBlockFromInbox(blockId) {
  try {
    const list = state.articlesIndex.length ? state.articlesIndex : await fetchArticlesIndex();
    const allowed = list.filter((item) => item.id !== 'inbox');
    const suggestions = allowed.map((item) => ({ id: item.id, title: item.title || 'Без названия' }));
    const result = await showPrompt({
      title: 'Перенести в статью',
      message: 'Введите ID или выберите статью',
      confirmText: 'Перенести',
      cancelText: 'Отмена',
      suggestions,
      returnMeta: true,
      hideConfirm: false,
    });
    const inputValue = result?.selectedId || (typeof result === 'object' ? result?.value : result) || '';
    const trimmed = (inputValue || '').trim();
    if (!trimmed) return;

    const trimmedLc = trimmed.toLowerCase();
    const matched = allowed.find(
      (item) => (item.id && item.id.toLowerCase() === trimmedLc) || (item.title || '').toLowerCase() === trimmedLc,
    );
    const targetId = matched ? matched.id : trimmed;

    if (!targetId || targetId === 'inbox') {
      showToast('Статья не найдена');
      return;
    }

    await apiRequest(`/api/articles/${state.articleId}/blocks/${blockId}/move-to/${targetId}`, { method: 'POST' });
    await loadArticle('inbox', { resetUndoStacks: true });
    renderArticle();
    showToast('Блок перенесён');
  } catch (error) {
    showToast(error.message || 'Не удалось перенести блок');
  }
}

// Соединяем UI (кнопка переноса из inbox) и реализацию.
setMoveBlockFromInboxHandler(moveBlockFromInbox);

export async function mergeAllBlocksIntoFirst() {
  if (state.isMergingBlocks) {
    return;
  }
  if (!state.article || !Array.isArray(state.article.blocks) || !state.article.blocks.length) {
    showToast('Нет блоков для объединения');
    return;
  }

  const selectedIds = Array.isArray(state.selectedBlockIds) ? state.selectedBlockIds : [];
  if (!selectedIds.length) {
    showToast('Выберите блоки (Shift+↑/↓), которые нужно объединить');
    return;
  }

  // Сортируем выбранные блоки в порядке видимости на экране.
  const ordered = flattenVisible(state.article.blocks);
  const selectedOrdered = ordered.filter((b) => selectedIds.includes(b.id));

  if (selectedOrdered.length < 2) {
    showToast('Для объединения нужно выбрать как минимум два блока');
    return;
  }

  const firstBlock = selectedOrdered[0];
  const restBlocks = selectedOrdered.slice(1);

  // При объединении пользователь может выбрать как родительский блок, так и его
  // вложенные блоки. На сервере удаление одного блока удаляет всё его поддерево,
  // поэтому если мы попробуем отдельно удалить потомка уже удалённого родителя,
  // сервер вернёт ошибку (BlockNotFound/500). Фильтруем такие случаи и оставляем
  // только «верхнеуровневые» блоки среди выбранных для удаления.
  const restIds = new Set(restBlocks.map((b) => b.id));
  const restBlocksTopLevel = restBlocks.filter((b) => {
    const located = findBlock(b.id, state.article?.blocks || []);
    if (!located) {
      // Блок уже не найден в текущем состоянии статьи — просто пропускаем.
      return false;
    }
    return !located.ancestors?.some((ancestor) => restIds.has(ancestor.id));
  });

  const pieces = [];
  if (firstBlock.text) pieces.push(firstBlock.text);
  restBlocks.forEach((b) => {
    if (!b.text) return;
    pieces.push(b.text);
  });
  const mergedHtml = pieces.join('');

  state.isMergingBlocks = true;
  if (refs.mergeBlocksBtn) {
    refs.mergeBlocksBtn.disabled = true;
  }
  showToast('Объединяем выбранные блоки...');

  try {
    // Обновляем текст первого блока.
    await apiRequest(`/api/articles/${state.articleId}/blocks/${firstBlock.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ text: mergedHtml }),
    });

    // Удаляем остальные выбранные блоки (их поддеревья удалятся каскадно).
    // eslint-disable-next-line no-restricted-syntax
    for (const blk of restBlocksTopLevel) {
      // eslint-disable-next-line no-await-in-loop
      await apiRequest(`/api/articles/${state.articleId}/blocks/${blk.id}`, {
        method: 'DELETE',
      });
    }

    // Перезагружаем статью и сразу перерисовываем, чтобы пользователь
    // мгновенно увидел результат без обновления страницы.
    await loadArticle(state.articleId, { resetUndoStacks: false });
    renderArticle();
    // Возвращаемся в режим просмотра и фокусируем объединённый блок,
    // чтобы сразу можно было войти в редактирование без перезагрузки.
    state.mode = 'view';
    state.editingBlockId = null;
    state.pendingEditBlockId = null;
    setCurrentBlock(firstBlock.id);
    showToast('Блоки объединены в один');
  } catch (error) {
    showToast(error.message || 'Не удалось объединить блоки');
  } finally {
    state.isMergingBlocks = false;
    if (refs.mergeBlocksBtn) {
      refs.mergeBlocksBtn.disabled = false;
    }
  }
}

export async function loadArticleView(id) {
  // Inbox has a stable public id "inbox". Any internal ids like `inbox-<userId>` must never be used on the client,
  // otherwise we can open a stale/foreign inbox and show only a subset of notes.
  try {
    const raw = String(id || '');
    if (raw.startsWith('inbox-')) id = 'inbox';
  } catch {
    // ignore
  }
  state.isPublicView = false;
  state.isRagView = false;
  document.body.classList.remove('public-embedded');
  // При открытии страницы всегда выходим из режима редактирования заголовка,
  // чтобы заголовок не «прятался» за полем ввода, особенно на мобильных.
  state.isEditingTitle = false;
  await ensureArticlesIndexLoaded();
  setViewMode(true);
  if (refs.usersView) refs.usersView.classList.add('hidden');
  refs.blocksContainer.innerHTML = 'Загрузка...';
  try {
    if (id === 'RAG') {
      // Специальная страница (виртуальная статья) с резюме + найденными блоками.
      state.isRagView = true;
      state.mode = 'view';
      state.editingBlockId = null;
      state.pendingEditBlockId = null;
      state.scrollTargetBlockId = null;
      state.ragBlockMap = {};
      recordArticleOpened('RAG');
      const query = (state.ragQuery || '').trim();
      const results = Array.isArray(state.ragResults) ? state.ragResults : [];
      const total = results.length;
      const uniqueArticles = Array.from(
        new Set(results.map((r) => (r && r.articleTitle ? String(r.articleTitle) : '')).filter(Boolean)),
      );
      const topArticles = uniqueArticles.slice(0, 8);
      const aiSummaryLines = ['<p><strong>Сводка</strong></p>'];
      if (state.ragSummaryLoading) {
        aiSummaryLines.push('<p class="meta">Генерирую сводку…</p>');
      } else if (state.ragSummaryError) {
        aiSummaryLines.push(`<p class="meta">Ошибка сводки: ${state.ragSummaryError}</p>`);
      } else if (state.ragSummaryHtml) {
        aiSummaryLines.push(state.ragSummaryHtml);
      } else {
        aiSummaryLines.push('<p class="meta">Сводка пока не готова.</p>');
      }

      const metaLines = [
        `<p><strong>AI-поиск: результаты</strong></p>`,
        `<p><span class="meta">Запрос:</span> ${query ? query : '—'}</p>`,
        `<p><span class="meta">Найдено блоков:</span> ${total}</p>`,
      ];
      if (topArticles.length) {
        metaLines.push(`<p><span class="meta">Статьи:</span> ${topArticles.join(' · ')}</p>`);
      }
      if (uniqueArticles.length > topArticles.length) {
        metaLines.push(`<p><span class="meta">…и ещё:</span> ${uniqueArticles.length - topArticles.length}</p>`);
      }
      const blocks = [
        {
          id: 'rag-ai-summary',
          text: aiSummaryLines.join(''),
          children: [],
          collapsed: false,
        },
        {
          id: 'rag-meta',
          text: metaLines.join(''),
          children: [],
          collapsed: false,
        },
        ...results
          .filter((r) => r && r.type === 'block')
          .map((r, idx) => {
            const blockHtml = r.blockText || '';
            const title = r.articleTitle ? String(r.articleTitle) : '';
            const header = title ? `<p><strong>${title}</strong></p>` : `<p><strong>Результат ${idx + 1}</strong></p>`;
            const ragId = `rag-${r.blockId || idx}`;
            if (r.articleId && r.blockId) {
              state.ragBlockMap[ragId] = { articleId: r.articleId, blockId: r.blockId };
            }
            return {
              id: ragId,
              text: `${header}${blockHtml}`,
              children: [],
              collapsed: false,
            };
          }),
      ];
      state.article = {
        id: 'RAG',
        title: query ? `AI: ${query}` : 'AI: результаты поиска',
        blocks,
        updated_at: new Date().toISOString(),
      };
      state.articleId = 'RAG';
      state.currentBlockId = blocks[0]?.id || null;
      renderArticle();
      return;
    }
    const editTarget = state.pendingEditBlockId || undefined;
    // При входе в режим редактирования не скроллим блок к центру,
    // а используем scrollTargetBlockId только для переходов/поиска.
    const desired = state.scrollTargetBlockId || undefined;
    await loadArticle(id, { resetUndoStacks: true, desiredBlockId: desired, editBlockId: editTarget });
    renderArticle();
    recordArticleOpened(id);

    // Inbox is special: keep it fresh across devices.
    if (id === 'inbox' && navigator.onLine && state.serverStatus === 'ok') {
      try {
        // 1) Refresh cached inbox from server (so mobile doesn't stay on stale cache).
        await refreshInboxCacheFromServer().catch(() => {});
        // 2) If user is not actively editing, reload once so UI reflects the refreshed cache.
        if (state.articleId === 'inbox' && !state.editingBlockId) {
          await loadArticle('inbox', { resetUndoStacks: false });
          renderArticle();
        }
      } catch {
        // ignore
      }
    }
  } catch (error) {
    try {
      const status = Number(error?.status || 0) || null;
      if (status === 404 && id && id !== 'inbox') {
        markCachedArticleDeleted(id, new Date().toISOString()).catch(() => {});
        removeArticleFromIndex(id);
        showToast('Статья не найдена (возможно, удалена).');
        navigate(routing.list);
        return;
      }
    } catch {
      // ignore
    }
    refs.blocksContainer.innerHTML = `<p class="meta">Не удалось загрузить статью: ${error.message}</p>`;
  }
}

export async function loadListView() {
  state.isPublicView = false;
  state.isRagView = false;
  document.body.classList.remove('public-embedded');
  if (refs.usersView) refs.usersView.classList.add('hidden');
  state.article = null;
  state.articleId = null;
  state.currentBlockId = null;
  state.isEditingTitle = false;
  state.mode = 'view';
  state.editingBlockId = null;
  state.undoStack = [];
  state.redoStack = [];
  state.pendingEditBlockId = null;
  clearPendingTextPreview({ restoreDom: false });
  setViewMode(false);
  updateDragModeUi();
  try {
    if (state.isTrashView) {
      const deleted = await ensureDeletedArticlesIndexLoaded();
      renderMainArticleList(deleted);
    } else {
      const articles = await ensureArticlesIndexLoaded();
      renderMainArticleList(articles);
    }
  } catch (error) {
    refs.articleList.innerHTML = `<li>Не удалось загрузить список: ${error.message}</li>`;
  }
}

export async function loadPublicArticleView(slug) {
  state.isPublicView = true;
  state.isRagView = false;
  document.body.classList.add('public-embedded');
  if (refs.usersView) refs.usersView.classList.add('hidden');
  setViewMode(true);
  state.isEditingTitle = false;
  state.mode = 'view';
  state.editingBlockId = null;
  state.pendingEditBlockId = null;
  state.selectionAnchorBlockId = null;
  state.selectedBlockIds = [];
  state.undoStack = [];
  state.redoStack = [];
  clearPendingTextPreview({ restoreDom: false });

  if (refs.blocksContainer) refs.blocksContainer.innerHTML = 'Загрузка...';
  try {
    const article = await apiRequest(`/api/public/articles/${encodeURIComponent(slug)}`, {
      method: 'GET',
      credentials: 'omit',
    });
    state.article = article;
    state.articleId = article?.id || null;
    const first = flattenVisible(article?.blocks || [])[0];
    state.currentBlockId = first ? first.id : null;
    renderArticle();
  } catch (error) {
    if (refs.blocksContainer) {
      refs.blocksContainer.innerHTML = `<p class="meta">Не удалось открыть публичную статью: ${error.message}</p>`;
    }
  }
}

export async function createArticle() {
  if (refs.createArticleBtn) refs.createArticleBtn.disabled = true;
  if (refs.sidebarNewArticleBtn) refs.sidebarNewArticleBtn.disabled = true;
  try {
    let title = '';
    let parentId = null;
    const candidateId = String(state.sidebarSelectedArticleId || state.articleId || state.listSelectedArticleId || '').trim();
    const candidate =
      candidateId && candidateId !== 'inbox' && candidateId !== 'RAG'
        ? state.articlesIndex.find((a) => String(a?.id || '') === candidateId)
        : null;
    const candidateTitle = candidate ? String(candidate.title || '').trim() : '';
    try {
      const result = await showPrompt({
        title: 'Новая страница',
        message: 'Введите заголовок для новой страницы.',
        confirmText: 'Создать',
        cancelText: 'Отмена',
        placeholder: 'Заголовок страницы',
        defaultValue: '',
        returnMeta: true,
        checkbox:
          candidateTitle && candidateId
            ? { label: `Создать внутри "${candidateTitle}"?`, checked: false, disabled: false }
            : null,
      });
      title = typeof result === 'object' ? result?.value : result;
      parentId =
        typeof result === 'object' && result?.checkboxChecked && candidateId && candidateTitle ? candidateId : null;
    } catch (error) {
      title = window.prompt('Введите заголовок страницы') || '';
    }
    title = (title || '').trim();
    if (!title) return;

    let article = await createArticleApi(title, { parentId });
    // Safety: if the client requested a parent but the create endpoint didn't apply it
    // (or the client is offline and returned a local draft), fix nesting via move-tree.
    if (parentId && article?.id && navigator.onLine && String(article.parentId || '') !== String(parentId)) {
      try {
        const moved = await moveArticleTree(article.id, { parentId, placement: 'inside' });
        if (moved && moved.id) article = moved;
      } catch {
        // ignore: offline or server rejected; article still exists at root
      }
    }
    upsertArticleIndex(article);
    state.pendingEditBlockId = article?.blocks?.[0]?.id || null;
    state.scrollTargetBlockId = state.pendingEditBlockId;
    navigate(routing.article(article.id));
    showToast('Статья создана');
  } catch (error) {
    showToast(error.message);
  } finally {
    if (refs.createArticleBtn) refs.createArticleBtn.disabled = false;
    if (refs.sidebarNewArticleBtn) refs.sidebarNewArticleBtn.disabled = false;
  }
}

export async function openInboxArticle() {
  // `navigate()` already triggers routing and loads the view.
  navigate(routing.article('inbox'));
}

export async function createInboxNote() {
  try {
    const inboxPath = routing.article('inbox');
    const alreadyOnInbox = state.articleId === 'inbox' && window.location.pathname === inboxPath;
    if (!alreadyOnInbox) {
      // Important: `navigate()` already starts async `loadArticleView()` via routing.
      // Do not call `loadArticle()` in parallel, otherwise the second load can overwrite
      // the just-created draft section and it "disappears".
      navigate(inboxPath);
    }
    const outline = await import('../outline/editor.js');
    let newSectionId = null;
    const deadline = performance.now() + 15000;
    while (!newSectionId && performance.now() < deadline) {
      const isInboxLoaded =
        state.articleId === 'inbox' &&
        state.article &&
        (String(state.article.id || '') === 'inbox' || String(state.article.id || '').startsWith('inbox-')) &&
        String(state.article.title || '') === 'Быстрые заметки';
      if (!isInboxLoaded) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
      if (state.article?.encrypted) {
        showToast('Не удалось создать заметку (инбокс зашифрован)');
        return;
      }
      newSectionId = outline?.insertNewOutlineSectionAtStart?.({ enterEditMode: true }) || null;
      if (!newSectionId) {
        // Outline редактор может инициализироваться асинхронно сразу после загрузки статьи.
        // Делаем короткий retry вместо того, чтобы фейлить создание заметки.
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    if (!newSectionId) {
      showToast('Не удалось создать заметку');
      return;
    }
    state.currentBlockId = newSectionId;
    try {
      outline?.enterOutlineSectionEditMode?.(newSectionId, { focusBody: true });
    } catch {
      // ignore
    }
  } catch (error) {
    showToast(error.message || 'Не удалось создать заметку');
  }
}
