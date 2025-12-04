import { state } from './state.js';
import { extractBlockSections } from './block.js';
import { escapeHtml, htmlToPlainText } from './utils.js';
import { showToast } from './toast.js';

const DESCRIPTION_LIMIT = 160;
const COLLAPSED_ICON = '▸';
const EXPANDED_ICON = '▾';
const WEBP_QUALITY = 0.82;

export async function exportCurrentArticleAsHtml() {
  if (!state.article) {
    showToast('Нет открытой статьи для экспорта');
    return;
  }
  try {
    showToast('Готовим экспорт...');
    const cssText = await loadCssText();
    const { bodyHtml, plainText, wordCount } = buildExportBody(state.article);
    const { html: inlinedHtml, failures } = await inlineAssets(bodyHtml);
    const description = buildDescription(plainText);
    const exportPayload = buildExportPayload(state.article);
    const html = buildDocument({
      cssText,
      contentHtml: inlinedHtml,
      title: state.article.title || 'Без названия',
      description,
      article: state.article,
      wordCount,
      lang: document.documentElement.lang || 'ru',
      exportPayload,
    });
    triggerDownload(html, makeFileName(state.article.title || 'article'));
    if (failures.length) {
      showToast(`Экспорт завершён с предупреждениями: ${failures.length} вложений не удалось инлайнить`);
      // eslint-disable-next-line no-console
      console.warn('Inline failures', failures);
    } else {
      showToast('HTML сохранён');
    }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Export failed', error);
    showToast(error.message || 'Не удалось выгрузить HTML');
  }
}

async function loadCssText() {
  const response = await fetch('/style.css', { cache: 'no-cache' });
  if (!response.ok) {
    throw new Error('Не удалось загрузить стили для экспорта');
  }
  return response.text();
}

function buildDescription(plainText = '') {
  if (!plainText) return '';
  const snippet = plainText.trim().replace(/\s+/g, ' ');
  if (snippet.length <= DESCRIPTION_LIMIT) return snippet;
  return `${snippet.slice(0, DESCRIPTION_LIMIT).trimEnd()}…`;
}

function makeFileName(title = '') {
  const slug = (title || 'article')
    .toLowerCase()
    .replace(/[^a-z0-9\u0400-\u04ff]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'article';
  return `${slug}.html`;
}

function collectPlainText(blocks = []) {
  const parts = [];
  blocks.forEach((block) => {
    if (block?.text) {
      parts.push(htmlToPlainText(block.text));
    }
    if (block?.children?.length) {
      parts.push(collectPlainText(block.children));
    }
  });
  return parts.flat().filter(Boolean);
}

function renderBlock(block) {
  const { titleHtml, bodyHtml } = extractBlockSections(block.text || '');
  const hasTitle = Boolean(titleHtml);
  const rawBody = hasTitle ? bodyHtml : block.text || '';
  const hasBody = Boolean(rawBody && rawBody.trim());
  const hasChildren = Boolean(block.children?.length);
  const canCollapse = hasTitle || hasChildren;
  const hasNoTitleNoChildren = !hasTitle && !hasChildren;
  const collapsed = Boolean(block.collapsed);

  let collapseBtn = '';
  if (canCollapse || hasNoTitleNoChildren) {
    if (hasNoTitleNoChildren) {
      // Плейсхолдер, как в основном интерфейсе: только для выравнивания.
      collapseBtn =
        '<button class="collapse-btn collapse-btn--placeholder" type="button" aria-hidden="true"></button>';
    } else {
      collapseBtn = `<button class="collapse-btn" type="button" data-block-id="${block.id}" aria-expanded="${
        collapsed ? 'false' : 'true'
      }"></button>`;
    }
  }
  const titlePart = hasTitle ? `<div class="block-title">${titleHtml}</div>` : '';
  const header = titlePart
    ? `<div class="block-header${!hasTitle ? ' block-header--no-title' : ''}">${titlePart}</div>`
    : '';

  const bodyClasses = ['block-text', 'block-body'];
  if (!hasTitle) bodyClasses.push('block-body--no-title');
  if (!hasBody) bodyClasses.push('block-body--empty');
  if (collapsed && hasTitle) bodyClasses.push('collapsed');

  const body = `<div class="${bodyClasses.join(' ')}" data-block-body>${rawBody || ''}</div>`;
  const content = `<div class="block-content">${header}${body}</div>`;
  const childrenHtml = (block.children || []).map(renderBlock).join('');
  const children = `<div class="block-children${collapsed ? ' collapsed' : ''}" data-children>${childrenHtml}</div>`;

  const blockClasses = ['block'];
  if (!hasTitle) blockClasses.push('block--no-title');

  // В экспортируемом HTML не нужен интерактивный drag / add-баттон.
  const surface = `<div class="block-surface">${collapseBtn}${content}</div>`;

  return `<div class="${blockClasses.join(' ')}" data-block-id="${block.id}" data-collapsed="${collapsed ? 'true' : 'false'}" tabindex="0">${surface}${children}</div>`;
}

function buildExportBody(article) {
  const blocksHtml = (article.blocks || []).map(renderBlock).join('');
  const plainParts = collectPlainText(article.blocks || []);
  const plainText = plainParts.join(' ').replace(/\s+/g, ' ').trim();
  const wordCount = plainText ? plainText.split(/\s+/).length : 0;
  const updatedLabel = article.updatedAt ? new Date(article.updatedAt).toLocaleString() : '';

  const header = `
    <div class="panel-header article-header">
      <div class="title-block">
        <div class="title-row">
          <h1 class="export-title">${escapeHtml(article.title || 'Без названия')}</h1>
        </div>
        ${updatedLabel ? `<p class="meta">Обновлено: ${escapeHtml(updatedLabel)}</p>` : ''}
      </div>
    </div>
  `;

  const bodyHtml = `
    <div class="export-shell" aria-label="Экспорт статьи">
      <main class="content export-content">
        <section class="panel export-panel" aria-label="Статья">
          ${header}
          <div id="exportBlocksRoot" class="blocks" role="tree">
            ${blocksHtml}
          </div>
        </section>
      </main>
    </div>
  `;

  return { bodyHtml, plainText, wordCount };
}

function buildExportPayload(article) {
  if (!article) {
    return {
      version: 1,
      source: 'memus',
      article: null,
      blocks: [],
    };
  }

  const serializeBlocks = (blocks = []) =>
    (blocks || []).map((block) => ({
      id: block.id,
      text: block.text || '',
      collapsed: Boolean(block.collapsed),
      children: serializeBlocks(block.children || []),
    }));

  return {
    version: 1,
    source: 'memus',
    article: {
      id: article.id,
      title: article.title || '',
      createdAt: article.createdAt || null,
      updatedAt: article.updatedAt || null,
      deletedAt: article.deletedAt || null,
      isInbox: article.id === 'inbox',
      encrypted: Boolean(article.encrypted),
      encryptionHint: article.encryptionHint || null,
    },
    blocks: serializeBlocks(article.blocks || []),
  };
}

async function inlineAssets(html) {
  const template = document.createElement('template');
  template.innerHTML = html;
  const cache = new Map();
  const failures = [];

  const fetchResource = async (url) => {
    if (cache.has(url)) return cache.get(url);
    const absoluteUrl = new URL(url, window.location.href).toString();
    const promise = fetch(absoluteUrl).then(async (response) => {
      if (!response.ok) {
        throw new Error(`Не удалось загрузить ресурс ${url}`);
      }
      return response.blob();
    });
    cache.set(url, promise);
    return promise;
  };

  const blobToDataUrl = (blob) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });

  const convertImageToWebp = async (blob) => {
    const objectUrl = URL.createObjectURL(blob);
    try {
      const image = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.crossOrigin = 'anonymous';
        img.src = objectUrl;
      });
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth || image.width || 1;
      canvas.height = image.naturalHeight || image.height || 1;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(image, 0, 0);
      const webp = canvas.toDataURL('image/webp', WEBP_QUALITY);
      if (!webp || webp === 'data:,') {
        throw new Error('Canvas returned empty webp');
      }
      return webp;
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  };

  const imageNodes = Array.from(template.content.querySelectorAll('img'));
  await Promise.all(
    imageNodes.map(async (img) => {
      const src = img.getAttribute('src') || '';
      if (!src || src.startsWith('data:')) return;
      try {
        const blob = await fetchResource(src);
        try {
          const webpUrl = await convertImageToWebp(blob);
          // Сохраняем исходный путь до uploads, чтобы при импорте можно было
          // переиспользовать существующий файл, а не создавать дубликат.
          img.setAttribute('data-original-src', src);
          img.setAttribute('src', webpUrl);
        } catch (error) {
          // eslint-disable-next-line no-console
          console.warn('WebP convert failed, fallback to base64', error);
          const dataUrl = await blobToDataUrl(blob);
          img.setAttribute('data-original-src', src);
          img.setAttribute('src', dataUrl);
        }
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn('Inline image failed', src, error);
        failures.push(src);
      }
    }),
  );

  const attachmentNodes = Array.from(template.content.querySelectorAll('a')).filter((node) => {
    const href = node.getAttribute('href') || '';
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('data:')) return false;
    if (node.classList.contains('attachment-link')) return true;
    return href.startsWith('/uploads') || href.includes('/uploads/');
  });

  await Promise.all(
    attachmentNodes.map(async (anchor) => {
      const href = anchor.getAttribute('href') || '';
      if (!href || href.startsWith('data:')) return;
      try {
        const blob = await fetchResource(href);
        const dataUrl = await blobToDataUrl(blob);
        // Аналогично картинкам: помечаем исходный путь для дедупликации при импорте.
        anchor.setAttribute('data-original-href', href);
        anchor.setAttribute('href', dataUrl);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn('Inline attachment failed', href, error);
        failures.push(href);
      }
    }),
  );

  return { html: template.innerHTML, failures };
}

function buildDocument({ cssText, contentHtml, title, description, article, wordCount, lang, exportPayload }) {
  const updatedAt = article.updatedAt || '';
  const createdAt = article.createdAt || updatedAt || '';
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: title,
    description,
    dateModified: updatedAt,
    datePublished: createdAt,
    wordCount,
    inLanguage: lang || 'ru',
  };

  const extraCss = `
    body.export-page {
      margin: 0;
      background: #eef2f8;
      overflow: auto;
      height: auto;
    }
    .export-shell {
      min-height: 100vh;
      display: flex;
      justify-content: center;
      background: #eef2f8;
    }
    .export-content {
      padding: 1.5rem 1rem 2rem;
      width: 100%;
      max-width: 960px;
    }
    .export-panel {
      min-height: auto;
      height: auto;
    }
    .block-children.collapsed {
      display: none;
    }
    .block {
      cursor: default;
    }
    .export-title {
      margin: 0;
    }
  `;

  return `
<!doctype html>
<html lang="${escapeHtml(lang || 'ru')}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description || title)}" />
  <meta name="x-memus-export" content="memus;v=1" />
  <meta name="robots" content="index,follow" />
  <meta property="og:type" content="article" />
  <meta property="og:title" content="${escapeHtml(title)}" />
  <meta property="og:description" content="${escapeHtml(description || title)}" />
  <meta name="twitter:card" content="summary_large_image" />
  <style>
${cssText}
${extraCss}
  </style>
  <script type="application/ld+json">
${JSON.stringify(jsonLd, null, 2)}
  </script>
</head>
<body class="export-page">
<script type="application/json" id="memus-export">
${JSON.stringify(exportPayload || null, null, 2)}
</script>
${contentHtml}
<script>
(() => {
  const root = document.getElementById('exportBlocksRoot');
  if (!root) return;
  const collapseIcon = { open: '${EXPANDED_ICON}', closed: '${COLLAPSED_ICON}' };
  let currentId = root.querySelector('.block')?.dataset.blockId || null;

  const getParentBlock = (block) => (block?.parentElement ? block.parentElement.closest('.block') : null);

  const updateBlockView = (block, collapsed) => {
    block.dataset.collapsed = collapsed ? 'true' : 'false';
    const body = block.querySelector('.block-body');
    const noTitle = block.classList.contains('block--no-title');
    if (body && !noTitle) {
      body.classList.toggle('collapsed', collapsed);
    }
    const children = block.querySelector('.block-children');
    if (children) children.classList.toggle('collapsed', collapsed);
    const btn = block.querySelector('.collapse-btn');
    if (btn) {
      btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      btn.textContent = collapsed ? collapseIcon.closed : collapseIcon.open;
    }
  };

  const collectVisible = () => {
    const result = [];
    const walk = (container) => {
      const blocks = Array.from(container.children).filter((node) => node.classList?.contains('block'));
      blocks.forEach((block) => {
        result.push(block);
        const isCollapsed = block.dataset.collapsed === 'true';
        const children = block.querySelector('.block-children');
        if (!isCollapsed && children) walk(children);
      });
    };
    walk(root);
    return result;
  };

  const setCurrent = (block) => {
    if (!block) return;
    currentId = block.dataset.blockId || null;
    root.querySelectorAll('.block.selected').forEach((el) => el.classList.remove('selected'));
    block.classList.add('selected');
    block.focus({ preventScroll: false });
  };

  const toggleBlock = (block, desired) => {
    if (!block) return;
    const collapsed = block.dataset.collapsed === 'true';
    const next = typeof desired === 'boolean' ? desired : !collapsed;
    updateBlockView(block, next);
  };

  const moveSelection = (offset) => {
    if (!currentId) {
      const first = root.querySelector('.block');
      if (first) setCurrent(first);
      return;
    }
    const ordered = collectVisible();
    const index = ordered.findIndex((b) => b.dataset.blockId === currentId);
    if (index === -1) return;
    const next = ordered[index + offset];
    if (next) setCurrent(next);
  };

  const handleArrowLeft = () => {
    if (!currentId) return;
    const block = root.querySelector(\`.block[data-block-id="\${currentId}"]\`);
    if (!block) return;
    const collapsed = block.dataset.collapsed === 'true';
    if (!collapsed) {
      toggleBlock(block, true);
      return;
    }
    const parent = getParentBlock(block);
    if (parent) setCurrent(parent);
  };

  const handleArrowRight = () => {
    if (!currentId) return;
    const block = root.querySelector(\`.block[data-block-id="\${currentId}"]\`);
    if (!block) return;
    const collapsed = block.dataset.collapsed === 'true';
    const firstChild = block.querySelector('.block-children .block');
    if (collapsed) {
      toggleBlock(block, false);
      if (firstChild) setCurrent(firstChild);
      return;
    }
    if (firstChild) {
      setCurrent(firstChild);
    }
  };

  root.addEventListener('click', (event) => {
    const btn = event.target.closest('.collapse-btn');
    if (btn) {
      const targetId = btn.dataset.blockId;
      const block = root.querySelector(\`.block[data-block-id="\${targetId}"]\`);
      toggleBlock(block);
      setCurrent(block);
      return;
    }
    const block = event.target.closest('.block');
    if (block) {
      setCurrent(block);
    }
  });

  document.addEventListener('keydown', (event) => {
    if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Enter', 'Space', ' '].includes(event.code)) {
      event.preventDefault();
    } else {
      return;
    }
    if (event.code === 'ArrowDown') {
      moveSelection(1);
      return;
    }
    if (event.code === 'ArrowUp') {
      moveSelection(-1);
      return;
    }
    if (event.code === 'ArrowLeft') {
      handleArrowLeft();
      return;
    }
    if (event.code === 'ArrowRight') {
      handleArrowRight();
      return;
    }
    if (event.code === 'Enter' || event.code === 'Space' || event.code === ' ') {
      if (!currentId) return;
      const block = root.querySelector(\`.block[data-block-id="\${currentId}"]\`);
      toggleBlock(block);
    }
  });

  const initial = currentId ? root.querySelector(\`.block[data-block-id="\${currentId}"]\`) : root.querySelector('.block');
  if (initial) setCurrent(initial);
})();
</script>
</body>
</html>
`;
}

function triggerDownload(html, filename) {
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
