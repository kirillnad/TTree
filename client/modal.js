import { htmlToLines } from './utils.js';
import { showToast } from './toast.js';

const modalRootId = 'modal-root';

function ensureRoot() {
  let root = document.getElementById(modalRootId);
  if (!root) {
    root = document.createElement('div');
    root.id = modalRootId;
    document.body.appendChild(root);
  }
  return root;
}

function buildModal({ title, message, confirmText, cancelText, renderBody }) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  const form = document.createElement('form');
  form.className = 'modal-form';
  form.addEventListener('submit', (event) => {
    event.preventDefault();
  });

  const card = document.createElement('div');
  card.className = 'modal-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.tabIndex = -1;

  const header = document.createElement('div');
  header.className = 'modal-header';
  const heading = document.createElement('h3');
  heading.textContent = title || 'Подтверждение';
  header.appendChild(heading);

  const body = document.createElement('div');
  body.className = 'modal-body';
  if (typeof renderBody === 'function') {
    const content = renderBody();
    if (Array.isArray(content)) {
      content.forEach((node) => {
        if (node) body.appendChild(node);
      });
    } else if (content) {
      body.appendChild(content);
    }
  } else {
    body.textContent = message || '';
  }

  const footer = document.createElement('div');
  footer.className = 'modal-footer modal-footer--stacked';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'ghost';
  cancelBtn.textContent = cancelText || 'Отмена';
  const confirmBtn = document.createElement('button');
  confirmBtn.type = 'button';
  confirmBtn.className = 'primary danger-btn';
  confirmBtn.textContent = confirmText || 'Удалить';

  footer.appendChild(confirmBtn);
  footer.appendChild(cancelBtn);

  card.appendChild(header);
  card.appendChild(body);
  card.appendChild(footer);
  form.appendChild(card);
  overlay.appendChild(form);

  return { overlay, card, confirmBtn, cancelBtn, form };
}

function diffTextSegments(currentText = '', nextText = '') {
  // LCS via DP is O(m*n) memory/time and will crash on large texts.
  // Use a guard and let the caller fall back to non-diff rendering.
  const m0 = String(currentText || '').length;
  const n0 = String(nextText || '').length;
  const DIFF_MAX_CELLS = 2_000_000; // ~2M ints -> already heavy in JS arrays
  const DIFF_MAX_TOTAL_CHARS = 20_000;
  if (m0 * n0 > DIFF_MAX_CELLS || m0 + n0 > DIFF_MAX_TOTAL_CHARS) {
    return null;
  }

  const a = Array.from(currentText);
  const b = Array.from(nextText);
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      if (a[i] === b[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }
  const operations = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      operations.push({ type: 'same', value: a[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      operations.push({ type: 'removed', value: a[i] });
      i += 1;
    } else {
      operations.push({ type: 'added', value: b[j] });
      j += 1;
    }
  }
  while (i < m) {
    operations.push({ type: 'removed', value: a[i] });
    i += 1;
  }
  while (j < n) {
    operations.push({ type: 'added', value: b[j] });
    j += 1;
  }

  const chunks = [];
  operations.forEach((op) => {
    if (!op.value) return;
    const last = chunks[chunks.length - 1];
    if (last && last.type === op.type) {
      last.value += op.value;
    } else {
      chunks.push({ type: op.type, value: op.value });
    }
  });
  return chunks;
}

function renderDiffFragment({ baseText = '', nextText = '', mode = 'before' } = {}) {
  const frag = document.createDocumentFragment();
  const chunks = diffTextSegments(baseText, nextText);
  if (!chunks) {
    const MAX_RENDER_CHARS = 200_000;
    const raw = mode === 'before' ? String(baseText || '') : String(nextText || '');
    const text = raw.length > MAX_RENDER_CHARS ? `${raw.slice(0, MAX_RENDER_CHARS)}\n\n…(обрезано)` : raw;
    const note = document.createElement('div');
    note.className = 'meta';
    note.style.marginBottom = '6px';
    note.textContent = 'Diff слишком большой — показываем текст без подсветки.';
    const pre = document.createElement('pre');
    pre.className = 'diff-plain';
    pre.style.whiteSpace = 'pre-wrap';
    pre.style.wordBreak = 'break-word';
    pre.textContent = text;
    frag.appendChild(note);
    frag.appendChild(pre);
    return frag;
  }
  chunks.forEach((chunk) => {
    if (mode === 'before' && chunk.type === 'added') return;
    if (mode === 'after' && chunk.type === 'removed') return;
    const span = document.createElement('span');
    span.className = 'diff-seg';
    if (chunk.type === 'added') span.classList.add('diff-seg--added');
    if (chunk.type === 'removed') span.classList.add('diff-seg--removed');
    span.textContent = chunk.value;
    frag.appendChild(span);
  });
  return frag;
}

export function showConfirm(options = {}) {
  const root = ensureRoot();
  const { overlay, card, confirmBtn, cancelBtn, form } = buildModal(options);
  let resolved = false;
  let resolvePromise = () => {};

  const cleanup = () => {
    overlay.classList.add('modal-overlay--hide');
    setTimeout(() => overlay.remove(), 150);
    document.removeEventListener('keydown', onKeyDown);
  };

  const resolveResult = (value) => {
    if (resolved) return;
    resolved = true;
    cleanup();
    resolvePromise(value);
  };

  const onKeyDown = (event) => {
    if (event.code === 'Escape') {
      event.preventDefault();
      resolveResult(false);
    }
    if (event.code === 'Enter') {
      event.preventDefault();
      resolveResult(true);
    }
  };

  return new Promise((resolver) => {
    resolvePromise = resolver;
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      resolveResult(true);
    });
    confirmBtn.addEventListener('click', () => resolveResult(true));
    cancelBtn.addEventListener('click', () => resolveResult(false));
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) resolveResult(false);
    });
    document.addEventListener('keydown', onKeyDown);

    root.appendChild(overlay);
    requestAnimationFrame(() => {
      card.focus({ preventScroll: true });
    });
  });
}

export function showPrompt(options = {}) {
  const root = ensureRoot();
  let inputRef = null;
  let suggestions = Array.isArray(options.suggestions) ? options.suggestions : [];
  let suggestionsBox = null;
  const { overlay, card, confirmBtn, cancelBtn, form } = buildModal({
    ...options,
    renderBody: () => {
      const fragment = document.createDocumentFragment();
      if (options.message) {
        const msg = document.createElement('p');
        msg.className = 'modal-body__text';
        msg.textContent = options.message;
        fragment.appendChild(msg);
      }
      const input = document.createElement('input');
      input.type = options.inputType === 'password' ? 'password' : 'text';
      input.className = 'modal-input';
      input.placeholder = options.placeholder || '';
      input.value = options.defaultValue || '';
      input.autocomplete = 'off';
      fragment.appendChild(input);
      if (suggestions.length) {
        suggestionsBox = document.createElement('div');
        suggestionsBox.className = 'modal-suggestions';
        fragment.appendChild(suggestionsBox);
      }
      inputRef = input;
      return fragment;
    },
  });

  let resolved = false;
  let resolvePromise = () => {};

  const cleanup = () => {
    overlay.classList.add('modal-overlay--hide');
    setTimeout(() => overlay.remove(), 150);
    document.removeEventListener('keydown', onKeyDown);
  };

  const resolveResult = (value) => {
    if (resolved) return;
    resolved = true;
    cleanup();
    if (options.returnMeta) {
      const payload = {
        value: value ?? null,
        selectedId: inputRef?.dataset?.selectedId || null,
      };
      resolvePromise(payload);
    } else {
      resolvePromise(value);
    }
  };

  const onKeyDown = (event) => {
    if (event.code === 'Escape') {
      event.preventDefault();
      resolveResult(null);
      return;
    }
    if (event.code === 'Enter' && inputRef && !options.hideConfirm) {
      const nextValue = inputRef.value.trim();
      if (!nextValue && !options.allowEmpty) return;
      event.preventDefault();
      resolveResult(nextValue);
    }
  };

  const updateConfirmState = () => {
    if (!confirmBtn || !inputRef) return;
    const hasValue = Boolean(inputRef.value.trim());
    confirmBtn.disabled = !hasValue && !options.allowEmpty;
  };

  const renderSuggestions = () => {
    if (!suggestionsBox || !inputRef) return;
    const term = inputRef.value.trim().toLowerCase();
    inputRef.dataset.selectedId = '';
    const filtered = suggestions
      .filter((item) => (item.title || '').toLowerCase().includes(term) || (item.id || '').toLowerCase().includes(term))
      .slice(0, 8);
    suggestionsBox.innerHTML = '';
    if (!term || !filtered.length) {
      suggestionsBox.classList.add('hidden');
      return;
    }
    suggestionsBox.classList.remove('hidden');
    filtered.forEach((item) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'modal-suggestion';
      btn.textContent = item.title || item.id || '';
      btn.addEventListener('click', () => {
        inputRef.value = item.title || item.id || '';
        inputRef.dataset.selectedId = item.id || '';
        updateConfirmState();
        renderSuggestions();
        resolveResult(inputRef.value);
      });
      suggestionsBox.appendChild(btn);
    });
  };

  return new Promise((resolver) => {
    resolvePromise = resolver;
    confirmBtn.classList.remove('danger-btn');
    if (options.hideConfirm) {
      confirmBtn.style.display = 'none';
    } else {
      confirmBtn.textContent = options.confirmText || 'OK';
    }
    cancelBtn.textContent = options.cancelText || 'Cancel';

    const submitHandler = () => {
      if (!inputRef) {
        resolveResult(null);
        return;
      }
      const nextValue = inputRef.value.trim();
      if (!nextValue) {
        inputRef.focus();
        return;
      }
      resolveResult(nextValue);
    };
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      submitHandler();
    });
    confirmBtn.addEventListener('click', submitHandler);
    cancelBtn.addEventListener('click', () => resolveResult(null));
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) resolveResult(null);
    });
    document.addEventListener('keydown', onKeyDown);

    if (inputRef) {
      inputRef.dataset.selectedId = '';
      inputRef.addEventListener('input', () => {
        inputRef.dataset.selectedId = '';
        updateConfirmState();
        if (suggestions.length) renderSuggestions();
      });
      if (options.hideConfirm) {
        inputRef.addEventListener('keydown', (event) => {
          if (event.code === 'Enter') {
            event.preventDefault();
            resolveResult(inputRef.value.trim());
          }
        });
      }
      updateConfirmState();
      if (suggestions.length) renderSuggestions();
    } else {
      updateConfirmState();
    }

    root.appendChild(overlay);
    requestAnimationFrame(() => {
      if (inputRef) {
        inputRef.focus({ preventScroll: true });
        inputRef.select();
      } else {
        card.focus({ preventScroll: true });
      }
    });
  });
}

export function showArticleLinkPrompt(options = {}) {
  const root = ensureRoot();
  let articleInput = null;
  let labelInput = null;
  let suggestions = Array.isArray(options.suggestions) ? options.suggestions : [];
  let suggestionsBox = null;

  const { overlay, card, confirmBtn, cancelBtn, form } = buildModal({
    title: options.title || 'Ссылка на статью',
    renderBody: () => {
      const fragment = document.createDocumentFragment();

      if (options.message) {
        const msg = document.createElement('p');
        msg.className = 'modal-body__text';
        msg.textContent = options.message;
        fragment.appendChild(msg);
      }

      const articleLabel = document.createElement('label');
      articleLabel.className = 'modal-label';
      articleLabel.textContent = options.articleLabel || 'Статья';
      const article = document.createElement('input');
      article.type = 'text';
      article.className = 'modal-input';
      article.placeholder = options.articlePlaceholder || 'ID или название…';
      article.value = options.defaultArticleValue || '';
      article.autocomplete = 'off';
      articleLabel.appendChild(article);
      fragment.appendChild(articleLabel);
      articleInput = article;

      if (suggestions.length) {
        suggestionsBox = document.createElement('div');
        suggestionsBox.className = 'modal-suggestions';
        fragment.appendChild(suggestionsBox);
      }

      const linkLabel = document.createElement('label');
      linkLabel.className = 'modal-label';
      linkLabel.textContent = options.textLabel || 'Текст ссылки (можно пусто)';
      const label = document.createElement('input');
      label.type = 'text';
      label.className = 'modal-input';
      label.placeholder = options.textPlaceholder || '';
      label.value = options.defaultTextValue || '';
      label.autocomplete = 'off';
      linkLabel.appendChild(label);
      fragment.appendChild(linkLabel);
      labelInput = label;

      return fragment;
    },
  });

  let resolved = false;
  let resolvePromise = () => {};

  const cleanup = () => {
    overlay.classList.add('modal-overlay--hide');
    setTimeout(() => overlay.remove(), 150);
    document.removeEventListener('keydown', onKeyDown);
  };

  const resolveResult = (value) => {
    if (resolved) return;
    resolved = true;
    cleanup();
    resolvePromise(value);
  };

  const updateConfirmState = () => {
    if (!confirmBtn || !articleInput) return;
    const hasArticle = Boolean(articleInput.value.trim()) || Boolean(articleInput.dataset.selectedId);
    confirmBtn.disabled = !hasArticle;
  };

  const renderSuggestions = () => {
    if (!suggestionsBox || !articleInput) return;
    const term = articleInput.value.trim().toLowerCase();
    articleInput.dataset.selectedId = '';
    const filtered = suggestions
      .filter((item) => (item.title || '').toLowerCase().includes(term) || (item.id || '').toLowerCase().includes(term))
      .slice(0, 8);
    suggestionsBox.innerHTML = '';
    if (!term || !filtered.length) {
      suggestionsBox.classList.add('hidden');
      return;
    }
    suggestionsBox.classList.remove('hidden');
    filtered.forEach((item) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'modal-suggestion';
      btn.textContent = item.title || item.id || '';
      btn.addEventListener('click', () => {
        articleInput.value = item.title || item.id || '';
        articleInput.dataset.selectedId = item.id || '';
        updateConfirmState();
        renderSuggestions();
        // If user didn't prefill label, we can suggest article title.
        if (labelInput && !labelInput.value.trim() && !(options.lockTextValue || false)) {
          labelInput.value = item.title || '';
        }
        labelInput?.focus?.({ preventScroll: true });
        labelInput?.select?.();
      });
      suggestionsBox.appendChild(btn);
    });
  };

  const onKeyDown = (event) => {
    if (event.code === 'Escape') {
      event.preventDefault();
      resolveResult(null);
      return;
    }
    if (event.code === 'Enter') {
      // Let form submit handle it.
      return;
    }
  };

  return new Promise((resolver) => {
    resolvePromise = resolver;
    confirmBtn.classList.remove('danger-btn');
    confirmBtn.textContent = options.confirmText || 'Вставить';
    cancelBtn.textContent = options.cancelText || 'Отмена';

    const submitHandler = () => {
      if (!articleInput || !labelInput) {
        resolveResult(null);
        return;
      }
      const articleValue = articleInput.value.trim();
      const selectedId = articleInput.dataset.selectedId || '';
      if (!articleValue && !selectedId) {
        articleInput.focus();
        return;
      }
      resolveResult({
        articleValue,
        selectedId: selectedId || null,
        textValue: labelInput.value ?? '',
      });
    };

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      submitHandler();
    });
    confirmBtn.addEventListener('click', submitHandler);
    cancelBtn.addEventListener('click', () => resolveResult(null));
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) resolveResult(null);
    });
    document.addEventListener('keydown', onKeyDown);

    if (articleInput) {
      articleInput.dataset.selectedId = '';
      articleInput.addEventListener('input', () => {
        articleInput.dataset.selectedId = '';
        updateConfirmState();
        if (suggestions.length) renderSuggestions();
      });
      updateConfirmState();
      if (suggestions.length) renderSuggestions();
    } else {
      updateConfirmState();
    }

    root.appendChild(overlay);
    requestAnimationFrame(() => {
      if (articleInput) {
        articleInput.focus({ preventScroll: true });
        articleInput.select();
      } else {
        card.focus({ preventScroll: true });
      }
    });
  });
}

export function showPublicLinkModal(options = {}) {
  const root = ensureRoot();
  let inputRef = null;
  const urlValue = options.url || '';
  const { overlay, card, confirmBtn, cancelBtn } = buildModal({
    title: options.title || 'Публичная ссылка',
    renderBody: () => {
      const fragment = document.createDocumentFragment();
      const label = document.createElement('label');
      label.className = 'modal-label';
      label.textContent = options.label || 'Просмотр по ссылке';
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'modal-input';
      input.value = urlValue;
      input.readOnly = true;
      input.autocomplete = 'off';
      label.appendChild(input);
      inputRef = input;
      fragment.appendChild(label);
      return fragment;
    },
  });

  let resolved = false;
  let resolvePromise = () => {};

  const cleanup = () => {
    overlay.classList.add('modal-overlay--hide');
    setTimeout(() => overlay.remove(), 150);
    document.removeEventListener('keydown', onKeyDown);
  };

  const resolveResult = () => {
    if (resolved) return;
    resolved = true;
    cleanup();
    resolvePromise();
  };

  const onKeyDown = (event) => {
    if (event.code === 'Escape') {
      event.preventDefault();
      resolveResult();
    }
  };

  const legacyCopyUsingExecCommand = (text) => {
    if (!text) return false;
    const tmp = document.createElement('textarea');
    tmp.value = text;
    tmp.setAttribute('readonly', '');
    tmp.style.position = 'absolute';
    tmp.style.left = '-9999px';
    document.body.appendChild(tmp);
    tmp.focus();
    tmp.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (_) {
      ok = false;
    }
    document.body.removeChild(tmp);
    return ok;
  };

  const copyToClipboard = () => {
    const value = (inputRef && inputRef.value) || urlValue;
    if (!value) return;

    // Сразу даём пользователю понятный сигнал и подсказку.
    showToast('Ссылка скопирована');

    // Пытаемся скопировать в буфер обмена, но не завязываемся на результат:
    // на части мобильных браузеров операции могут быть запрещены.
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        const result = navigator.clipboard.writeText(value);
        if (result && typeof result.catch === 'function') {
          result.catch(() => {
            legacyCopyUsingExecCommand(value);
          });
        }
      } else {
        legacyCopyUsingExecCommand(value);
      }
    } catch (_) {
      legacyCopyUsingExecCommand(value);
    }
  };

  return new Promise((resolver) => {
    resolvePromise = resolver;
    confirmBtn.classList.remove('danger-btn');
    confirmBtn.textContent = '⧉ Скопировать ссылку';
    confirmBtn.setAttribute('aria-label', options.copyLabel || 'Скопировать ссылку');
    // Кнопка «Закрыть» в этом диалоге не нужна.
    cancelBtn.classList.add('hidden');

    confirmBtn.addEventListener('click', () => {
      copyToClipboard();
      resolveResult();
    });
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) resolveResult();
    });
    document.addEventListener('keydown', onKeyDown);

    root.appendChild(overlay);
    requestAnimationFrame(() => {
      if (inputRef) {
        inputRef.focus({ preventScroll: true });
      } else {
        card.focus({ preventScroll: true });
      }
    });
  });
}

export function showVersionsPicker(options = {}) {
  const root = ensureRoot();
  const versions = Array.isArray(options.versions) ? options.versions : [];
  let selectedId = versions[0]?.id || '';

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

  const { overlay, card, confirmBtn, cancelBtn, form } = buildModal({
    title: options.title || 'Версии',
    confirmText: options.confirmText || 'Восстановить',
    cancelText: options.cancelText || 'Закрыть',
    renderBody: () => {
      const fragment = document.createDocumentFragment();
      const hint = document.createElement('p');
      hint.className = 'modal-body__text';
      hint.textContent = options.message || 'Выберите версию статьи для восстановления.';
      fragment.appendChild(hint);

      if (!versions.length) {
        const empty = document.createElement('div');
        empty.className = 'modal-empty';
        empty.textContent = 'Версий пока нет.';
        fragment.appendChild(empty);
        return fragment;
      }

      const list = document.createElement('div');
      list.className = 'modal-list';

      versions.forEach((v, idx) => {
        const row = document.createElement('label');
        row.className = 'modal-list__item';

        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'version';
        radio.value = v.id || '';
        radio.checked = idx === 0;
        radio.addEventListener('change', () => {
          selectedId = radio.value;
          confirmBtn.disabled = !selectedId;
          compareBtn.disabled = !selectedId;
        });

        const meta = document.createElement('div');
        meta.className = 'modal-list__meta';

        const title = document.createElement('div');
        title.className = 'modal-list__title';
        title.textContent = v.label || formatTime(v.created_at || v.createdAt);

        const subtitle = document.createElement('div');
        subtitle.className = 'modal-list__subtitle';
        const reason = v.reason || '';
        const created = formatTime(v.created_at || v.createdAt);
        subtitle.textContent = [created, reason].filter(Boolean).join(' · ');

        meta.appendChild(title);
        meta.appendChild(subtitle);

        row.appendChild(radio);
        row.appendChild(meta);
        list.appendChild(row);
      });

      fragment.appendChild(list);
      return fragment;
    },
  });

  card.classList.add('modal-card--diff-light');

  confirmBtn.classList.remove('danger-btn');
  confirmBtn.disabled = !selectedId;

  const compareBtn = document.createElement('button');
  compareBtn.type = 'button';
  compareBtn.className = 'ghost';
  compareBtn.textContent = options.compareText || 'Сравнить';
  compareBtn.disabled = !selectedId;
  const footer = card.querySelector('.modal-footer');
  if (footer) {
    footer.insertBefore(compareBtn, confirmBtn);
  }

  let resolved = false;
  let resolvePromise = () => {};

  const cleanup = () => {
    overlay.classList.add('modal-overlay--hide');
    setTimeout(() => overlay.remove(), 150);
    document.removeEventListener('keydown', onKeyDown);
  };

  const resolveResult = (value) => {
    if (resolved) return;
    resolved = true;
    cleanup();
    resolvePromise(value);
  };

  const onKeyDown = (event) => {
    if (event.code === 'Escape') {
      event.preventDefault();
      resolveResult(null);
    }
  };

  return new Promise((resolver) => {
    resolvePromise = resolver;

    const submitHandler = () => {
      if (!selectedId) return;
      resolveResult({ action: 'restore', versionId: selectedId });
    };

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      submitHandler();
    });
    confirmBtn.addEventListener('click', submitHandler);
    compareBtn.addEventListener('click', () => {
      if (!selectedId) return;
      resolveResult({ action: 'compare', versionId: selectedId });
    });
    cancelBtn.addEventListener('click', () => resolveResult(null));
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) resolveResult(null);
    });
    document.addEventListener('keydown', onKeyDown);

    root.appendChild(overlay);
    requestAnimationFrame(() => {
      card.focus({ preventScroll: true });
    });
  });
}

export function showVersionCompareTargetPicker(options = {}) {
  const root = ensureRoot();
  const versions = Array.isArray(options.versions) ? options.versions : [];
  const excludeId = String(options.excludeId || '');
  const listItems = [
    { kind: 'current', id: '__current__', title: 'Текущая статья' },
    ...versions
      .filter((v) => String(v.id || '') && String(v.id || '') !== excludeId)
      .map((v) => ({
        kind: 'version',
        id: String(v.id),
        title: v.label || v.created_at || v.createdAt || v.id,
      })),
  ];
  let selectedId = listItems[0]?.id || '';

  const { overlay, card, confirmBtn, cancelBtn, form } = buildModal({
    title: options.title || 'Сравнить с…',
    confirmText: options.confirmText || 'Сравнить',
    cancelText: options.cancelText || 'Отмена',
    renderBody: () => {
      const fragment = document.createDocumentFragment();
      const hint = document.createElement('p');
      hint.className = 'modal-body__text';
      hint.textContent = options.message || 'Выберите вторую сторону сравнения.';
      fragment.appendChild(hint);

      const list = document.createElement('div');
      list.className = 'modal-list';
      listItems.forEach((item, idx) => {
        const row = document.createElement('label');
        row.className = 'modal-list__item';
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'compareTarget';
        radio.value = item.id;
        radio.checked = idx === 0;
        radio.addEventListener('change', () => {
          selectedId = radio.value;
          confirmBtn.disabled = !selectedId;
        });

        const meta = document.createElement('div');
        meta.className = 'modal-list__meta';
        const title = document.createElement('div');
        title.className = 'modal-list__title';
        title.textContent = item.title;
        meta.appendChild(title);
        row.appendChild(radio);
        row.appendChild(meta);
        list.appendChild(row);
      });

      fragment.appendChild(list);
      return fragment;
    },
  });

  card.classList.add('modal-card--diff-light');

  confirmBtn.classList.remove('danger-btn');
  confirmBtn.disabled = !selectedId;

  let resolved = false;
  let resolvePromise = () => {};

  const cleanup = () => {
    overlay.classList.add('modal-overlay--hide');
    setTimeout(() => overlay.remove(), 150);
    document.removeEventListener('keydown', onKeyDown);
  };

  const resolveResult = (value) => {
    if (resolved) return;
    resolved = true;
    cleanup();
    resolvePromise(value);
  };

  const onKeyDown = (event) => {
    if (event.code === 'Escape') {
      event.preventDefault();
      resolveResult(null);
    }
  };

  return new Promise((resolver) => {
    resolvePromise = resolver;
    const submitHandler = () => {
      if (!selectedId) return;
      const item = listItems.find((x) => x.id === selectedId) || null;
      if (!item) {
        resolveResult(null);
        return;
      }
      if (item.kind === 'current') {
        resolveResult({ target: 'current' });
        return;
      }
      resolveResult({ target: 'version', versionId: item.id });
    };
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      submitHandler();
    });
    confirmBtn.addEventListener('click', submitHandler);
    cancelBtn.addEventListener('click', () => resolveResult(null));
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) resolveResult(null);
    });
    document.addEventListener('keydown', onKeyDown);
    root.appendChild(overlay);
    requestAnimationFrame(() => {
      card.focus({ preventScroll: true });
    });
  });
}

export function showVersionDiffModal(options = {}) {
  const root = ensureRoot();
  const changes = Array.isArray(options.changes) ? options.changes : [];
  let selected = changes.find((c) => c.type === 'changed') || changes[0] || null;

  const { overlay, card, confirmBtn, cancelBtn } = buildModal({
    title: options.title || 'Отличия версий',
    confirmText: 'Закрыть',
    cancelText: '',
    renderBody: () => {
      const fragment = document.createDocumentFragment();

      const summary = document.createElement('div');
      summary.className = 'diff-summary';
      const counts = changes.reduce(
        (acc, c) => {
          acc[c.type] = (acc[c.type] || 0) + 1;
          return acc;
        },
        { added: 0, removed: 0, changed: 0 },
      );
      summary.textContent = `Изменено: ${counts.changed || 0} · Добавлено: ${counts.added || 0} · Удалено: ${counts.removed || 0}`;
      fragment.appendChild(summary);

      if (!changes.length) {
        const empty = document.createElement('div');
        empty.className = 'modal-empty';
        empty.textContent = 'Нет отличий.';
        fragment.appendChild(empty);
        return fragment;
      }

      const list = document.createElement('div');
      list.className = 'modal-list';
      changes.forEach((c) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = `diff-item diff-item--${c.type}${selected && selected.id === c.id ? ' diff-item--active' : ''}`;
        const label = c.label || c.id;
        row.textContent = `${c.type === 'changed' ? '≠' : c.type === 'added' ? '+' : '−'} ${label}`;
        row.addEventListener('click', () => {
          selected = c;
          // re-render by rebuilding modal content is overkill; just update active class + panes.
          list.querySelectorAll('.diff-item').forEach((el) => el.classList.remove('diff-item--active'));
          row.classList.add('diff-item--active');
          updatePanes();
        });
        list.appendChild(row);
      });
      fragment.appendChild(list);

      const panes = document.createElement('div');
      panes.className = 'diff-panes';
      const beforeWrap = document.createElement('div');
      beforeWrap.className = 'diff-pane-wrap';
      const afterWrap = document.createElement('div');
      afterWrap.className = 'diff-pane-wrap';

      const beforeTitle = document.createElement('div');
      beforeTitle.className = 'diff-pane-title';
      beforeTitle.textContent = options.beforeTitle || 'Версия';
      const afterTitle = document.createElement('div');
      afterTitle.className = 'diff-pane-title';
      afterTitle.textContent = options.afterTitle || 'Текущая';

      const before = document.createElement('div');
      before.className = 'diff-pane diff-pane--before';
      const after = document.createElement('div');
      after.className = 'diff-pane diff-pane--after';

      beforeWrap.appendChild(beforeTitle);
      beforeWrap.appendChild(before);
      afterWrap.appendChild(afterTitle);
      afterWrap.appendChild(after);

      panes.appendChild(beforeWrap);
      panes.appendChild(afterWrap);
      fragment.appendChild(panes);

      const updatePanes = () => {
        const base = selected?.before || '';
        const next = selected?.after || '';
        before.innerHTML = '';
        after.innerHTML = '';
        before.appendChild(renderDiffFragment({ baseText: base, nextText: next, mode: 'before' }));
        after.appendChild(renderDiffFragment({ baseText: base, nextText: next, mode: 'after' }));
      };
      updatePanes();

      return fragment;
    },
  });

  card.classList.add('modal-card--fullscreen');
  card.classList.add('modal-card--diff-light');

  // превращаем confirm в обычный OK и прячем cancel
  confirmBtn.classList.remove('danger-btn');
  if (cancelBtn) cancelBtn.style.display = 'none';

  let resolved = false;
  let resolvePromise = () => {};

  const cleanup = () => {
    overlay.classList.add('modal-overlay--hide');
    setTimeout(() => overlay.remove(), 150);
    document.removeEventListener('keydown', onKeyDown);
  };

  const resolveResult = () => {
    if (resolved) return;
    resolved = true;
    cleanup();
    resolvePromise();
  };

  const onKeyDown = (event) => {
    if (event.code === 'Escape') {
      event.preventDefault();
      resolveResult();
    }
  };

  return new Promise((resolver) => {
    resolvePromise = resolver;
    confirmBtn.addEventListener('click', resolveResult);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) resolveResult();
    });
    document.addEventListener('keydown', onKeyDown);
    root.appendChild(overlay);
    requestAnimationFrame(() => {
      card.focus({ preventScroll: true });
    });
  });
}

export function showBlockHistoryModal(options = {}) {
  const root = ensureRoot();
  const entries = Array.isArray(options.entries) ? options.entries : [];
  let selected = entries[0] || null;
  let activeEntryForRestore = selected;
  let rowButtons = [];
  let updatePanesFn = null;

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
        second: '2-digit',
      }).format(d);
    } catch {
      return String(iso || '');
    }
  };

  const { overlay, card, confirmBtn, cancelBtn } = buildModal({
    title: options.title || 'История блока',
    confirmText: 'Закрыть',
    cancelText: options.canRestore ? 'Восстановить (после изменения)' : '',
    renderBody: () => {
      const fragment = document.createDocumentFragment();
      const hint = document.createElement('p');
      hint.className = 'modal-body__text';
      hint.textContent =
        options.message || 'Выберите изменение. Можно восстановить состояние блока до выбранного изменения.';
      fragment.appendChild(hint);

      if (!entries.length) {
        const empty = document.createElement('div');
        empty.className = 'modal-empty';
        empty.textContent = 'История пуста.';
        fragment.appendChild(empty);
        return fragment;
      }

      const layout = document.createElement('div');
      layout.className = 'diff-layout';

      const list = document.createElement('div');
      list.className = 'modal-list diff-sidebar';
      rowButtons = [];
      entries.forEach((e) => {
        const row = document.createElement('button');
        row.type = 'button';
        const isActive = Boolean(selected && selected.id === e.id);
        row.className = `diff-item${isActive ? ' diff-item--active' : ''}`;
        row.setAttribute('aria-selected', isActive ? 'true' : 'false');
        const timeLabel = formatTime(e.timestamp);
        row.textContent = timeLabel ? `≠ ${timeLabel}` : `≠ ${e.id || ''}`.trim();
        row.addEventListener('click', () => {
          selected = e;
          list.querySelectorAll('.diff-item').forEach((el) => {
            el.classList.remove('diff-item--active');
            el.setAttribute('aria-selected', 'false');
          });
          row.classList.add('diff-item--active');
          row.setAttribute('aria-selected', 'true');
          updatePanes();
        });
        list.appendChild(row);
        rowButtons.push(row);
      });

      const main = document.createElement('div');
      main.className = 'diff-main';

      const panes = document.createElement('div');
      panes.className = 'diff-panes diff-panes--side';
      const beforeWrap = document.createElement('div');
      beforeWrap.className = 'diff-pane-wrap';
      const afterWrap = document.createElement('div');
      afterWrap.className = 'diff-pane-wrap';

      const beforeTitle = document.createElement('div');
      beforeTitle.className = 'diff-pane-title';
      beforeTitle.textContent = options.beforeTitle || 'До';
      const afterTitle = document.createElement('div');
      afterTitle.className = 'diff-pane-title';
      afterTitle.textContent = options.afterTitle || 'После';

      const before = document.createElement('div');
      before.className = 'diff-pane diff-pane--before';
      const after = document.createElement('div');
      after.className = 'diff-pane diff-pane--after';

      beforeWrap.appendChild(beforeTitle);
      beforeWrap.appendChild(before);
      afterWrap.appendChild(afterTitle);
      afterWrap.appendChild(after);
      panes.appendChild(beforeWrap);
      panes.appendChild(afterWrap);
      main.appendChild(panes);
      layout.appendChild(list);
      layout.appendChild(main);
      fragment.appendChild(layout);

      const updatePanes = () => {
        activeEntryForRestore = selected;
        const base = selected?.beforePlain || selected?.before || '';
        const next = selected?.afterPlain || selected?.after || '';
        before.innerHTML = '';
        after.innerHTML = '';
        before.appendChild(renderDiffFragment({ baseText: base, nextText: next, mode: 'before' }));
        after.appendChild(renderDiffFragment({ baseText: base, nextText: next, mode: 'after' }));
      };
      updatePanesFn = updatePanes;
      updatePanes();

      return fragment;
    },
  });

  card.classList.add('modal-card--fullscreen');
  card.classList.add('modal-card--diff-light');

  confirmBtn.classList.remove('danger-btn');
  if (!options.canRestore && cancelBtn) cancelBtn.style.display = 'none';
  if (cancelBtn) cancelBtn.classList.add('danger-btn');

  let resolved = false;
  let resolvePromise = () => {};

  const cleanup = () => {
    overlay.classList.add('modal-overlay--hide');
    setTimeout(() => overlay.remove(), 150);
    document.removeEventListener('keydown', onKeyDown);
  };

  const resolveResult = (value) => {
    if (resolved) return;
    resolved = true;
    cleanup();
    resolvePromise(value);
  };

  const onKeyDown = (event) => {
    if (event.code === 'Escape') {
      event.preventDefault();
      resolveResult(null);
    }
    if (event.code === 'ArrowUp' || event.code === 'ArrowDown') {
      if (!entries.length) return;
      event.preventDefault();
      const currentId = String(selected?.id || '');
      let idx = entries.findIndex((e) => String(e?.id || '') === currentId);
      if (idx < 0) idx = 0;
      idx = event.code === 'ArrowUp' ? Math.max(0, idx - 1) : Math.min(entries.length - 1, idx + 1);
      const nextEntry = entries[idx] || null;
      if (!nextEntry) return;
      selected = nextEntry;
      const btn = rowButtons[idx];
      rowButtons.forEach((el) => {
        el.classList.remove('diff-item--active');
        el.setAttribute('aria-selected', 'false');
      });
      if (btn) {
        btn.classList.add('diff-item--active');
        btn.setAttribute('aria-selected', 'true');
        btn.focus({ preventScroll: true });
        try {
          btn.scrollIntoView({ block: 'nearest' });
        } catch {
          // ignore
        }
      }
      if (typeof updatePanesFn === 'function') updatePanesFn();
    }
  };

  return new Promise((resolver) => {
    resolvePromise = resolver;
    confirmBtn.addEventListener('click', () => resolveResult(null));
    if (cancelBtn && options.canRestore) {
      cancelBtn.addEventListener('click', () =>
        resolveResult({ action: 'restore', entry: activeEntryForRestore || selected || null }),
      );
    }
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) resolveResult(null);
    });
    document.addEventListener('keydown', onKeyDown);
    root.appendChild(overlay);
    requestAnimationFrame(() => {
      card.focus({ preventScroll: true });
    });
  });
}

function extractTextFromTiptapJson(node) {
  const out = [];
  const visit = (n) => {
    if (!n) return;
    if (typeof n === 'string') {
      out.push(n);
      return;
    }
    if (Array.isArray(n)) {
      n.forEach(visit);
      return;
    }
    if (typeof n !== 'object') return;
    if (typeof n.text === 'string') out.push(n.text);
    const content = n.content;
    if (Array.isArray(content)) content.forEach(visit);
  };
  visit(node);
  return out.join('').replace(/\u00a0/g, ' ').trim();
}

function isOutlineHistoryEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  return Boolean(
    entry.beforeHeadingJson ||
      entry.beforeBodyJson ||
      entry.afterHeadingJson ||
      entry.afterBodyJson,
  );
}

export function showArticleHistoryModal(options = {}) {
  const root = ensureRoot();
  const entriesRaw = Array.isArray(options.entries) ? options.entries : [];
  const outlineEntries = entriesRaw.filter(isOutlineHistoryEntry);

  const coercePlain = (value) => String(value ?? '').replace(/\u00a0/g, ' ').trim();
  const entries = outlineEntries.map((e) => ({
    ...e,
    beforePlain: coercePlain(e.beforePlain ?? e.before ?? ''),
    afterPlain: coercePlain(e.afterPlain ?? e.after ?? ''),
  }));

  const bySection = new Map();
  for (const entry of entries) {
    const blockId = String(entry?.blockId || '').trim();
    if (!blockId) continue;
    const group = bySection.get(blockId) || { blockId, entries: [], latestAt: 0, label: '' };
    group.entries.push(entry);
    const ts = Date.parse(entry.timestamp || '') || 0;
    if (ts > group.latestAt) group.latestAt = ts;
    if (!group.label) {
      const heading =
        extractTextFromTiptapJson(entry.afterHeadingJson) ||
        extractTextFromTiptapJson(entry.beforeHeadingJson) ||
        '';
      const fromBody = (entry.afterPlain || entry.beforePlain || '').split('\n').map((s) => s.trim()).find(Boolean) || '';
      group.label = heading || fromBody || 'Без названия';
    }
    bySection.set(blockId, group);
  }

  const sectionsAll = Array.from(bySection.values())
    .sort((a, b) => (b.latestAt || 0) - (a.latestAt || 0));

  let selectedSectionId = sectionsAll[0]?.blockId || null;
  let selectedEntryId = sectionsAll[0]?.entries?.[0]?.id || null;

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
        second: '2-digit',
      }).format(d);
    } catch {
      return String(iso || '');
    }
  };

  const { overlay, card, confirmBtn, cancelBtn } = buildModal({
    title: options.title || 'История статьи',
    confirmText: 'Закрыть',
    cancelText: options.canRestore ? 'Восстановить' : '',
    renderBody: () => {
      const fragment = document.createDocumentFragment();
      const hint = document.createElement('p');
      hint.className = 'modal-body__text';
      hint.textContent =
        options.message ||
        'История изменений outline-режима. Можно восстановить выбранное состояние секции (если секция удалена — вставить в конец статьи).';
      fragment.appendChild(hint);

      if (!sectionsAll.length) {
        const empty = document.createElement('div');
        empty.className = 'modal-empty';
        empty.textContent = 'История пуста.';
        fragment.appendChild(empty);
        return fragment;
      }

      const layout = document.createElement('div');
      layout.className = 'diff-layout';

      const sidebar = document.createElement('div');
      sidebar.className = 'modal-list diff-sidebar';

      const search = document.createElement('input');
      search.type = 'text';
      search.className = 'modal-input';
      search.placeholder = 'Поиск по истории…';
      sidebar.appendChild(search);

      const list = document.createElement('div');
      list.style.marginTop = '8px';
      sidebar.appendChild(list);

      const main = document.createElement('div');
      main.className = 'diff-main';

      const innerLayout = document.createElement('div');
      innerLayout.className = 'diff-layout';

      const eventsList = document.createElement('div');
      eventsList.className = 'modal-list diff-sidebar';

      const panes = document.createElement('div');
      panes.className = 'diff-panes diff-panes--side';
      const beforeWrap = document.createElement('div');
      beforeWrap.className = 'diff-pane-wrap';
      const afterWrap = document.createElement('div');
      afterWrap.className = 'diff-pane-wrap';
      const beforeTitle = document.createElement('div');
      beforeTitle.className = 'diff-pane-title';
      beforeTitle.textContent = options.beforeTitle || 'До';
      const afterTitle = document.createElement('div');
      afterTitle.className = 'diff-pane-title';
      afterTitle.textContent = options.afterTitle || 'После';
      const before = document.createElement('div');
      before.className = 'diff-pane diff-pane--before';
      const after = document.createElement('div');
      after.className = 'diff-pane diff-pane--after';
      beforeWrap.appendChild(beforeTitle);
      beforeWrap.appendChild(before);
      afterWrap.appendChild(afterTitle);
      afterWrap.appendChild(after);
      panes.appendChild(beforeWrap);
      panes.appendChild(afterWrap);

      innerLayout.appendChild(eventsList);
      innerLayout.appendChild(panes);
      main.appendChild(innerLayout);

      layout.appendChild(sidebar);
      layout.appendChild(main);
      fragment.appendChild(layout);

      const renderSections = () => {
        const term = search.value.trim().toLowerCase();
        const visible = term
          ? sectionsAll.filter((s) => {
              if ((s.label || '').toLowerCase().includes(term)) return true;
              return (s.entries || []).some((e) =>
                `${e.beforePlain || ''}\n${e.afterPlain || ''}`.toLowerCase().includes(term),
              );
            })
          : sectionsAll;

        list.innerHTML = '';
        visible.forEach((section) => {
          const btn = document.createElement('button');
          btn.type = 'button';
          const active = section.blockId === selectedSectionId;
          btn.className = `diff-item${active ? ' diff-item--active' : ''}`;
          btn.setAttribute('aria-selected', active ? 'true' : 'false');
          const meta = section.latestAt ? formatTime(new Date(section.latestAt).toISOString()) : '';
          const count = Array.isArray(section.entries) ? section.entries.length : 0;
          btn.textContent = `${section.label || 'Без названия'}${meta ? ` · ${meta}` : ''}${count ? ` · ${count}` : ''}`;
          btn.addEventListener('click', () => {
            selectedSectionId = section.blockId;
            selectedEntryId = section.entries?.[0]?.id || null;
            renderSections();
            renderEvents();
            renderPanes();
          });
          list.appendChild(btn);
        });

        if (selectedSectionId && !visible.some((s) => s.blockId === selectedSectionId)) {
          selectedSectionId = visible[0]?.blockId || null;
          selectedEntryId = visible[0]?.entries?.[0]?.id || null;
          renderEvents();
          renderPanes();
        }
      };

      const renderEvents = () => {
        const section = selectedSectionId ? bySection.get(selectedSectionId) : null;
        const ev = Array.isArray(section?.entries) ? section.entries.slice() : [];
        ev.sort((a, b) => (Date.parse(b.timestamp || '') || 0) - (Date.parse(a.timestamp || '') || 0));
        if (!selectedEntryId) selectedEntryId = ev[0]?.id || null;

        eventsList.innerHTML = '';
        ev.forEach((e) => {
          const btn = document.createElement('button');
          btn.type = 'button';
          const active = String(e.id || '') === String(selectedEntryId || '');
          btn.className = `diff-item${active ? ' diff-item--active' : ''}`;
          btn.setAttribute('aria-selected', active ? 'true' : 'false');
          const time = formatTime(e.timestamp);
          const preview = (e.afterPlain || e.beforePlain || '').slice(0, 64).trim();
          btn.textContent = `${time ? `≠ ${time}` : `≠ ${e.id || ''}`}${preview ? ` · ${preview}` : ''}`;
          btn.addEventListener('click', () => {
            selectedEntryId = e.id || null;
            renderEvents();
            renderPanes();
          });
          eventsList.appendChild(btn);
        });
      };

      const renderPanes = () => {
        const section = selectedSectionId ? bySection.get(selectedSectionId) : null;
        const ev = Array.isArray(section?.entries) ? section.entries : [];
        const selected = ev.find((e) => String(e?.id || '') === String(selectedEntryId || '')) || ev[0] || null;
        const base = selected?.beforePlain || '';
        const next = selected?.afterPlain || '';
        before.innerHTML = '';
        after.innerHTML = '';
        before.appendChild(renderDiffFragment({ baseText: base, nextText: next, mode: 'before' }));
        after.appendChild(renderDiffFragment({ baseText: base, nextText: next, mode: 'after' }));
      };

      search.addEventListener('input', () => {
        renderSections();
      });

      renderSections();
      renderEvents();
      renderPanes();
      return fragment;
    },
  });

  card.classList.add('modal-card--fullscreen');
  card.classList.add('modal-card--diff-light');

  confirmBtn.classList.remove('danger-btn');
  if (!options.canRestore && cancelBtn) cancelBtn.style.display = 'none';
  if (cancelBtn) cancelBtn.classList.add('danger-btn');

  let resolved = false;
  let resolvePromise = () => {};

  const cleanup = () => {
    overlay.classList.add('modal-overlay--hide');
    setTimeout(() => overlay.remove(), 150);
    document.removeEventListener('keydown', onKeyDown);
  };

  const resolveResult = (value) => {
    if (resolved) return;
    resolved = true;
    cleanup();
    resolvePromise(value);
  };

  const onKeyDown = (event) => {
    if (event.code === 'Escape') {
      event.preventDefault();
      resolveResult(null);
    }
  };

  const getSelectedEntry = () => {
    const section = selectedSectionId ? bySection.get(selectedSectionId) : null;
    const ev = Array.isArray(section?.entries) ? section.entries : [];
    return ev.find((e) => String(e?.id || '') === String(selectedEntryId || '')) || ev[0] || null;
  };

  return new Promise((resolver) => {
    resolvePromise = resolver;
    confirmBtn.addEventListener('click', () => resolveResult(null));
    if (cancelBtn && options.canRestore) {
      cancelBtn.addEventListener('click', () => resolveResult({ action: 'restore', entry: getSelectedEntry() }));
    }
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) resolveResult(null);
    });
    document.addEventListener('keydown', onKeyDown);
    root.appendChild(overlay);
    requestAnimationFrame(() => {
      card.focus({ preventScroll: true });
    });
  });
}

export function showLinkPrompt(options = {}) {
  const root = ensureRoot();
  let textInput = null;
  let urlInput = null;
  const { overlay, card, confirmBtn, cancelBtn, form } = buildModal({
    ...options,
    renderBody: () => {
      const fragment = document.createDocumentFragment();
      if (options.message) {
        const msg = document.createElement('p');
        msg.className = 'modal-body__text';
        msg.textContent = options.message;
        fragment.appendChild(msg);
      }

      const textLabel = document.createElement('label');
      textLabel.className = 'modal-label';
      textLabel.textContent = options.textLabel || 'Текст';
      const text = document.createElement('input');
      text.type = 'text';
      text.className = 'modal-input';
      text.placeholder = options.textPlaceholder || 'Текст ссылки';
      text.value = options.defaultText || '';
      text.autocomplete = 'off';
      textLabel.appendChild(text);

      const urlLabel = document.createElement('label');
      urlLabel.className = 'modal-label';
      urlLabel.textContent = options.urlLabel || 'Ссылка';
      const url = document.createElement('input');
      url.type = 'text';
      url.className = 'modal-input';
      url.placeholder = options.urlPlaceholder || 'https://example.com';
      url.value = options.defaultUrl || '';
      url.autocomplete = 'off';
      urlLabel.appendChild(url);

      textInput = text;
      urlInput = url;

      fragment.appendChild(textLabel);
      fragment.appendChild(urlLabel);
      return fragment;
    },
  });

  let resolved = false;
  let resolvePromise = () => {};

  const cleanup = () => {
    overlay.classList.add('modal-overlay--hide');
    setTimeout(() => overlay.remove(), 150);
    document.removeEventListener('keydown', onKeyDown);
  };

  const resolveResult = (payload) => {
    if (resolved) return;
    resolved = true;
    cleanup();
    resolvePromise(payload);
  };

  const onKeyDown = (event) => {
    if (event.code === 'Escape') {
      event.preventDefault();
      resolveResult(null);
      return;
    }
    if (event.code === 'Enter' && !confirmBtn.disabled) {
      event.preventDefault();
      resolveResult({
        text: (textInput?.value || '').trim(),
        url: (urlInput?.value || '').trim(),
      });
    }
  };

  const updateConfirmState = () => {
    const hasUrl = Boolean((urlInput?.value || '').trim());
    confirmBtn.disabled = !hasUrl;
  };

  return new Promise((resolver) => {
    resolvePromise = resolver;
    confirmBtn.classList.remove('danger-btn');
    confirmBtn.textContent = options.confirmText || 'OK';
    cancelBtn.textContent = options.cancelText || 'Cancel';

    const submitHandler = () => {
      resolveResult({
        text: (textInput?.value || '').trim(),
        url: (urlInput?.value || '').trim(),
      });
    };
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!confirmBtn.disabled) {
        submitHandler();
      }
    });
    confirmBtn.addEventListener('click', submitHandler);
    cancelBtn.addEventListener('click', () => resolveResult(null));
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) resolveResult(null);
    });
    document.addEventListener('keydown', onKeyDown);

    const attachInputHandlers = (input) => {
      if (!input) return;
      input.addEventListener('input', updateConfirmState);
    };
    attachInputHandlers(textInput);
    attachInputHandlers(urlInput);
    updateConfirmState();

    root.appendChild(overlay);
    requestAnimationFrame(() => {
      if (urlInput) {
        urlInput.focus({ preventScroll: true });
        if (urlInput.value) {
          urlInput.setSelectionRange(urlInput.value.length, urlInput.value.length);
        }
      } else {
        card.focus({ preventScroll: true });
      }
    });
  });
}

export function showPasswordWithHintPrompt(options = {}) {
  const root = ensureRoot();
  let passwordInput = null;
  let hintInput = null;
  const { overlay, card, confirmBtn, cancelBtn, form } = buildModal({
    ...options,
    renderBody: () => {
      const fragment = document.createDocumentFragment();
      if (options.message) {
        const msg = document.createElement('p');
        msg.className = 'modal-body__text';
        msg.textContent = options.message;
        fragment.appendChild(msg);
      }

      const passLabel = document.createElement('label');
      passLabel.className = 'modal-label';
      passLabel.textContent = 'Пароль';
      const pwd = document.createElement('input');
      pwd.type = 'password';
      pwd.className = 'modal-input';
      pwd.placeholder = 'Пароль для страницы';
      pwd.autocomplete = 'off';
      passLabel.appendChild(pwd);

      const hintLabel = document.createElement('label');
      hintLabel.className = 'modal-label';
      hintLabel.textContent = 'Подсказка (необязательно)';
      const hint = document.createElement('input');
      hint.type = 'text';
      hint.className = 'modal-input';
      hint.placeholder = 'Напоминание о пароле';
      hint.autocomplete = 'off';
      hintLabel.appendChild(hint);

      passwordInput = pwd;
      hintInput = hint;

      fragment.appendChild(passLabel);
      fragment.appendChild(hintLabel);
      return fragment;
    },
  });

  let resolved = false;
  let resolvePromise = () => {};

  const cleanup = () => {
    overlay.classList.add('modal-overlay--hide');
    setTimeout(() => overlay.remove(), 150);
    document.removeEventListener('keydown', onKeyDown);
  };

  const resolveResult = (payload) => {
    if (resolved) return;
    resolved = true;
    cleanup();
    resolvePromise(payload);
  };

  const onKeyDown = (event) => {
    if (event.code === 'Escape') {
      event.preventDefault();
      resolveResult(null);
      return;
    }
    if (event.code === 'Enter' && !confirmBtn.disabled) {
      event.preventDefault();
      resolveResult({
        password: (passwordInput?.value || '').trim(),
        hint: (hintInput?.value || '').trim(),
      });
    }
  };

  const updateConfirmState = () => {
    const hasPassword = Boolean((passwordInput?.value || '').trim());
    confirmBtn.disabled = !hasPassword;
  };

  return new Promise((resolver) => {
    resolvePromise = resolver;
    confirmBtn.classList.remove('danger-btn');
    confirmBtn.textContent = options.confirmText || 'Защитить';
    cancelBtn.textContent = options.cancelText || 'Отмена';

    const submitHandler = () => {
      if (confirmBtn.disabled) return;
      resolveResult({
        password: (passwordInput?.value || '').trim(),
        hint: (hintInput?.value || '').trim(),
      });
    };

    confirmBtn.addEventListener('click', submitHandler);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      submitHandler();
    });
    cancelBtn.addEventListener('click', () => resolveResult(null));
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) resolveResult(null);
    });
    document.addEventListener('keydown', onKeyDown);

    if (passwordInput) {
      passwordInput.addEventListener('input', updateConfirmState);
    }
    updateConfirmState();

    root.appendChild(overlay);
    requestAnimationFrame(() => {
      if (passwordInput) {
        passwordInput.focus({ preventScroll: true });
        passwordInput.select();
      } else {
        card.focus({ preventScroll: true });
      }
    });
  });
}

export function showBlockTrashPicker(options = {}) {
  const root = ensureRoot();
  const items = Array.isArray(options.items) ? options.items : [];
  const { overlay, card, confirmBtn, cancelBtn } = buildModal({
    title: options.title || 'Корзина блоков',
    renderBody: () => {
      const container = document.createElement('div');
      if (!items.length) {
        const p = document.createElement('p');
        p.className = 'modal-body__text';
        p.textContent = 'Корзина блоков пуста';
        container.appendChild(p);
        return container;
      }
      const list = document.createElement('div');
      list.className = 'block-trash-list';
      items.forEach((item) => {
        const row = document.createElement('div');
        row.className = 'block-trash-item';
        const textHtml = (item.block && item.block.text) || '';
        const lines = htmlToLines(textHtml);
        const title = document.createElement('div');
        title.className = 'block-trash-item__title';
        title.textContent = lines[0] || '(пустой блок)';
        const meta = document.createElement('div');
        meta.className = 'block-trash-item__meta';
        const deletedAt = item.deletedAt ? new Date(item.deletedAt).toLocaleString() : '';
        meta.textContent = deletedAt || '';
        const left = document.createElement('div');
        left.className = 'block-trash-item__info';
        left.appendChild(title);
        if (deletedAt) left.appendChild(meta);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'primary';
        btn.textContent = 'Восстановить';
        btn.addEventListener('click', () => {
          resolveResult(item);
        });
        row.appendChild(left);
        row.appendChild(btn);
        list.appendChild(row);
      });
      container.appendChild(list);
      return container;
    },
  });

  let resolved = false;
  let resolvePromise = () => {};

  const cleanup = () => {
    overlay.classList.add('modal-overlay--hide');
    setTimeout(() => overlay.remove(), 150);
    document.removeEventListener('keydown', onKeyDown);
  };

  const resolveResult = (value) => {
    if (resolved) return;
    resolved = true;
    cleanup();
    resolvePromise(value || null);
  };

  const onKeyDown = (event) => {
    if (event.code === 'Escape') {
      event.preventDefault();
      resolveResult(null);
    }
  };

  return new Promise((resolver) => {
    resolvePromise = resolver;
    confirmBtn.classList.remove('hidden');
    confirmBtn.textContent = 'Очистить корзину';
    confirmBtn.classList.add('danger-btn');
    cancelBtn.textContent = 'Закрыть';
    confirmBtn.addEventListener('click', () => resolveResult({ action: 'clear' }));
    cancelBtn.addEventListener('click', () => resolveResult(null));
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) resolveResult(null);
    });
    document.addEventListener('keydown', onKeyDown);
    root.appendChild(overlay);
    requestAnimationFrame(() => {
      card.focus({ preventScroll: true });
    });
  });
}

export function showImportConflictDialog(options = {}) {
  const root = ensureRoot();
  const {
    title,
    message,
    existingTitle,
    importedTitle,
    existingCreatedAt,
    existingUpdatedAt,
    importedCreatedAt,
    importedUpdatedAt,
    allowApplyToAll = true,
  } = options || {};

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  const card = document.createElement('div');
  card.className = 'modal-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.tabIndex = -1;

  const header = document.createElement('div');
  header.className = 'modal-header';
  const heading = document.createElement('h3');
  heading.textContent = title || 'Конфликт при восстановлении';
  header.appendChild(heading);

  const body = document.createElement('div');
  body.className = 'modal-body';

  if (message) {
    const msg = document.createElement('p');
    msg.className = 'modal-body__text';
    msg.textContent = message;
    body.appendChild(msg);
  }

  if (existingTitle || importedTitle) {
    const info = document.createElement('p');
    info.className = 'modal-body__text';
    info.innerHTML = [
      existingTitle ? `<strong>В базе:</strong> ${existingTitle}` : '',
      importedTitle ? `<strong>Из файла:</strong> ${importedTitle}` : '',
    ]
      .filter(Boolean)
      .join('<br />');
    body.appendChild(info);
  }

  if (existingCreatedAt || existingUpdatedAt || importedCreatedAt || importedUpdatedAt) {
    const fmt = (iso) => {
      if (!iso) return '';
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return iso;
      return d.toLocaleString();
    };
    const dates = document.createElement('p');
    dates.className = 'modal-body__text';
    const parts = [];
    if (existingCreatedAt || existingUpdatedAt) {
      const created = existingCreatedAt ? fmt(existingCreatedAt) : '—';
      const updated = existingUpdatedAt ? fmt(existingUpdatedAt) : '—';
      parts.push(
        `<strong>В базе:</strong> создана ${created}, обновлена ${updated}`,
      );
    }
    if (importedCreatedAt || importedUpdatedAt) {
      const created = importedCreatedAt ? fmt(importedCreatedAt) : '—';
      const updated = importedUpdatedAt ? fmt(importedUpdatedAt) : '—';
      parts.push(
        `<strong>Из файла:</strong> создана ${created}, обновлена ${updated}`,
      );
    }
    dates.innerHTML = parts.join('<br />');
    body.appendChild(dates);
  }

  let applyToAllCheckbox = null;
  if (allowApplyToAll) {
    const label = document.createElement('label');
    label.className = 'modal-label';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.style.marginRight = '0.5rem';
    label.appendChild(checkbox);
    label.appendChild(
      document.createTextNode('Применять это решение ко всем конфликтам'),
    );
    applyToAllCheckbox = checkbox;
    body.appendChild(label);
  }

  const footer = document.createElement('div');
  footer.className = 'modal-footer modal-footer--stacked';

  const keepBtn = document.createElement('button');
  keepBtn.type = 'button';
  keepBtn.className = 'ghost';
  keepBtn.textContent = 'Оставить существующую';

  const overwriteBtn = document.createElement('button');
  overwriteBtn.type = 'button';
  overwriteBtn.className = 'primary danger-btn';
  overwriteBtn.textContent = 'Перезаписать';

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'ghost';
  copyBtn.textContent = 'Создать копию';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'ghost';
  cancelBtn.textContent = 'Отмена';

  footer.appendChild(keepBtn);
  footer.appendChild(overwriteBtn);
  footer.appendChild(copyBtn);
  footer.appendChild(cancelBtn);

  card.appendChild(header);
  card.appendChild(body);
  card.appendChild(footer);
  overlay.appendChild(card);

  let resolved = false;
  let resolvePromise = () => {};

  const cleanup = () => {
    overlay.classList.add('modal-overlay--hide');
    setTimeout(() => overlay.remove(), 150);
    document.removeEventListener('keydown', onKeyDown);
  };

  const resolveResult = (action) => {
    if (resolved) return;
    resolved = true;
    const applyToAll = Boolean(applyToAllCheckbox && applyToAllCheckbox.checked);
    cleanup();
    resolvePromise({ action, applyToAll });
  };

  const onKeyDown = (event) => {
    if (event.code === 'Escape') {
      event.preventDefault();
      resolveResult(null);
    }
  };

  return new Promise((resolver) => {
    resolvePromise = resolver;
    keepBtn.addEventListener('click', () => resolveResult('keep'));
    overwriteBtn.addEventListener('click', () => resolveResult('overwrite'));
    copyBtn.addEventListener('click', () => resolveResult('copy'));
    cancelBtn.addEventListener('click', () => resolveResult(null));
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) resolveResult(null);
    });
    document.addEventListener('keydown', onKeyDown);

    root.appendChild(overlay);
    requestAnimationFrame(() => {
      card.focus({ preventScroll: true });
    });
  });
}

export function showImagePreview(src, alt = '') {
  const root = ensureRoot();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay image-modal';

  const wrapper = document.createElement('div');
  wrapper.className = 'image-modal__card';
  wrapper.setAttribute('role', 'dialog');
  wrapper.setAttribute('aria-modal', 'true');
  wrapper.tabIndex = -1;

  const img = document.createElement('img');
  img.className = 'image-modal__img';
  img.src = src;
  if (alt) img.alt = alt;

  wrapper.appendChild(img);
  overlay.appendChild(wrapper);

  let cleanup;
  const resolveClose = () => {
    if (cleanup) cleanup();
  };

  const onKeyDown = (event) => {
    if (event.code === 'Escape') {
      event.preventDefault();
      resolveClose();
    }
  };

  cleanup = () => {
    document.removeEventListener('keydown', onKeyDown);
    overlay.classList.add('modal-overlay--hide');
    setTimeout(() => overlay.remove(), 150);
  };

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) resolveClose();
  });
  document.addEventListener('keydown', onKeyDown);

  root.appendChild(overlay);
  requestAnimationFrame(() => {
    wrapper.focus({ preventScroll: true });
  });
}
