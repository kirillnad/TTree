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
  overlay.appendChild(card);

  return { overlay, card, confirmBtn, cancelBtn };
}

export function showConfirm(options = {}) {
  const root = ensureRoot();
  const { overlay, card, confirmBtn, cancelBtn } = buildModal(options);
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
  const { overlay, card, confirmBtn, cancelBtn } = buildModal({
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
      input.type = 'text';
      input.className = 'modal-input';
      input.placeholder = options.placeholder || '';
      input.value = options.defaultValue || '';
      input.autocomplete = 'off';
      fragment.appendChild(input);
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
    resolvePromise(value);
  };

  const onKeyDown = (event) => {
    if (event.code === 'Escape') {
      event.preventDefault();
      resolveResult(null);
      return;
    }
    if (event.code === 'Enter' && inputRef) {
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

  return new Promise((resolver) => {
    resolvePromise = resolver;
    confirmBtn.classList.remove('danger-btn');
    confirmBtn.textContent = options.confirmText || 'OK';
    cancelBtn.textContent = options.cancelText || 'Cancel';

    confirmBtn.addEventListener('click', () => {
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
    });
    cancelBtn.addEventListener('click', () => resolveResult(null));
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) resolveResult(null);
    });
    document.addEventListener('keydown', onKeyDown);

    if (inputRef) {
      inputRef.addEventListener('input', updateConfirmState);
    }
    updateConfirmState();

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
