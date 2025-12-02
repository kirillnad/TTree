import { refs } from './refs.js';

let hideTimeoutId = null;

function clearHideTimeout() {
  if (hideTimeoutId !== null) {
    clearTimeout(hideTimeoutId);
    hideTimeoutId = null;
  }
}

export function showToast(message, options = {}) {
  if (!refs.toast) return;
  const duration = typeof options.duration === 'number' ? options.duration : 2500;
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

export function showPersistentToast(message) {
  showToast(message, { duration: 0 });
}

export function hideToast() {
  if (!refs.toast) return;
  clearHideTimeout();
  refs.toast.classList.remove('show');
  refs.toast.classList.add('hidden');
}

// Позволяем пользователю явно закрыть сообщение кликом по тосту.
if (refs.toast) {
  refs.toast.addEventListener('click', () => {
    hideToast();
  });
}
