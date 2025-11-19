import { refs } from './refs.js';

export function showToast(message) {
  if (!refs.toast) return;
  refs.toast.textContent = message;
  refs.toast.classList.remove('hidden');
  requestAnimationFrame(() => {
    refs.toast.classList.add('show');
  });
  setTimeout(() => {
    refs.toast.classList.remove('show');
    setTimeout(() => refs.toast.classList.add('hidden'), 200);
  }, 2500);
}
