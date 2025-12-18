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

export function semanticSearch(query) {
  return apiRequest(`/api/search/semantic?q=${encodeURIComponent(query.trim())}`);
}

export function ragSummary(query, results) {
  return apiRequest('/api/search/semantic/rag-summary', {
    method: 'POST',
    body: JSON.stringify({
      query: (query || '').trim(),
      results: Array.isArray(results) ? results : [],
    }),
  });
}

export function createArticle(title) {
  return apiRequest('/api/articles', { method: 'POST', body: JSON.stringify({ title }) });
}

export function replaceArticleBlocksTree(articleId, blocks, options = {}) {
  if (!articleId) {
    return Promise.reject(new Error('articleId is required'));
  }
  const payload = { blocks: Array.isArray(blocks) ? blocks : [] };
  if (options && typeof options.createVersionIfStaleHours === 'number') {
    payload.createVersionIfStaleHours = options.createVersionIfStaleHours;
  }
  if (options && options.docJson) {
    payload.docJson = options.docJson;
  }
  return apiRequest(`/api/articles/${encodeURIComponent(articleId)}/blocks/replace-tree`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

export function deleteArticle(id, options = {}) {
  const force = options.force ? '?force=true' : '';
  return apiRequest(`/api/articles/${id}${force}`, { method: 'DELETE' });
}

export function restoreArticle(id) {
  return apiRequest(`/api/articles/${id}/restore`, { method: 'POST' });
}

export function fetchUsers(adminPassword) {
  const headers = {};
  if (adminPassword) {
    headers['X-Users-Password'] = adminPassword;
  }
  return apiRequest('/api/users', { headers });
}

export function deleteUser(userId) {
  return apiRequest(`/api/users/${userId}`, { method: 'DELETE' });
}

export function createTelegramLinkToken() {
  return apiRequest('/api/telegram/link-token', { method: 'POST', body: JSON.stringify({}) });
}

export function uploadImageFile(file) {
  const formData = new FormData();
  formData.append('file', file);

  const logToServer = (payload) => {
    try {
      fetch('/api/client/log', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'uploadImageFile',
          data: payload,
        }),
      }).catch(() => {});
    } catch {
      // ignore logging errors
    }
  };

  const viaFetch = () =>
    fetch('/api/uploads', {
      method: 'POST',
      credentials: 'include',
      body: formData,
    }).then(async (res) => {
      const details = await res.json().catch(() => null);
      logToServer({
        transport: 'fetch',
        status: res.status,
        ok: res.ok,
        details,
        name: file && file.name,
        type: file && file.type,
        size: file && file.size,
      });
      if (!res.ok) {
        const message = details?.detail || `Upload failed (status ${res.status})`;
        const err = new Error(message);
        err.status = res.status;
        err.details = details;
        throw err;
      }
      return details;
    });

  const viaXhr = () =>
    new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/uploads');
      xhr.withCredentials = true;
      xhr.onreadystatechange = () => {
        if (xhr.readyState !== XMLHttpRequest.DONE) return;
        try {
          const status = xhr.status;
          let details = null;
          try {
            details = JSON.parse(xhr.responseText || 'null');
          } catch {
            details = null;
          }
          logToServer({
            transport: 'xhr',
            status,
            ok: status >= 200 && status < 300,
            details,
            name: file && file.name,
            type: file && file.type,
            size: file && file.size,
          });
          if (status >= 200 && status < 300) {
            resolve(details);
          } else {
            const message =
              (details && details.detail) || `Upload failed (status ${status})`;
            const err = new Error(message);
            err.status = status;
            err.details = details;
            reject(err);
          }
        } catch (error) {
          reject(error);
        }
      };
      xhr.onerror = () => {
        logToServer({
          transport: 'xhr',
          status: 0,
          ok: false,
          details: { detail: 'Network error during image upload' },
          name: file && file.name,
          type: file && file.type,
          size: file && file.size,
        });
        const err = new Error('Upload failed (network error)');
        err.status = 0;
        err.details = { detail: 'Network error during image upload' };
        reject(err);
      };
      xhr.send(formData);
    });

  // Сначала пробуем обычный fetch, а при сетевой ошибке
  // (например, особенности мобильного браузера) — XHR‑фолбек.
  return viaFetch().catch((error) => {
    const msg = String(error && error.message ? error.message : '').toLowerCase();
    if (msg.includes('status ') || msg.includes('upload failed')) {
      // Для «нормальных» HTTP‑ошибок нет смысла дублировать запрос.
      throw error;
    }
    return viaXhr();
  });
}

export function createArticleVersion(articleId, label = null) {
  if (!articleId) {
    return Promise.reject(new Error('articleId is required'));
  }
  const payload = {};
  if (label) payload.label = String(label);
  return apiRequest(`/api/articles/${encodeURIComponent(articleId)}/versions`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function fetchArticleVersions(articleId) {
  if (!articleId) {
    return Promise.reject(new Error('articleId is required'));
  }
  return apiRequest(`/api/articles/${encodeURIComponent(articleId)}/versions`, {
    method: 'GET',
  });
}

export function restoreArticleVersion(articleId, versionId) {
  if (!articleId) {
    return Promise.reject(new Error('articleId is required'));
  }
  if (!versionId) {
    return Promise.reject(new Error('versionId is required'));
  }
  return apiRequest(
    `/api/articles/${encodeURIComponent(articleId)}/versions/${encodeURIComponent(versionId)}/restore`,
    {
      method: 'POST',
      body: JSON.stringify({}),
    },
  );
}

export function fetchArticleVersion(articleId, versionId) {
  if (!articleId) {
    return Promise.reject(new Error('articleId is required'));
  }
  if (!versionId) {
    return Promise.reject(new Error('versionId is required'));
  }
  return apiRequest(
    `/api/articles/${encodeURIComponent(articleId)}/versions/${encodeURIComponent(versionId)}`,
    {
      method: 'GET',
    },
  );
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

export function moveArticlePosition(articleId, direction) {
  if (!articleId || !direction) return Promise.resolve(null);
  return apiRequest(`/api/articles/${encodeURIComponent(articleId)}/move`, {
    method: 'POST',
    body: JSON.stringify({ direction }),
  });
}

export function indentArticleApi(articleId) {
  if (!articleId) return Promise.resolve(null);
  return apiRequest(`/api/articles/${encodeURIComponent(articleId)}/indent`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export function outdentArticleApi(articleId) {
  if (!articleId) return Promise.resolve(null);
  return apiRequest(`/api/articles/${encodeURIComponent(articleId)}/outdent`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export function moveArticleTree(articleId, payload) {
  if (!articleId) return Promise.resolve(null);
  return apiRequest(`/api/articles/${encodeURIComponent(articleId)}/move-tree`, {
    method: 'POST',
    body: JSON.stringify(payload || {}),
  });
}

export async function getYandexUploadUrl({ articleId, filename, overwrite = false, sha256 = '', size = 0 }) {
  const payload = {
    filename: filename || '',
    articleId: articleId || '',
    overwrite: Boolean(overwrite),
    // sha256 сейчас на сервере не используется, но может пригодиться позже.
    sha256: sha256 || '',
    size: typeof size === 'number' ? size : 0,
  };
  const res = await fetch('/api/yandex/disk/upload-url', {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const message = (data && data.detail) || `Yandex upload URL failed (status ${res.status})`;
    throw new Error(message);
  }
  return data;
}

export async function registerYandexAttachment(articleId, { path, originalName, contentType, size }) {
  const payload = {
    path: path || '',
    originalName: originalName || '',
    contentType: contentType || '',
    size: typeof size === 'number' ? size : 0,
  };
  const res = await fetch(`/api/articles/${articleId}/attachments/yandex`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const message = (data && data.detail) || `Register Yandex attachment failed (status ${res.status})`;
    throw new Error(message);
  }
  return data;
}

export async function uploadFileToYandexDisk(articleId, file, { onProgress } = {}) {
  if (!file) throw new Error('Файл не указан');
  let sha256 = '';
  try {
    if (window.crypto && window.crypto.subtle && typeof file.arrayBuffer === 'function') {
      const buffer = await file.arrayBuffer();
      const hashBuffer = await window.crypto.subtle.digest('SHA-256', buffer);
      const bytes = new Uint8Array(hashBuffer);
      sha256 = Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    }
  } catch (_) {
    // Если не удалось посчитать хеш — просто продолжаем без него.
    sha256 = '';
  }

  const { href, method, path, exists, same } = await getYandexUploadUrl({
    articleId,
    filename: file.name || 'attachment',
    overwrite: false,
    sha256,
    size: file.size || 0,
  });

  // Если файл с таким именем уже есть и содержимое совпадает —
  // не загружаем повторно, просто регистрируем вложение.
  if (exists && same && !href) {
    const attachment = await registerYandexAttachment(articleId, {
      path,
      originalName: file.name || 'attachment',
      contentType: file.type || '',
      size: file.size || 0,
    });
    return attachment;
  }

  let uploadedDirect = false;

  if (href) {
    try {
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open(method || 'PUT', href);
        xhr.upload.onprogress = (event) => {
          if (onProgress && event.lengthComputable) {
            const percent = Math.round((event.loaded / event.total) * 100);
            try {
              onProgress(percent);
            } catch (_) {
              /* ignore */
            }
          }
        };
        xhr.onreadystatechange = () => {
          if (xhr.readyState !== XMLHttpRequest.DONE) return;
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve();
          } else {
            reject(new Error(`Yandex upload failed (status ${xhr.status})`));
          }
        };
        xhr.onerror = () => reject(new Error('Network error during Yandex upload'));
        xhr.send(file);
      });
      uploadedDirect = true;
    } catch (error) {
      // На некоторых мобильных браузерах прямой PUT на Яндекс.Диск
      // может падать (status 0/CORS). В этом случае пробуем
      // серверный аплоад через /api/articles/{id}/attachments.
      console.warn('[attachments] Direct Yandex upload failed, falling back to server upload', error);
      uploadedDirect = false;
    }
  }

  if (uploadedDirect) {
    const attachment = await registerYandexAttachment(articleId, {
      path,
      originalName: file.name || 'attachment',
      contentType: file.type || '',
      size: file.size || 0,
    });
    return attachment;
  }

  // Fallback: загружаем файл через обычный endpoint вложений.
  const attachment = await uploadAttachmentFileWithProgress(articleId, file, onProgress);
  return attachment;
}

export function importArticleFromHtml(file, options = {}) {
  const formData = new FormData();
  formData.append('file', file);
  if (options.mode) {
    formData.append('mode', options.mode);
  }
  if (options.versionPrefix) {
    formData.append('versionPrefix', options.versionPrefix);
  }
  return fetch('/api/import/html', {
    method: 'POST',
    credentials: 'include',
    body: formData,
  }).then(async (res) => {
    const details = await res.json().catch(() => null);
    if (!res.ok) {
      const message = details?.detail || `Import failed (status ${res.status})`;
      throw new Error(message);
    }
    return details;
  });
}

export function importArticleFromMarkdown(file, assetsBaseUrl = '') {
  const formData = new FormData();
  formData.append('file', file);
  if (assetsBaseUrl && typeof assetsBaseUrl === 'string') {
    formData.append('assetsBaseUrl', assetsBaseUrl);
  }
  return fetch('/api/import/markdown', {
    method: 'POST',
    credentials: 'include',
    body: formData,
  }).then(async (res) => {
    const details = await res.json().catch(() => null);
    if (!res.ok) {
      const message = details?.detail || `Import failed (status ${res.status})`;
      throw new Error(message);
    }
    return details;
  });
}

export function importFromLogseqArchive(file, assetsBaseUrl = '') {
  const formData = new FormData();
  formData.append('file', file);
  if (assetsBaseUrl && typeof assetsBaseUrl === 'string') {
    formData.append('assetsBaseUrl', assetsBaseUrl);
  }
  return fetch('/api/import/logseq', {
    method: 'POST',
    credentials: 'include',
    body: formData,
  }).then(async (res) => {
    const details = await res.json().catch(() => null);
    if (!res.ok) {
      const message = details?.detail || `Import failed (status ${res.status})`;
      throw new Error(message);
    }
    return details;
  });
}
