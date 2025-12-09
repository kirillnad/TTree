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
      if (!nextValue) return;
      event.preventDefault();
      resolveResult(nextValue);
    }
  };

  const updateConfirmState = () => {
    if (!confirmBtn || !inputRef) return;
    const hasValue = Boolean(inputRef.value.trim());
    confirmBtn.disabled = !hasValue;
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
