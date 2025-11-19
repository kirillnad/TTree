import { state } from './state.js';

export async function apiRequest(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  if (!response.ok) {
    const details = await response.json().catch(() => ({}));
    throw new Error(details.detail || 'Ошибка запроса');
  }
  if (response.status === 204) {
    return null;
  }
  return response.json();
}

export function fetchArticlesIndex() {
  return apiRequest('/api/articles');
}

export function fetchArticle(id) {
  return apiRequest(`/api/articles/${id}`);
}

export function search(query) {
  return apiRequest(`/api/search?q=${encodeURIComponent(query.trim())}`);
}

export function createArticle(title) {
  return apiRequest('/api/articles', { method: 'POST', body: JSON.stringify({ title }) });
}

export function deleteArticle(id) {
  return apiRequest(`/api/articles/${id}`, { method: 'DELETE' });
}

export function uploadImageFile(file) {
  const formData = new FormData();
  formData.append('file', file);
  return fetch('/api/uploads', {
    method: 'POST',
    body: formData,
  }).then((res) => {
    if (!res.ok) throw new Error('Не удалось загрузить изображение');
    return res.json();
  });
}