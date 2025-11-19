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

function buildModal({ title, message, confirmText, cancelText }) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  const card = document.createElement('div');
  card.className = 'modal-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');

  const header = document.createElement('div');
  header.className = 'modal-header';
  const heading = document.createElement('h3');
  heading.textContent = title || 'Подтверждение';
  header.appendChild(heading);

  const body = document.createElement('div');
  body.className = 'modal-body';
  body.textContent = message || '';

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

  const cleanup = () => {
    if (overlay.parentNode) {
      overlay.classList.add('modal-overlay--hide');
      setTimeout(() => overlay.remove(), 150);
    }
    document.removeEventListener('keydown', onKeyDown);
  };

  const resolve = (value) => {
    if (resolved) return;
    resolved = true;
    cleanup();
    return value;
  };

  const onKeyDown = (event) => {
    if (event.code === 'Escape') {
      event.preventDefault();
      resolver(false);
    }
  };

  const resolver = (value) => {
    resolve(value);
    return value;
  };

  return new Promise((resolvePromise) => {
    confirmBtn.addEventListener('click', () => resolvePromise(resolver(true)));
    cancelBtn.addEventListener('click', () => resolvePromise(resolver(false)));
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) resolvePromise(resolver(false));
    });
    document.addEventListener('keydown', onKeyDown);

    root.appendChild(overlay);
    requestAnimationFrame(() => {
      card.focus({ preventScroll: true });
    });
  });
}
