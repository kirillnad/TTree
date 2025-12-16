import { refs } from './refs.js';

let hideTimeoutId = null;
let toastProtected = false;

function clearHideTimeout() {
  if (hideTimeoutId !== null) {
    clearTimeout(hideTimeoutId);
    hideTimeoutId = null;
  }
}

function setToastProtected(value) {
  toastProtected = Boolean(value);
  if (!refs.toast) return;
  if (toastProtected) {
    refs.toast.dataset.protected = 'true';
  } else {
    refs.toast.removeAttribute('data-protected');
  }
}

export function showToast(message, options = {}) {
  if (!refs.toast) return;
  const duration = typeof options.duration === 'number' ? options.duration : 2500;
  if (options.protect) {
    setToastProtected(true);
  } else {
    setToastProtected(false);
  }
  clearHideTimeout();
  refs.toast.textContent = message;
  refs.toast.classList.remove('hidden');
  requestAnimationFrame(() => {
    refs.toast.classList.add('show');
  });
  if (duration > 0) {
    hideTimeoutId = setTimeout(() => {
      refs.toast.classList.remove('show');
      setTimeout(() => refs.toast.classList.add('hidden'), 200);
      hideTimeoutId = null;
    }, duration);
  }
}

export function showPersistentToast(message, options = {}) {
  showToast(message, { ...options, duration: 0 });
}

export function hideToast(options = {}) {
  if (!refs.toast) return;
  if (toastProtected && !options.force) {
    return;
  }
  clearHideTimeout();
  setToastProtected(false);
  refs.toast.classList.remove('show');
  refs.toast.classList.add('hidden');
}

// Позволяем пользователю явно закрыть сообщение кликом по тосту.
if (refs.toast) {
  refs.toast.addEventListener('click', () => {
    hideToast();
  });
}
