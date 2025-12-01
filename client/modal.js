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
  footer.className = 'modal-footer';
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
