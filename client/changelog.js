import { state } from './state.js';
import { refs } from './refs.js';

export function refreshLastChangeTimestamp() {
  if (!refs.lastChangeValue) return;
  if (!state.lastChangeTimestamp) {
    refs.lastChangeValue.textContent = 'нет данных';
    return;
  }
  const lastChange = new Date(state.lastChangeTimestamp);
  refs.lastChangeValue.textContent = lastChange.toLocaleString();
  state.lastChangeTimestamp = lastChange.toISOString();
}

export async function loadLastChangeFromChangelog() {
  try {
    if (typeof navigator !== 'undefined' && navigator && navigator.onLine === false) {
      return;
    }
    const resp = await fetch('/api/changelog', { cache: 'no-store' });
    if (!resp.ok) throw new Error('Не удалось загрузить changelog');
    const text = await resp.text();
    const lines = text.trim().split(/\r?\n/).filter((line) => line.trim());
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const match = lines[i].match(/^\[([^\]]+)\]/);
      if (match) {
        state.lastChangeTimestamp = match[1];
        refreshLastChangeTimestamp();
        return;
      }
    }
  } catch (error) {
    console.error('changelog load error', error);
  }
}
