export async function apiRequest(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    credentials: 'include',
    ...options,
  });
  if (!response.ok) {
    const details = await response.json().catch(() => ({}));
    throw new Error(details.detail || 'Request failed');
  }
  if (response.status === 204) {
    return null;
  }
  return response.json();
}

export async function fetchCurrentUser() {
  const response = await fetch('/api/auth/me', {
    method: 'GET',
    credentials: 'include',
  });
  if (response.status === 401) return null;
  if (!response.ok) {
    const details = await response.json().catch(() => ({}));
    throw new Error(details.detail || 'Auth check failed');
  }
  return response.json();
}

export async function login(username, password) {
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.detail || 'Не удалось войти');
  }
  return data;
}

export async function registerUser(username, password, displayName) {
  const response = await fetch('/api/auth/register', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, displayName }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.detail || 'Не удалось создать пользователя');
  }
  return data;
}

export async function logout() {
  await fetch('/api/auth/logout', {
    method: 'POST',
    credentials: 'include',
  });
}

export function fetchArticlesIndex() {
  return apiRequest('/api/articles');
}

export function fetchDeletedArticlesIndex() {
  return apiRequest('/api/articles/deleted');
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

export function deleteArticle(id, options = {}) {
  const force = options.force ? '?force=true' : '';
  return apiRequest(`/api/articles/${id}${force}`, { method: 'DELETE' });
}

export function restoreArticle(id) {
  return apiRequest(`/api/articles/${id}/restore`, { method: 'POST' });
}

export function uploadImageFile(file) {
  const formData = new FormData();
  formData.append('file', file);
  return fetch('/api/uploads', {
    method: 'POST',
    credentials: 'include',
    body: formData,
  }).then((res) => {
    if (!res.ok) throw new Error('Upload failed');
    return res.json();
  });
}

export function uploadAttachmentFile(articleId, file) {
  const formData = new FormData();
  formData.append('file', file);
  return fetch(`/api/articles/${articleId}/attachments`, {
    method: 'POST',
    credentials: 'include',
    body: formData,
  }).then(async (res) => {
    if (!res.ok) {
      const details = await res.json().catch(() => null);
      const message = details?.detail || `Attachment upload failed (status ${res.status})`;
      throw new Error(message);
    }
    return res.json();
  });
}

export function uploadAttachmentFileWithProgress(articleId, file, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/articles/${articleId}/attachments`);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        const percent = Math.round((event.loaded / event.total) * 100);
        onProgress(percent);
      }
    };
    xhr.onreadystatechange = () => {
      if (xhr.readyState !== XMLHttpRequest.DONE) return;
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const data = JSON.parse(xhr.responseText || '{}');
          resolve(data);
        } catch (error) {
          reject(error);
        }
      } else {
        let message = `Attachment upload failed (status ${xhr.status})`;
        try {
          const details = JSON.parse(xhr.responseText || '{}');
          if (details?.detail) message = details.detail;
        } catch (_) {
          /* ignore */
        }
        reject(new Error(message));
      }
    };
    xhr.onerror = () => reject(new Error('Network error during upload'));
    const formData = new FormData();
    formData.append('file', file);
    xhr.send(formData);
  });
}
