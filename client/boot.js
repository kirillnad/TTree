(() => {
  const APP_MODULE = window.__memusAppModule || '/app.js?v=27';
  const BOOT_SESSION_KEY = 'ttree_boot_session_v1';
  const LAST_USER_KEY = 'ttree_last_user_v1';
  const LAST_ACTIVE_KEY = 'ttree_last_active_at_v1';
  const OUTLINE_QUEUE_KEY = 'ttree_outline_autosave_queue_docjson_v1';
  const MAX_QUEUED_SECTIONS = 200;
  const IDLE_MS = 15 * 60 * 1000;
  const SLOW_BOOT_MS = 2500;
  const DEBUG_KEY = 'ttree_debug_quick_notes_v1';

  function debugEnabled() {
    try {
      return window?.localStorage?.getItem?.(DEBUG_KEY) === '1';
    } catch {
      return false;
    }
  }
  function dlog(...args) {
    try {
      if (!debugEnabled()) return;
      // eslint-disable-next-line no-console
      console.log('[quick-notes][boot]', ...args);
    } catch {
      // ignore
    }
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    try {
      navigator.serviceWorker.register('/uploads-sw.js', { scope: '/' }).catch(() => {});
    } catch {
      // ignore
    }
  }

  function isPublicPath() {
    try {
      return String(window.location.pathname || '').startsWith('/p/');
    } catch {
      return false;
    }
  }

  function isOffline() {
    try {
      return Boolean(typeof navigator !== 'undefined' && navigator && navigator.onLine === false);
    } catch {
      return false;
    }
  }

  function isReloadNavigation() {
    try {
      const entries = performance.getEntriesByType?.('navigation') || [];
      const nav = entries && entries[0];
      return String(nav?.type || '') === 'reload';
    } catch {
      return false;
    }
  }

  function readLastActiveMs() {
    try {
      const raw = window.localStorage.getItem(LAST_ACTIVE_KEY) || '';
      const ms = Number(raw);
      return Number.isFinite(ms) ? ms : 0;
    } catch {
      return 0;
    }
  }

  function markActiveNow() {
    try {
      window.localStorage.setItem(LAST_ACTIVE_KEY, String(Date.now()));
    } catch {
      // ignore
    }
  }

  function isIdleTooLong() {
    const last = readLastActiveMs();
    if (!last) return true;
    return Date.now() - last > IDLE_MS;
  }

  function isColdStart() {
    try {
      const prev = window.sessionStorage.getItem(BOOT_SESSION_KEY);
      if (!prev) {
        window.sessionStorage.setItem(BOOT_SESSION_KEY, '1');
        return true;
      }
      return false;
    } catch {
      // If sessionStorage is blocked, assume cold (better UX for quick note).
      return true;
    }
  }

  function hasKnownUser() {
    try {
      const raw = window.localStorage.getItem(LAST_USER_KEY);
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      return Boolean(parsed && (parsed.id || parsed.username));
    } catch {
      return false;
    }
  }

  function uuid() {
    try {
      if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
        return globalThis.crypto.randomUUID();
      }
    } catch {
      // ignore
    }
    return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function readQueuedInboxEntry() {
    try {
      const raw = window.localStorage.getItem(OUTLINE_QUEUE_KEY) || '';
      if (!raw) return null;
      const queue = JSON.parse(raw);
      const entry = queue && typeof queue === 'object' ? queue.inbox : null;
      if (!entry || !entry.docJson || typeof entry.docJson !== 'object') return null;
      return { docJson: entry.docJson, queuedAt: Number(entry.queuedAt || 0) || 0 };
    } catch {
      return null;
    }
  }

  function writeQueuedInboxEntry(docJson) {
    try {
      const raw = window.localStorage.getItem(OUTLINE_QUEUE_KEY) || '';
      const queue = raw ? JSON.parse(raw) : {};
      const nextQueue = queue && typeof queue === 'object' ? queue : {};
      nextQueue.inbox = { docJson, queuedAt: Date.now() };
      window.localStorage.setItem(OUTLINE_QUEUE_KEY, JSON.stringify(nextQueue));
    } catch {
      // ignore
    }
  }

  function countOutlineSections(docJson) {
    try {
      const content = docJson?.content;
      if (!Array.isArray(content)) return 0;
      return content.filter((n) => n && n.type === 'outlineSection').length;
    } catch {
      return 0;
    }
  }

  function buildSectionFromPlainText(text, sectionId) {
    const t = String(text || '').trim();
    const lines = t.split(/\r?\n/);
    const paragraphContent = [];
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line) paragraphContent.push({ type: 'text', text: line });
      if (i !== lines.length - 1) paragraphContent.push({ type: 'hardBreak' });
    }
    return {
      type: 'outlineSection',
      attrs: { id: String(sectionId || uuid()), collapsed: false },
      content: [
        { type: 'outlineHeading', content: [] },
        { type: 'outlineBody', content: [paragraphContent.length ? { type: 'paragraph', content: paragraphContent } : { type: 'paragraph' }] },
        { type: 'outlineChildren', content: [] },
      ],
    };
  }

  function addQuickNoteToQueuedInbox(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return null;
    const note = { id: uuid(), createdAt: nowIso(), text: trimmed };
    const existing = readQueuedInboxEntry();
    const baseDoc = existing?.docJson && typeof existing.docJson === 'object' ? existing.docJson : { type: 'doc', content: [] };
    const baseContent = Array.isArray(baseDoc.content) ? baseDoc.content.slice() : [];

    const section = buildSectionFromPlainText(note.text, note.id);
    const nextContent = [section, ...baseContent].slice(0, MAX_QUEUED_SECTIONS);
    const nextDoc = { ...baseDoc, type: 'doc', content: nextContent };
    writeQueuedInboxEntry(nextDoc);
    dlog('saved.queued', { id: note.id, sections: countOutlineSections(nextDoc) });
    return note;
  }

  function ensureBootStyles() {
    if (document.getElementById('quickNoteBootStyles')) return;
    const style = document.createElement('style');
    style.id = 'quickNoteBootStyles';
    style.textContent = `
      .boot-modal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:99999;display:flex;align-items:center;justify-content:center;padding:16px}
      .boot-modal{width:min(720px,100%);background:#0b1220;border:1px solid rgba(255,255,255,.08);border-radius:16px;box-shadow:0 24px 80px rgba(0,0,0,.5);color:#e5e7eb}
      .boot-modal__hdr{padding:14px 16px;border-bottom:1px solid rgba(255,255,255,.08);display:flex;align-items:center;justify-content:space-between;gap:12px}
      .boot-modal__title{font-size:14px;font-weight:600;letter-spacing:.2px}
      .boot-modal__meta{font-size:12px;color:#9ca3af}
      .boot-modal__body{padding:12px 16px}
      .boot-note{width:100%;min-height:34vh;max-height:52vh;resize:vertical;border:1px solid rgba(255,255,255,.1);border-radius:12px;padding:12px 12px;font:14px/1.35 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;outline:none}
      .boot-note:focus{border-color:rgba(59,130,246,.6);box-shadow:0 0 0 3px rgba(59,130,246,.25)}
      .boot-modal__ftr{padding:12px 16px;border-top:1px solid rgba(255,255,255,.08);display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
      .boot-actions{display:flex;gap:10px;flex-wrap:wrap}
      .boot-btn{appearance:none;border:1px solid rgba(255,255,255,.14);background:#111827;color:#e5e7eb;border-radius:999px;padding:10px 14px;font:600 13px/1 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;cursor:pointer}
      .boot-btn:hover{background:#0f172a}
      .boot-btn--primary{background:#2563eb;border-color:#2563eb}
      .boot-btn--primary:hover{background:#1d4ed8}
      .boot-btn--ghost{background:transparent}
      .boot-hint{font-size:12px;color:#9ca3af}
      .boot-toast{margin-left:auto;font-size:12px;color:#a7f3d0}
    `;
    document.head.appendChild(style);
  }

  function runOnIdle(fn, { timeout = 5000, fallbackDelay = 1200 } = {}) {
    try {
      if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(() => fn(), { timeout });
        return;
      }
    } catch {
      // ignore
    }
    setTimeout(() => fn(), fallbackDelay);
  }

  function loadFullAppInBackground() {
    runOnIdle(() => {
      try {
        import(APP_MODULE).catch(() => {});
      } catch {
        // ignore
      }
    });
  }

  function showQuickNoteModal({ reason = '' } = {}) {
    ensureBootStyles();

    const backdrop = document.createElement('div');
    backdrop.className = 'boot-modal-backdrop';

    const modal = document.createElement('div');
    modal.className = 'boot-modal';

    const header = document.createElement('div');
    header.className = 'boot-modal__hdr';

    const left = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'boot-modal__title';
    title.textContent = 'Быстрая заметка (оффлайн-буфер)';
    const meta = document.createElement('div');
    meta.className = 'boot-modal__meta';
    const entry = readQueuedInboxEntry();
    const count = entry?.docJson ? countOutlineSections(entry.docJson) : 0;
    meta.textContent = count ? `В очереди: ${count}` : (reason ? `Причина: ${reason}` : 'Можно без интернета и без входа');
    left.appendChild(title);
    left.appendChild(meta);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'boot-btn boot-btn--ghost';
    closeBtn.textContent = 'Закрыть';

    header.appendChild(left);
    header.appendChild(closeBtn);

    const body = document.createElement('div');
    body.className = 'boot-modal__body';
    const textarea = document.createElement('textarea');
    textarea.className = 'boot-note';
    textarea.placeholder = 'Введите заметку…\n\nCtrl+Enter — сохранить\nEsc — закрыть';
    body.appendChild(textarea);

    const footer = document.createElement('div');
    footer.className = 'boot-modal__ftr';

    const hint = document.createElement('div');
    hint.className = 'boot-hint';
    hint.textContent = 'Заметки сохраняются локально и будут отправлены в “Быстрые заметки” при следующем входе.';

    const actions = document.createElement('div');
    actions.className = 'boot-actions';

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'boot-btn boot-btn--primary';
    saveBtn.textContent = 'Сохранить';

    const saveMoreBtn = document.createElement('button');
    saveMoreBtn.type = 'button';
    saveMoreBtn.className = 'boot-btn';
    saveMoreBtn.textContent = 'Сохранить и ещё';

    actions.appendChild(saveBtn);
    actions.appendChild(saveMoreBtn);

    const toast = document.createElement('div');
    toast.className = 'boot-toast';

    footer.appendChild(hint);
    footer.appendChild(actions);
    footer.appendChild(toast);

    modal.appendChild(header);
    modal.appendChild(body);
    modal.appendChild(footer);
    backdrop.appendChild(modal);

    const updateMeta = () => {
      const e = readQueuedInboxEntry();
      const c = e?.docJson ? countOutlineSections(e.docJson) : 0;
      meta.textContent = c ? `В очереди: ${c}` : (reason ? `Причина: ${reason}` : 'Можно без интернета и без входа');
    };

    const close = () => {
      try {
        backdrop.remove();
      } catch {
        // ignore
      }
    };

    const save = (keepOpen) => {
      const note = addQuickNoteToQueuedInbox(textarea.value);
      if (!note) return;
      textarea.value = '';
      toast.textContent = 'Сохранено локально';
      updateMeta();
      markActiveNow();
      try {
        window.dispatchEvent(new CustomEvent('memus:queued-inbox-changed', { detail: { note } }));
        dlog('event.dispatched', { type: 'memus:queued-inbox-changed' });
      } catch {
        // ignore
      }
      if (!keepOpen) close();
      setTimeout(() => {
        try {
          toast.textContent = '';
        } catch {
          // ignore
        }
      }, 1200);
    };

    closeBtn.addEventListener('click', close);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close();
    });
    saveBtn.addEventListener('click', () => save(false));
    saveMoreBtn.addEventListener('click', () => save(true));
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        save(true);
      }
    });

    document.body.appendChild(backdrop);
    setTimeout(() => textarea.focus({ preventScroll: true }), 0);
  }

  function attachActivityTracking() {
    const bump = () => markActiveNow();
    try {
      window.addEventListener('pointerdown', bump, { passive: true });
      window.addEventListener('keydown', bump, { passive: true });
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') bump();
      });
    } catch {
      // ignore
    }
  }

  // Public pages should load immediately (no boot modal).
  if (isPublicPath()) {
    registerServiceWorker();
    import(APP_MODULE).catch(() => {});
    return;
  }

  registerServiceWorker();

  const coldStart = isColdStart();
  const knownUser = hasKnownUser();
  const offline = isOffline();
  const reloadNav = isReloadNavigation();
  const idleTooLong = isIdleTooLong();
  attachActivityTracking();
  markActiveNow();

  let modalShown = false;
  const showOnce = (reason) => {
    if (modalShown) return;
    modalShown = true;
    try {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => showQuickNoteModal({ reason }), { once: true });
      } else {
        showQuickNoteModal({ reason });
      }
    } catch {
      // ignore
    }
  };

  const shouldShowNow =
    offline ||
    reloadNav ||
    idleTooLong ||
    (coldStart && knownUser);

  if (shouldShowNow) {
    const reason = offline ? 'нет сети' : reloadNav ? 'перезагрузка' : idleTooLong ? 'простой > 15 мин' : 'холодный старт';
    showOnce(reason);
  }

  // "Slow boot" fallback: if full app hasn't started quickly, show the modal anyway.
  window.setTimeout(() => {
    try {
      if (modalShown) return;
      if (window.__memusAppStarted) return;
      showOnce('медленная загрузка');
    } catch {
      // ignore
    }
  }, SLOW_BOOT_MS);

  // Always load the full app; prefer background/idle when we already show the modal.
  if (modalShown || offline) {
    loadFullAppInBackground();
  } else {
    import(APP_MODULE).catch(() => {});
  }
})();
