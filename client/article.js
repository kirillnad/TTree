import { state } from './state.js';
import { refs } from './refs.js';
import { fetchArticle, fetchArticlesIndex, createArticle as createArticleApi, apiRequest } from './api.js?v=2';
import { clearPendingTextPreview, hydrateUndoRedoFromArticle, moveBlockToParent } from './undo.js';
import { setViewMode, upsertArticleIndex, renderMainArticleList, renderSidebarArticleList, ensureArticlesIndexLoaded, ensureDeletedArticlesIndexLoaded, setTrashMode, toggleFavorite } from './sidebar.js';
import {
  findBlock,
  flattenVisible,
  expandCollapsedAncestors,
  extractBlockSections,
  buildEditableBlockHtml,
  toggleCollapse,
  setCurrentBlock,
  insertFilesIntoEditable,
} from './block.js';
import { applyPendingPreviewMarkup } from './undo.js';
import { placeCaretAtEnd, placeCaretAtStart, logDebug } from './utils.js';
import { attachRichContentHandlers } from './block.js';
import { showToast } from './toast.js';
import { navigate, routing } from './routing.js';
import { showPrompt, showConfirm, showPasswordWithHintPrompt } from './modal.js';
import { startEditing, saveEditing, cancelEditing, createSibling } from './actions.js';
import { deriveKeyFromPassword, decryptArticleBlocks, checkEncryptionVerifier, createEncryptionVerifier, encryptTextForArticle } from './encryption.js';

function updatePublicToggleLabel() {
  if (!refs.articlePublicToggleBtn) return;
  const slug = state.article?.publicSlug || null;
  refs.articlePublicToggleBtn.textContent = slug ? 'Отменить доступ по ссылке' : 'Дать доступ по ссылке';
}

function getCurrentArticleKey() {
  if (!state.articleId) return null;
  return state.articleEncryptionKeys[state.articleId] || null;
}

function setCurrentArticleKey(key) {
  if (!state.articleId) return;
  if (!state.articleEncryptionKeys) state.articleEncryptionKeys = {};
  if (key) {
    state.articleEncryptionKeys[state.articleId] = key;
  } else {
    delete state.articleEncryptionKeys[state.articleId];
  }
}

export function updateArticleHeaderUi() {
  const article = state.article;
  if (!article) return;
  const titleText = article.title || 'Без названия';
  if (refs.articleTitle) {
    refs.articleTitle.textContent = titleText;
    refs.articleTitle.classList.toggle('article-title--encrypted', Boolean(article.encrypted));
    refs.articleTitle.classList.toggle('hidden', state.isEditingTitle);
  }
  if (refs.articleTitleInput) {
    if (!state.isEditingTitle) {
      refs.articleTitleInput.value = titleText;
    }
    refs.articleTitleInput.classList.toggle('hidden', !state.isEditingTitle);
  }
  if (refs.editTitleBtn) {
    refs.editTitleBtn.classList.toggle('hidden', state.isEditingTitle);
  }
  if (refs.articleFavoriteBtn) {
    const favs = new Set(state.favoriteArticles || []);
    const isFav = favs.has(article.id);
    refs.articleFavoriteBtn.textContent = isFav ? '★' : '☆';
    refs.articleFavoriteBtn.title = isFav ? 'Убрать из избранного' : 'Добавить в избранное';
  }
  if (refs.articlePublicLinkBtn) {
    const hasPublic = Boolean(article.publicSlug);
    refs.articlePublicLinkBtn.classList.toggle('hidden', !hasPublic);
    if (hasPublic) {
      refs.articlePublicLinkBtn.title = 'Скопировать публичную ссылку';
    }
  }
  if (refs.deleteArticleBtn) {
    refs.deleteArticleBtn.classList.toggle('hidden', article.id === 'inbox');
  }
  if (refs.articleEncryptionBtn) {
    refs.articleEncryptionBtn.textContent = article.encrypted ? 'Сменить пароль' : 'Зашифровать';
  }
  if (refs.articleEncryptionRemoveBtn) {
    refs.articleEncryptionRemoveBtn.classList.toggle('hidden', !article.encrypted);
  }
  if (refs.updatedAt && article.updatedAt) {
    refs.updatedAt.textContent = `Обновлено: ${new Date(article.updatedAt).toLocaleString()}`;
  }
}

async function ensureArticleDecrypted(article) {
  if (!article || !article.encrypted) {
    if (article) {
      logDebug('ensureArticleDecrypted: skip (not encrypted)', {
        id: article.id,
        encrypted: article.encrypted,
        hasSalt: Boolean(article.encryptionSalt),
        hasVerifier: Boolean(article.encryptionVerifier),
      });
    }
    return article;
  }

  // Уже есть ключ в памяти — просто расшифровываем без повторного запроса пароля.
  const existingKey = state.articleEncryptionKeys?.[article.id] || null;
  if (existingKey) {
    logDebug('ensureArticleDecrypted: using cached key', {
      id: article.id,
      encrypted: article.encrypted,
    });
    await decryptArticleBlocks(article, existingKey);
    return article;
  }

  let attempts = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempts += 1;
    let password = null;
    try {
      const hint = article.encryptionHint || '';
      const baseMessage = 'Введите пароль для этой страницы.';
      const message = hint ? `${baseMessage}\nПодсказка: ${hint}` : baseMessage;
      // eslint-disable-next-line no-await-in-loop
      password = await showPrompt({
        title: 'Страница зашифрована',
        message,
        confirmText: 'Открыть',
        cancelText: 'Отмена',
        placeholder: 'Пароль',
        inputType: 'password',
      });
    } catch (error) {
      // fallback на prompt браузера
      // eslint-disable-next-line no-alert
      password = window.prompt('Страница зашифрована. Введите пароль:') || '';
    }
    if (!password) {
      throw new Error('Пароль не введён');
    }

    try {
      // eslint-disable-next-line no-await-in-loop
      const { key } = await deriveKeyFromPassword(password, article.encryptionSalt || '');
      // eslint-disable-next-line no-await-in-loop
      const ok = await checkEncryptionVerifier(key, article.encryptionVerifier || '');
      if (!ok) {
        if (attempts >= 3) {
          throw new Error('Неверный пароль');
        }
        // eslint-disable-next-line no-alert
        window.alert('Неверный пароль, попробуйте ещё раз.');
        // eslint-disable-next-line no-continue
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      await decryptArticleBlocks(article, key);
      setCurrentArticleKey(key);
      logDebug('ensureArticleDecrypted: decrypted with password', {
        id: article.id,
        encrypted: article.encrypted,
      });
      return article;
    } catch (error) {
      if (attempts >= 3) {
        throw new Error(error.message || 'Не удалось расшифровать страницу');
      }
      // eslint-disable-next-line no-alert
      window.alert('Не удалось расшифровать страницу, попробуйте ещё раз.');
    }
  }
}

async function encryptAllBlocksOnServer(article, key) {
  if (!article || !Array.isArray(article.blocks)) return;
  const queue = [...article.blocks];
  // eslint-disable-next-line no-restricted-syntax
  for (const block of queue) {
    const children = Array.isArray(block.children) ? block.children : [];
    queue.push(...children);
    const currentText = block.text || '';
    // eslint-disable-next-line no-await-in-loop
    const encryptedText = await encryptTextForArticle(key, currentText);
    // eslint-disable-next-line no-await-in-loop
    await apiRequest(`/api/articles/${article.id}/blocks/${block.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ text: encryptedText }),
    });
  }
}

function dedupeBlocksById(blocks) {
  const seen = new Set();
  const visit = (list) => {
    if (!Array.isArray(list)) return;
    for (let i = 0; i < list.length; i += 1) {
      const block = list[i];
      if (!block || !block.id) {
        list.splice(i, 1);
        i -= 1;
        continue;
      }
      if (seen.has(block.id)) {
        list.splice(i, 1);
        i -= 1;
        continue;
      }
      seen.add(block.id);
      if (Array.isArray(block.children) && block.children.length) {
        visit(block.children);
      }
    }
  };
  visit(blocks);
}

function cleanupDomBlockDuplicates() {
  if (!refs.blocksContainer) return;
  const seen = new Set();
  const blocks = refs.blocksContainer.querySelectorAll('.block[data-block-id]');
  blocks.forEach((el) => {
    const id = el.getAttribute('data-block-id');
    if (!id) return;
    if (seen.has(id)) {
      const parent = el.parentNode;
      if (parent) {
        parent.removeChild(el);
      }
    } else {
      seen.add(id);
    }
  });
}

export function pushLocalBlockTrashEntry(block, parentId, index, deletedAtIso) {
  if (!state.article || !block || !block.id) return;
  const list = Array.isArray(state.article.blockTrash) ? state.article.blockTrash : [];
  const deletedAt = deletedAtIso || new Date().toISOString();
  list.push({
    id: block.id,
    block,
    parentId: parentId || null,
    index: typeof index === 'number' ? index : null,
    deletedAt,
  });
  state.article.blockTrash = list;
}

export function removeDomBlockById(blockId) {
  if (!blockId || !refs.blocksContainer) return;
  const blocks = refs.blocksContainer.querySelectorAll(
    `.block[data-block-id="${blockId}"]`,
  );
  blocks.forEach((blockEl) => {
    const container = blockEl.parentElement;
    if (!container) return;
    let cursor = blockEl.nextElementSibling;
    if (cursor && cursor.classList.contains('block-children')) {
      const extra = cursor;
      cursor = cursor.nextElementSibling;
      if (extra.parentNode === container) {
        container.removeChild(extra);
      }
    }
    if (blockEl.parentNode === container) {
      container.removeChild(blockEl);
    }
  });
}

function cleanupOrphanDomBlocks() {
  if (!refs.blocksContainer) return;
  if (!state.article || !Array.isArray(state.article.blocks)) return;
  const visible = flattenVisible(state.article.blocks);
  const allowed = new Set(visible.map((b) => b.id));
  const blocks = refs.blocksContainer.querySelectorAll('.block[data-block-id]');
  blocks.forEach((el) => {
    const id = el.getAttribute('data-block-id');
    if (!id) return;
    if (!allowed.has(id)) {
      const parent = el.parentNode;
      if (parent) {
        parent.removeChild(el);
      }
    }
  });
}

async function renderBlocks(blocks, container, depth = 1) {
  for (const block of blocks) {
    const blockEl = document.createElement('div');
    blockEl.className = 'block';
    blockEl.dataset.blockId = block.id;
    if (typeof block.collapsed === 'boolean') {
      blockEl.dataset.collapsed = block.collapsed ? 'true' : 'false';
    }
    const isSelected =
      block.id === state.currentBlockId ||
      (Array.isArray(state.selectedBlockIds) && state.selectedBlockIds.includes(block.id));
    if (isSelected) blockEl.classList.add('selected');
    if (block.id === state.editingBlockId) blockEl.classList.add('editing');
    const surface = document.createElement('div');
    surface.className = 'block-surface';
    const content = document.createElement('div');
    content.className = 'block-content';

    let sections = extractBlockSections(block.text || '');
    let hasTitle = Boolean(sections.titleHtml);
    let hasBodyContent = Boolean(sections.bodyHtml && sections.bodyHtml.trim());
    const hasChildren = Boolean(block.children?.length);

    // Если у блока явно нет заголовка, но есть дети и в содержимом
    // всего одна непустая строка, считаем её заголовком при отрисовке.
    if (!hasTitle && hasChildren) {
      const tmp = document.createElement('div');
      tmp.innerHTML = sections.bodyHtml || block.text || '';
      const meaningful = Array.from(tmp.childNodes || []).filter((node) => {
        if (node.nodeType === Node.TEXT_NODE) {
          return (node.textContent || '').trim().length > 0;
        }
        if (node.nodeType === Node.ELEMENT_NODE) {
          if (node.tagName === 'BR') return false;
          if (node.tagName === 'P') {
            const inner = (node.innerHTML || '')
              .replace(/&nbsp;/gi, '')
              .replace(/<br\s*\/?>/gi, '')
              .trim();
            return inner.length > 0;
          }
          return true;
        }
        return false;
      });
      if (meaningful.length === 1) {
        const only = meaningful[0];
        if (only.nodeType === Node.ELEMENT_NODE && only.tagName === 'P') {
          sections = {
            titleHtml: only.outerHTML,
            bodyHtml: '',
          };
          hasTitle = true;
          hasBodyContent = false;
        }
      }
    }

    const canCollapse = hasTitle || hasChildren;
    const hasNoTitleNoChildren = !hasTitle && !hasChildren;
    blockEl.classList.toggle('block--no-title', !hasTitle);

    const isEditingThisBlock = state.mode === 'edit' && state.editingBlockId === block.id;

    if (canCollapse || hasNoTitleNoChildren) {
      const collapseBtn = document.createElement('button');
      collapseBtn.className = 'collapse-btn';
      if (hasNoTitleNoChildren) {
        collapseBtn.classList.add('collapse-btn--placeholder');
        collapseBtn.setAttribute('aria-hidden', 'true');
        collapseBtn.removeAttribute('aria-expanded');
        collapseBtn.removeAttribute('title');
      } else {
        collapseBtn.setAttribute('aria-expanded', block.collapsed ? 'false' : 'true');
        collapseBtn.title = block.collapsed ? 'Развернуть' : 'Свернуть';
        collapseBtn.addEventListener('click', (event) => {
          event.stopPropagation();
          toggleCollapse(block.id);
        });
      }
      surface.appendChild(collapseBtn);
    }

    const body = document.createElement('div');
    body.className = 'block-text block-body';
    const rawHtml = block.text || '';
    const bodyHtml = hasTitle ? sections.bodyHtml : rawHtml;
    body.innerHTML = bodyHtml || '';
    if (!hasTitle) body.classList.add('block-body--no-title');
    if (!bodyHtml) body.classList.add('block-body--empty');
    body.spellcheck = false;
    body.setAttribute('data-placeholder', 'Введите текст');

    if (state.mode === 'edit' && state.editingBlockId === block.id) {
      const { buildEditableBlockHtml } = await import('./block.js');
      body.setAttribute('contenteditable', 'true');
      body.innerHTML = rawHtml ? buildEditableBlockHtml(rawHtml) : '<br />';
      body.classList.remove('block-body--empty');
      // body.classList.remove('block-body--no-title'); // Оставляем класс для корректных стилей
      requestAnimationFrame(() => {
        // Заставляем браузер использовать <p> вместо <div> для новых строк. Это помогает с авто-ссылками.
        document.execCommand('defaultParagraphSeparator', false, 'p');
        // Не скроллим страницу при входе в режим редактирования.
        try {
          body.focus({ preventScroll: true });
        } catch {
          body.focus();
        }
        if (state.editingCaretPosition === 'start') {
          body.scrollTop = 0;
          placeCaretAtStart(body);
        } else {
          placeCaretAtEnd(body);
        }
      });
    } else {
      body.setAttribute('contenteditable', 'false');
    }

    body.addEventListener('click', (event) => {
      if (state.mode === 'view') setCurrentBlock(block.id);
    });

    body.addEventListener('dblclick', (event) => {
      event.stopPropagation();
      if (state.mode !== 'view') return;
      setCurrentBlock(block.id);
      startEditing();
    });

    let header = null;
    if (!isEditingThisBlock) {
      header = document.createElement('div');
      header.className = 'block-header';
      if (!hasTitle) {
        header.classList.add('block-header--no-title');
      }
      const headerLeft = document.createElement('div');
      headerLeft.className = 'block-header__left';

      if (hasTitle) {
        const level = Math.min(Math.max(depth, 1), 6);
        const headingTag = `h${level}`;
        const titleEl = document.createElement(headingTag);
        titleEl.className = 'block-title';
        titleEl.innerHTML = sections.titleHtml;
        titleEl.style.flex = '1';
        titleEl.style.minWidth = '0';
        headerLeft.appendChild(titleEl);
      } else {
        const spacer = document.createElement('div');
        spacer.className = 'block-title-spacer';
        spacer.style.flex = '1';
        spacer.style.minWidth = '0';
        headerLeft.appendChild(spacer);
      }
      header.appendChild(headerLeft);
    }

    if (header) content.appendChild(header);
    // В режиме просмотра не рисуем пустое тело для блоков с заголовком,
    // чтобы не занимать лишнее место. В режиме редактирования и для
    // блоков без заголовка тело нужно всегда.
    const shouldRenderBody = isEditingThisBlock || !hasTitle || Boolean(bodyHtml);
    if (shouldRenderBody) {
      content.appendChild(body);
    }

    if (state.articleId === 'inbox' && !isEditingThisBlock) {
      const footer = document.createElement('div');
      footer.className = 'block-footer';
      const moveBtn = document.createElement('button');
      moveBtn.type = 'button';
      moveBtn.className = 'ghost small move-block-btn';
      moveBtn.innerHTML = '&#10140;';
      moveBtn.title = 'Перенести блок в другую статью';
      moveBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        moveBlockFromInbox(block.id);
      });
      footer.appendChild(moveBtn);
      content.appendChild(footer);
    }

    surface.appendChild(content);

    if (isEditingThisBlock) {
      const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
      if (isTouchDevice) {
        content.addEventListener('click', (event) => {
          const editable = content.querySelector('.block-text[contenteditable="true"]');
          if (!editable) return;
          if (editable.contains(event.target)) return;
          event.stopPropagation();
          editable.focus();
          if (state.editingCaretPosition === 'start') {
            editable.scrollTop = 0;
            placeCaretAtStart(editable);
          } else {
            placeCaretAtEnd(editable);
          }
        });
      }
    }
    registerBlockDragSource(surface, block.id);

    if (isEditingThisBlock) {
      const actions = document.createElement('div');
      actions.className = 'block-edit-actions';

      const attachBtn = document.createElement('button');
      attachBtn.type = 'button';
      attachBtn.className = 'ghost small block-attach-btn';
      attachBtn.textContent = '📎 Файл';
      attachBtn.title = 'Прикрепить файл или картинку';
      attachBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const editable = blockEl.querySelector('.block-text[contenteditable="true"]');
        if (!editable) return;
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.style.display = 'none';
        input.addEventListener('change', () => {
          const files = Array.from(input.files || []);
          if (files.length) {
            insertFilesIntoEditable(editable, files, block.id);
          }
          input.remove();
        });
        document.body.appendChild(input);
        input.click();
      });

      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'ghost small';
      saveBtn.textContent = 'Сохранить';
      saveBtn.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        await saveEditing();
      });

      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'ghost small';
      cancelBtn.textContent = 'Отмена';
      cancelBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        cancelEditing();
      });

      actions.appendChild(attachBtn);
      actions.appendChild(saveBtn);
      actions.appendChild(cancelBtn);
    
      content.appendChild(actions);
    }

    attachRichContentHandlers(body, block.id);

    blockEl.appendChild(surface);

    blockEl.addEventListener('click', (event) => {
      event.stopPropagation();
      const interactive = event.target.closest(
        'button, a, [contenteditable="true"], .block-edit-actions',
      );
      const headerEl = blockEl.querySelector('.block-header');
      const bodyEl = blockEl.querySelector('.block-text.block-body');
      const hasHeader = Boolean(headerEl);
      const headerHasTitle = Boolean(headerEl && !headerEl.classList.contains('block-header--no-title'));
      const clickedInHeader = hasHeader && headerEl.contains(event.target);
      const clickedInBody = bodyEl && bodyEl.contains(event.target);
      const hasLogicalTitle = headerHasTitle;
      const isAlreadyCurrent = state.currentBlockId === block.id;

      let shouldToggle = false;
      if (hasLogicalTitle && clickedInHeader) {
        // Клик по заголовку всегда переключает collapse,
        // даже если внутри заголовка есть ссылка или другой интерактив.
        shouldToggle = true;
      } else if (!hasLogicalTitle && isAlreadyCurrent && clickedInBody && !interactive) {
        // Для блоков без заголовка collapse вешаем на тело,
        // но только если блок уже текущий и клик не по интерактиву.
        shouldToggle = true;
      }
      if (shouldToggle) {
        toggleCollapse(block.id);
      }
      setCurrentBlock(block.id);
    });

    surface.addEventListener('dblclick', (event) => {
      if (state.mode !== 'view') return;
      const interactive = event.target.closest('button, a, [contenteditable="true"]');
      if (interactive && !interactive.matches('.block-text[contenteditable="true"]')) return;
      event.stopPropagation();
      setCurrentBlock(block.id);
      startEditing();
    });

    const shouldHideBody = block.collapsed && block.id !== state.editingBlockId && hasTitle;
    if (!body.classList.contains('block-body--empty')) {
      body.classList.toggle('collapsed', shouldHideBody);
    }

    let childrenContainer = null;
    if (block.children?.length > 0 && !block.collapsed) {
      childrenContainer = document.createElement('div');
      childrenContainer.className = 'block-children';
      // eslint-disable-next-line no-await-in-loop
      await renderBlocks(block.children, childrenContainer, depth + 1);
    }

    container.appendChild(blockEl);
    if (childrenContainer) {
      if (isEditingThisBlock) {
        container.appendChild(childrenContainer);
      } else {
        blockEl.appendChild(childrenContainer);
      }
    }
    // Overlay drag handles removed: inline handle is now primary.
  }
}

export function reorderDomBlock(blockId, direction) {
  if (!blockId || !['up', 'down'].includes(direction)) return false;
  const blockEl = document.querySelector(`.block[data-block-id="${blockId}"]`);
  if (!blockEl) return false;
  // В режиме редактирования структура DOM вокруг блока сложнее;
  // для надёжности не пытаемся выполнять «быструю» перестановку.
  if (blockEl.classList.contains('editing')) return false;
  const container = blockEl.parentElement;
  if (!container) return false;

  if (direction === 'up') {
    let prev = blockEl.previousElementSibling;
    while (prev && !prev.classList.contains('block')) {
      prev = prev.previousElementSibling;
    }
    if (!prev) return false;
    container.insertBefore(blockEl, prev);
    return true;
  }

  // direction === 'down'
  let next = blockEl.nextElementSibling;
  while (next && !next.classList.contains('block')) {
    next = next.nextElementSibling;
  }
  if (!next) return false;
  const after = next.nextSibling;
  if (after) {
    container.insertBefore(blockEl, after);
  } else {
    container.appendChild(blockEl);
  }
  return true;
}

export async function rerenderSingleBlock(blockId) {
  if (!state.article || !Array.isArray(state.article.blocks)) return;
  const located = findBlock(blockId);
  if (!located) return;
  const depth = (Array.isArray(located.ancestors) ? located.ancestors.length : 0) + 1;
  const oldBlockEl = document.querySelector(`.block[data-block-id="${blockId}"]`);
  if (!oldBlockEl) return;
  const container = oldBlockEl.parentElement;
  if (!container) return;
  // В режиме редактирования дети блока могут быть рендерены отдельным .block-children сразу после него.
  const extraNodes = [];
  let cursor = oldBlockEl.nextElementSibling;
  if (cursor && cursor.classList.contains('block-children')) {
    extraNodes.push(cursor);
  }
  const insertBefore = (extraNodes[extraNodes.length - 1] || oldBlockEl).nextSibling;
  container.removeChild(oldBlockEl);
  extraNodes.forEach((node) => {
    if (node.parentNode === container) {
      container.removeChild(node);
    }
  });
  const tmp = document.createElement('div');
  await renderBlocks([located.block], tmp, depth);
  const newNodes = Array.from(tmp.childNodes);
  newNodes.forEach((node) => {
    container.insertBefore(node, insertBefore);
  });
  cleanupDomBlockDuplicates();
  cleanupOrphanDomBlocks();
}

export async function toggleArticleEncryption() {
  if (!state.article || !state.articleId) {
    showToast('Сначала откройте статью');
    return;
  }
  if (state.articleId === 'inbox') {
    showToast('Быстрые заметки нельзя зашифровать');
    return;
  }
  if (!state.currentUser) {
    showToast('Нужно войти в систему');
    return;
  }

  const article = state.article;

  // Если статья уже зашифрована — считаем это сменой пароля (перешифровкой).
  if (article.encrypted) {
    let payload = null;
    try {
      payload = await showPasswordWithHintPrompt({
        title: 'Сменить пароль',
        message: 'Введите новый пароль и при желании подсказку.',
        confirmText: 'Перешифровать',
        cancelText: 'Отмена',
      });
    } catch (error) {
      payload = null;
    }
    if (!payload || !payload.password) return;
    const { password, hint } = payload;
    try {
      const { key, salt } = await deriveKeyFromPassword(password, '');
      const verifier = await createEncryptionVerifier(key);
      showToast('Перешифровываем содержимое страницы...');
      await encryptAllBlocksOnServer(article, key);
      const updated = await apiRequest(`/api/articles/${state.articleId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          encrypted: true,
          encryptionSalt: salt,
          encryptionVerifier: verifier,
          encryptionHint: hint || null,
        }),
      });
      article.encrypted = true;
      article.encryptionSalt = salt;
      article.encryptionVerifier = verifier;
      article.encryptionHint = hint || null;
      article.updatedAt = updated?.updatedAt || article.updatedAt;
      setCurrentArticleKey(key);
      upsertArticleIndex(updated);
      updateArticleHeaderUi();
      showToast('Пароль обновлён');
      logDebug('toggleArticleEncryption: password changed', {
        id: article.id,
        encrypted: article.encrypted,
        hasSalt: Boolean(article.encryptionSalt),
        hasVerifier: Boolean(article.encryptionVerifier),
      });
    } catch (error) {
      showToast(error.message || 'Не удалось сменить пароль');
    }
    return;
  }

  // Включаем шифрование (переводим открытую статью в закрытую).
  let payload = null;
  try {
    payload = await showPasswordWithHintPrompt({
      title: 'Сделать страницу приватной',
      message: 'Задайте пароль и при желании подсказку. Без пароля восстановить доступ будет невозможно.',
      confirmText: 'Защитить',
      cancelText: 'Отмена',
    });
  } catch (error) {
    payload = null;
  }
  if (!payload || !payload.password) return;
  const { password, hint } = payload;
  try {
    const { key, salt } = await deriveKeyFromPassword(password, '');
    const verifier = await createEncryptionVerifier(key);
    showToast('Шифруем содержимое страницы...');
    await encryptAllBlocksOnServer(article, key);
    const updated = await apiRequest(`/api/articles/${state.articleId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        encrypted: true,
        encryptionSalt: salt,
        encryptionVerifier: verifier,
        encryptionHint: hint || null,
      }),
    });
    article.encrypted = true;
    article.encryptionSalt = salt;
    article.encryptionVerifier = verifier;
    article.encryptionHint = hint || null;
    article.updatedAt = updated?.updatedAt || article.updatedAt;
    setCurrentArticleKey(key);
    upsertArticleIndex(updated);
    updateArticleHeaderUi();
    showToast('Страница зашифрована');
    logDebug('toggleArticleEncryption: enabled', {
      id: article.id,
      encrypted: article.encrypted,
      hasSalt: Boolean(article.encryptionSalt),
      hasVerifier: Boolean(article.encryptionVerifier),
    });
  } catch (error) {
    showToast(error.message || 'Не удалось включить шифрование');
  }
}

export async function removeArticleEncryption() {
  if (!state.article || !state.articleId) {
    showToast('Сначала откройте статью');
    return;
  }
  if (state.articleId === 'inbox') {
    showToast('Быстрые заметки нельзя зашифровать/расшифровать');
    return;
  }
  const article = state.article;
  if (!article.encrypted) {
    showToast('Страница уже не зашифрована');
    return;
  }

  let confirmed = false;
  try {
    confirmed = await showConfirm({
      title: 'Снять защиту?',
      message: 'Содержимое страницы будет сохранено в открытом виде.',
      confirmText: 'Снять защиту',
      cancelText: 'Отмена',
    });
  } catch (error) {
    // eslint-disable-next-line no-alert
    confirmed = window.confirm('Снять защиту и сохранить страницу в открытом виде?');
  }
  if (!confirmed) return;

  try {
    showToast('Сохраняем страницу в открытом виде...');
    if (Array.isArray(article.blocks)) {
      const queue = [...article.blocks];
      // eslint-disable-next-line no-restricted-syntax
      for (const block of queue) {
        const children = Array.isArray(block.children) ? block.children : [];
        queue.push(...children);
        const plainText = block.text || '';
        // eslint-disable-next-line no-await-in-loop
        await apiRequest(`/api/articles/${article.id}/blocks/${block.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ text: plainText }),
        });
      }
    }
    const updated = await apiRequest(`/api/articles/${state.articleId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        encrypted: false,
        encryptionSalt: null,
        encryptionVerifier: null,
      }),
    });
    article.encrypted = false;
    article.encryptionSalt = null;
    article.encryptionVerifier = null;
    article.encryptionHint = null;
    article.updatedAt = updated?.updatedAt || article.updatedAt;
    setCurrentArticleKey(null);
    upsertArticleIndex(updated);
    updateArticleHeaderUi();
    showToast('Шифрование страницы отключено');
    logDebug('removeArticleEncryption: disabled', {
      id: article.id,
      encrypted: article.encrypted,
    });
  } catch (error) {
    showToast(error.message || 'Не удалось отключить шифрование');
  }
}

export async function loadArticle(id, options = {}) {
  const { desiredBlockId, resetUndoStacks, editBlockId } = options;
  const switchingArticle = state.articleId !== id;
  state.articleId = id;
  state.isEditingTitle = false;
  state.pendingTextPreview = null;

  const rawArticle = await fetchArticle(id);
  let article = rawArticle;
  try {
    // eslint-disable-next-line no-await-in-loop
    article = await ensureArticleDecrypted(rawArticle);
  } catch (error) {
    showToast(error.message || 'Не удалось открыть зашифрованную страницу');
    throw error;
  }
  state.article = article;

  const shouldResetUndo = typeof resetUndoStacks === 'boolean' ? resetUndoStacks : switchingArticle;
  if (shouldResetUndo) {
    hydrateUndoRedoFromArticle(article);
  }

  const autoEditTarget = editBlockId || state.pendingEditBlockId || null;
  state.pendingEditBlockId = null;
  const primaryTarget = desiredBlockId || autoEditTarget || null;

  let targetSet = false;
  if (primaryTarget) {
    const desired = findBlock(primaryTarget);
    if (desired) {
      await expandCollapsedAncestors(desired.block.id);
      state.currentBlockId = desired.block.id;
      targetSet = true;
    }
  }
  if (!targetSet && (switchingArticle || !findBlock(state.currentBlockId))) {
    const firstBlock = flattenVisible(article.blocks)[0];
    state.currentBlockId = firstBlock ? firstBlock.id : null;
  }

  if (autoEditTarget && findBlock(autoEditTarget)) {
    state.mode = 'edit';
    state.editingBlockId = autoEditTarget;
  } else {
    state.mode = 'view';
    state.editingBlockId = null;
  }

  upsertArticleIndex(article);
  updatePublicToggleLabel();
  return article;
}

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
      (item) =>
        (item.id && item.id.toLowerCase() === trimmedLc) ||
        ((item.title || '').toLowerCase() === trimmedLc),
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

// ----- Drag and drop for blocks -----
const DRAG_THRESHOLD_PX = 6;
const DROP_INDENT_PX = 20;
const DROP_BEFORE_THRESHOLD = 0.35;
const DROP_AFTER_THRESHOLD = 0.65;
const DRAG_INTERACTIVE_SELECTOR =
  'button, a, input, textarea, select, [contenteditable="true"], .block-edit-actions, .move-block-btn, .collapse-btn';
let activeDrag = null;
let dropLineEl = null;
let dropInsideTarget = null;
let dragPreviewEl = null;
let dragLayerEl = null;
const dragHandleEntries = new Map();
let dragLayerListenersBound = false;

function isDragModeOperational() {
  return Boolean(state.isDragModeEnabled && state.mode === 'view' && state.articleId !== 'inbox');
}

function isInteractiveDragTarget(target) {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest(DRAG_INTERACTIVE_SELECTOR));
}

function cancelActiveDragSession() {
  if (!activeDrag) return;
  window.removeEventListener('pointermove', handlePointerMove);
  window.removeEventListener('pointerup', handlePointerUp);
  window.removeEventListener('pointercancel', handlePointerUp);
  try {
    activeDrag.sourceEl?.releasePointerCapture?.(activeDrag.pointerId);
  } catch (_error) {
    // ignore release errors
  }
  activeDrag = null;
  clearDragUi();
}

function beginDragSession(event, blockId, sourceEl, { bypassInteractiveCheck = false } = {}) {
  if (!state.article) return;
  if (!state.isDragModeEnabled) return;
  if (!isDragModeOperational()) return;
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  if (!bypassInteractiveCheck && isInteractiveDragTarget(event.target)) {
    return;
  }
  const located = findBlock(blockId);
  if (!located) return;

  activeDrag = {
    blockId,
    pointerId: event.pointerId,
    originParentId: located.parent?.id || null,
    originIndex: located.index ?? 0,
    startX: event.clientX,
    startY: event.clientY,
    dragging: false,
    forbidden: collectBlockIds(located.block),
    lastDrop: null,
    sourceEl,
  };

  try {
    sourceEl?.setPointerCapture?.(event.pointerId);
  } catch (_error) {
    /* noop */
  }

  window.addEventListener('pointermove', handlePointerMove);
  window.addEventListener('pointerup', handlePointerUp);
  window.addEventListener('pointercancel', handlePointerUp);
}

function registerBlockDragSource(element, blockId, { allowInteractive = false } = {}) {
  if (!element) return;
  element.addEventListener('pointerdown', (event) => {
    if (!allowInteractive && isInteractiveDragTarget(event.target)) {
      return;
    }
     if (event.pointerType === 'touch' && isDragModeOperational()) {
       event.preventDefault();
     }
    beginDragSession(event, blockId, element, { bypassInteractiveCheck: allowInteractive });
  });
}

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

function updateDragModeUi() {
  const hasArticle = Boolean(state.article);
  const toggleBtn = refs.dragModeToggleBtn;
  if (toggleBtn) {
    toggleBtn.disabled = !hasArticle;
    toggleBtn.classList.toggle('active', Boolean(state.isDragModeEnabled));
    toggleBtn.setAttribute('aria-pressed', state.isDragModeEnabled ? 'true' : 'false');
    let title = state.isDragModeEnabled ? 'Перетащите блок за его поверхность' : 'Включить режим перетаскивания блоков';
    if (!hasArticle) {
      title = 'Откройте статью, чтобы управлять перетаскиванием';
    } else if (state.articleId === 'inbox') {
      title = 'Перетаскивание недоступно в быстрых заметках';
    } else if (state.mode !== 'view') {
      title = 'Перетащить блок можно только в режиме просмотра';
    }
    toggleBtn.title = title;
  }
  const isReady = isDragModeOperational();
  const hosts = [refs.articleView, refs.blocksContainer];
  hosts.forEach((node) => {
    if (!node) return;
    node.classList.toggle('drag-mode-enabled', isReady);
  });
  document.body.classList.toggle('drag-mode-enabled', isReady);
}

function collectBlockIds(block, acc = new Set()) {
  if (!block) return acc;
  acc.add(block.id);
  (block.children || []).forEach((child) => collectBlockIds(child, acc));
  return acc;
}

function ensureDropLine() {
  if (dropLineEl) return dropLineEl;
  const el = document.createElement('div');
  el.className = 'block-drop-line hidden';
  document.body.appendChild(el);
  dropLineEl = el;
  return el;
}

function clearDragUi() {
  if (dropLineEl) dropLineEl.classList.add('hidden');
  if (dropInsideTarget) {
    dropInsideTarget.classList.remove('drop-inside-target');
    dropInsideTarget = null;
  }
  if (dragPreviewEl) {
    dragPreviewEl.remove();
    dragPreviewEl = null;
  }
  document.body.classList.remove('block-dnd-active');
}

function updateDragPreviewPosition(event) {
  if (!dragPreviewEl) return;
  dragPreviewEl.style.left = `${event.clientX + 12}px`;
  dragPreviewEl.style.top = `${event.clientY + 12}px`;
}

function createDragPreview(blockId) {
  const preview = document.createElement('div');
  preview.className = 'block-drag-preview';
  const blockEl = refs.blocksContainer?.querySelector(`.block[data-block-id="${blockId}"]`);
  const titleText = blockEl?.querySelector('.block-title')?.textContent?.trim();
  const bodyText = blockEl?.querySelector('.block-text')?.textContent?.trim();
  preview.textContent = titleText || bodyText || 'Блок';
  document.body.appendChild(preview);
  dragPreviewEl = preview;
}

function ensureDragLayer() {
  if (dragLayerEl && dragLayerEl.isConnected) {
    if (refs.blocksContainer && dragLayerEl.parentNode !== refs.blocksContainer) {
      refs.blocksContainer.appendChild(dragLayerEl);
    }
    return dragLayerEl;
  }
  dragLayerEl = document.createElement('div');
  dragLayerEl.className = 'drag-layer';
  if (refs.blocksContainer) {
    refs.blocksContainer.appendChild(dragLayerEl);
    if (!dragLayerListenersBound) {
      refs.blocksContainer.addEventListener('scroll', refreshDragHandlePositions, { passive: true });
      window.addEventListener('resize', refreshDragHandlePositions, { passive: true });
      dragLayerListenersBound = true;
    }
  }
  return dragLayerEl;
}

function clearDragLayer() {
  dragHandleEntries.clear();
  if (dragLayerEl) dragLayerEl.innerHTML = '';
}

function refreshDragHandlePositions() {
  const container = refs.blocksContainer;
  if (!container || !dragLayerEl) return;
  const containerRect = container.getBoundingClientRect();
  const scrollTop = container.scrollTop;
  dragHandleEntries.forEach(({ handle, blockEl }) => {
    const rect = blockEl.getBoundingClientRect();
    const headerLeft = blockEl.querySelector('.block-header__left');
    const header = blockEl.querySelector('.block-header');
    const collapseBtn = blockEl.querySelector('.collapse-btn');
    const headerLeftRect = headerLeft?.getBoundingClientRect();
    const headerRect = header?.getBoundingClientRect();
    const collapseRect = collapseBtn?.getBoundingClientRect();
    const reference =
      (headerLeftRect && headerLeftRect.height > 0 ? headerLeftRect : null) ||
      (headerRect && headerRect.height > 0 ? headerRect : null) ||
      (collapseRect && collapseRect.height > 0 ? collapseRect : null) ||
      rect;
    const top = reference.top - containerRect.top + scrollTop + reference.height / 2;
    handle.style.top = `${top}px`;
    handle.style.right = '8px';
  });
}

function addOverlayDragHandle(blockEl, blockId) {
  const layer = ensureDragLayer();
  const handle = document.createElement('button');
  handle.type = 'button';
  handle.className = 'block-add-btn drag-layer__handle';
  handle.title = 'Добавить блок ниже';
  handle.setAttribute('aria-label', 'Добавить блок ниже');
  handle.textContent = '+';
  handle.dataset.blockId = blockId;
  registerBlockDragSource(handle, blockId, { allowInteractive: true });
  dragHandleEntries.set(blockId, { handle, blockEl });
  layer.appendChild(handle);
  refreshDragHandlePositions();
}

function updateDropIndicator(target) {
  const line = ensureDropLine();
  if (!target) {
    line.classList.add('hidden');
    if (dropInsideTarget) {
      dropInsideTarget.classList.remove('drop-inside-target');
      dropInsideTarget = null;
    }
    return;
  }

  if (target.placement === 'inside') {
    line.classList.add('hidden');
    if (dropInsideTarget && dropInsideTarget.dataset.blockId !== target.targetId) {
      dropInsideTarget.classList.remove('drop-inside-target');
    }
    dropInsideTarget = refs.blocksContainer?.querySelector(`.block[data-block-id="${target.targetId}"]`) || null;
    if (dropInsideTarget) {
      dropInsideTarget.classList.add('drop-inside-target');
    }
    return;
  }

  if (dropInsideTarget) {
    dropInsideTarget.classList.remove('drop-inside-target');
    dropInsideTarget = null;
  }

  line.classList.remove('hidden');
  const top = target.placement === 'before' ? target.rect.top : target.rect.top + target.rect.height;
  const indentPx = Math.min(target.depth * DROP_INDENT_PX, target.rect.width - 32);
  const left = target.rect.left + indentPx;
  const width = Math.max(target.rect.width - indentPx, 48);
  line.style.top = `${top}px`;
  line.style.left = `${left}px`;
  line.style.width = `${width}px`;
}

function computeDropTarget(clientX, clientY) {
  if (!refs.blocksContainer || !activeDrag) return null;
  const blocks = Array.from(refs.blocksContainer.querySelectorAll('.block'));
  const candidates = blocks.filter((el) => {
    const id = el.dataset.blockId;
    return id && !activeDrag.forbidden.has(id);
  });
  if (!candidates.length) return null;

  let best = null;
  let bestDistance = Infinity;
  candidates.forEach((el) => {
    const rect = el.getBoundingClientRect();
    const centerY = rect.top + rect.height / 2;
    const dist = Math.abs(clientY - centerY);
    if (dist < bestDistance) {
      bestDistance = dist;
      best = el;
    }
  });
  if (!best) return null;

  const rect = best.getBoundingClientRect();
  const ratio = rect.height > 0 ? (clientY - rect.top) / rect.height : 0.5;
  const placement = ratio < DROP_BEFORE_THRESHOLD ? 'before' : ratio > DROP_AFTER_THRESHOLD ? 'after' : 'inside';
  const targetId = best.dataset.blockId;
  const located = findBlock(targetId);
  if (!located) return null;

  const depth = (located.ancestors || []).length;
  const parentId = placement === 'inside' ? targetId : located.parent?.id || null;
  if (activeDrag.forbidden.has(parentId || '')) return null;
  let effectiveTargetId = targetId;
  let effectiveParentId = parentId;
  let effectivePlacement = placement;
  let effectiveRect = rect;
  let effectiveDepth = placement === 'inside' ? depth + 1 : depth;
  let effectiveIndex = effectivePlacement === 'after' ? located.index + 1 : located.index;

  if (effectivePlacement !== 'inside' && located.parent) {
    let climb = located;
    let climbRect = rect;
    const HORIZONTAL_THRESHOLD = rect.left + DROP_INDENT_PX;
    while (climb.parent) {
      const shouldClimbHorizontally = clientX <= HORIZONTAL_THRESHOLD;
      const shouldClimbVertically = clientY <= climbRect.top || clientY >= climbRect.bottom;
      if (!shouldClimbHorizontally && !shouldClimbVertically) break;
      const parentInfo = findBlock(climb.parent.id);
      if (!parentInfo) break;
      const parentEl = refs.blocksContainer?.querySelector(`.block[data-block-id="${parentInfo.block.id}"]`);
      const parentRect = parentEl?.getBoundingClientRect();
      climb = parentInfo;
      climbRect = parentRect || climbRect;
      effectiveTargetId = climb.block.id;
      effectiveRect = climbRect;
      effectiveDepth = (climb.ancestors || []).length;
      effectiveParentId = climb.parent?.id || null;
      effectiveIndex = effectivePlacement === 'after' ? climb.index + 1 : climb.index;
    }
  }

  return {
    targetId: effectiveTargetId,
    placement: effectivePlacement,
    parentId: effectiveParentId,
    index: effectiveIndex,
    depth: effectiveDepth,
    rect: effectiveRect,
  };
}

function autoScrollDuringDrag(event) {
  if (!refs.blocksContainer) return;
  const rect = refs.blocksContainer.getBoundingClientRect();
  const threshold = 60;
  if (event.clientY < rect.top + threshold) {
    refs.blocksContainer.scrollTop -= 12;
  } else if (event.clientY > rect.bottom - threshold) {
    refs.blocksContainer.scrollTop += 12;
  }
}

function handlePointerMove(event) {
  if (!activeDrag || event.pointerId !== activeDrag.pointerId) return;
  if (!isDragModeOperational()) {
    cancelActiveDragSession();
    return;
  }
  const dx = event.clientX - activeDrag.startX;
  const dy = event.clientY - activeDrag.startY;
  if (!activeDrag.dragging) {
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    activeDrag.dragging = true;
    document.body.classList.add('block-dnd-active');
    createDragPreview(activeDrag.blockId);
  }
  event.preventDefault();
  updateDragPreviewPosition(event);
  const dropTarget = computeDropTarget(event.clientX, event.clientY);
  activeDrag.lastDrop = dropTarget;
  updateDropIndicator(dropTarget);
  autoScrollDuringDrag(event);
}

async function handlePointerUp(event) {
  if (!activeDrag || event.pointerId !== activeDrag.pointerId) return;
  const dragSession = activeDrag;
  cancelActiveDragSession();

  const shouldMove = dragSession.dragging && dragSession.lastDrop;
  const dropTarget = dragSession.lastDrop;
  const blockId = dragSession.blockId;

  if (!shouldMove || !dropTarget) return;

  await moveBlockToParent(blockId, dropTarget.parentId || null, dropTarget.index, {
    anchorId: dropTarget.targetId,
    placement: dropTarget.placement,
  });
}

export async function loadArticleView(id) {
  // При открытии страницы всегда выходим из режима редактирования заголовка,
  // чтобы заголовок не «прятался» за полем ввода, особенно на мобильных.
  state.isEditingTitle = false;
  await ensureArticlesIndexLoaded();
  setViewMode(true);
  if (refs.usersView) refs.usersView.classList.add('hidden');
  refs.blocksContainer.innerHTML = 'Загрузка...';
  try {
    const editTarget = state.pendingEditBlockId || undefined;
    // При входе в режим редактирования не скроллим блок к центру,
    // а используем scrollTargetBlockId только для переходов/поиска.
    const desired = state.scrollTargetBlockId || undefined;
    await loadArticle(id, { resetUndoStacks: true, desiredBlockId: desired, editBlockId: editTarget });
    renderArticle();
  } catch (error) {
    refs.blocksContainer.innerHTML = `<p class="meta">Не удалось загрузить статью: ${error.message}</p>`;
  }
}

export async function loadListView() {
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

export function renderArticle() {
  const article = state.article;
  if (!article) return;
  if (Array.isArray(article.blocks)) {
    // Страхуемся от дубликатов блоков с одинаковым id,
    // которые могли появиться из-за локальных оптимистичных операций.
    dedupeBlocksById(article.blocks);
  }
  renderSidebarArticleList();
  const rootBlocks = article.id === 'inbox' ? [...(article.blocks || [])].reverse() : article.blocks;

  updateArticleHeaderUi();
  refs.blocksContainer.innerHTML = '';
  updateDragModeUi();
  clearDragLayer();
  ensureDragLayer();

  const focusEditingBlock = () => {
    if (state.mode !== 'edit' || !state.editingBlockId) return;
    // Для сценариев, где требуется установить каретку в начало (split блока),
    // позиционирование выполняется в requestAnimationFrame ниже.
    if (state.editingCaretPosition === 'start') return;
    const editable = refs.blocksContainer?.querySelector(
      `.block[data-block-id="${state.editingBlockId}"] .block-text[contenteditable="true"]`,
    );
    if (!editable) return;
    const active = document.activeElement;
    if (editable === active || editable.contains(active)) return;
    editable.focus({ preventScroll: true });
    if (editable.scrollHeight > editable.clientHeight) {
      editable.scrollTop = editable.scrollHeight;
    }
    placeCaretAtEnd(editable);
  };

  const ensureEditingBlockVisible = () => {
    if (!state.editingBlockId) return;
    const container = refs.blocksContainer;
    if (!container) return;
    const blockEl = container.querySelector(`.block[data-block-id="${state.editingBlockId}"]`);
    if (!blockEl) return;
    const blockRect = blockEl.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const bottomOverflow = blockRect.bottom - containerRect.bottom;
    const topOverflow = containerRect.top - blockRect.top;
    const padding = 16;
    if (bottomOverflow > 0) {
      container.scrollTop += bottomOverflow + padding;
    } else if (topOverflow > 0) {
      container.scrollTop -= topOverflow + padding;
    }
  };

  renderBlocks(rootBlocks, refs.blocksContainer).then(() => {
    cleanupOrphanDomBlocks();
    cleanupDomBlockDuplicates();
    applyPendingPreviewMarkup();
    if (state.scrollTargetBlockId && state.mode === 'view') {
      const targetId = state.scrollTargetBlockId;
      requestAnimationFrame(() => {
        const target = document.querySelector(`.block[data-block-id="${targetId}"]`);
        if (target) {
          const scrollNode = target.querySelector('.block-content') || target;
          scrollNode.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          const editable = target.querySelector('.block-text[contenteditable="true"]');
          if (editable && state.mode === 'edit' && state.editingBlockId === targetId) {
            editable.focus({ preventScroll: true });
            if (state.editingCaretPosition === 'start') {
              editable.scrollTop = 0;
              placeCaretAtStart(editable);
            } else {
              placeCaretAtEnd(editable);
            }
          } else {
            target.setAttribute('tabindex', '-1');
            target.focus({ preventScroll: true });
          }
        }
        state.currentBlockId = targetId;
        state.scrollTargetBlockId = null;
      });
    }
    // При открытии блока на редактирование не принудительно "центрируем" его,
    // чтобы не было резкого автоскролла.
    focusEditingBlock();
    // В режиме редактирования возвращаем прокрутку списка блоков туда,
    // где она была до входа в edit, чтобы Enter не прокручивал страницу.
    if (state.mode === 'edit' && typeof state.editingScrollTop === 'number' && refs.blocksContainer) {
      refs.blocksContainer.scrollTop = state.editingScrollTop;
    }
  });
}

export function toggleDragMode() {
  if (!state.article) {
    showToast('Откройте статью, чтобы переключить перетаскивание');
    return;
  }
  state.isDragModeEnabled = !state.isDragModeEnabled;
  if (!state.isDragModeEnabled) {
    cancelActiveDragSession();
    updateDragModeUi();
    showToast('Перетаскивание выключено');
    return;
  }
  updateDragModeUi();
  if (state.articleId === 'inbox') {
    showToast('Режим включён, но в быстрых заметках перемещение недоступно');
    return;
  }
  if (state.mode !== 'view') {
    showToast('Режим включён, завершите редактирование, чтобы перетаскивать блоки');
    return;
  }
  showToast('Перетаскивание включено — перетащите блок за его поверхность');
}

export async function createArticle() {
  if (refs.createArticleBtn) refs.createArticleBtn.disabled = true;
  if (refs.sidebarNewArticleBtn) refs.sidebarNewArticleBtn.disabled = true;
  try {
    let title = '';
  try {
      title = await showPrompt({
        title: 'Новая страница',
        message: 'Введите заголовок для новой страницы.',
        confirmText: 'Создать',
        cancelText: 'Отмена',
        placeholder: 'Заголовок страницы',
        defaultValue: '',
      });
    } catch (error) {
      title = window.prompt('Введите заголовок страницы') || '';
    }
    title = (title || '').trim();
    if (!title) return;

    const article = await createArticleApi(title);
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
  navigate(routing.article('inbox'));
  await loadArticleView('inbox');
}

export async function createInboxNote() {
  try {
    await loadArticle('inbox', { resetUndoStacks: true });
    const blocks = state.article?.blocks || [];
    const anchorId = blocks.length ? blocks[blocks.length - 1].id : null;
    let newBlockId = null;
    if (anchorId) {
      const res = await apiRequest(`/api/articles/inbox/blocks/${anchorId}/siblings`, {
        method: 'POST',
        body: JSON.stringify({ direction: 'after' }),
      });
      newBlockId = res?.block?.id || null;
    }
    if (!newBlockId) {
      showToast('Не удалось создать заметку');
      return;
    }
    state.pendingEditBlockId = newBlockId;
    state.scrollTargetBlockId = newBlockId;
    state.mode = 'edit';
    state.editingBlockId = newBlockId;
    navigate(routing.article('inbox'));
    await loadArticle('inbox', { desiredBlockId: newBlockId, editBlockId: newBlockId });
    renderArticle();
  } catch (error) {
    showToast(error.message || 'Не удалось создать заметку');
  }
}

updateDragModeUi();
