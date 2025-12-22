from __future__ import annotations

import base64
import html as html_mod
import json
import mimetypes
import re
from datetime import datetime
from pathlib import Path, PurePosixPath
from typing import Any

from .auth import User
from .doc_json_render import render_outline_doc_json_html
from .outline_doc_json import build_outline_section_plain_text_map

# Вынесено из app/main.py → app/export_utils.py

BASE_DIR = Path(__file__).resolve().parents[2]
UPLOADS_DIR = BASE_DIR / 'uploads'

EXPORT_DESCRIPTION_LIMIT = 160


def _collect_plain_text_from_doc_json(doc_json: Any | None) -> list[str]:
    """
    Collect plain text from outline doc_json (heading+body per section).
    Used for description and wordCount in exported HTML.
    """
    if not doc_json:
        return []
    out: list[str] = []
    try:
        m = build_outline_section_plain_text_map(doc_json)
    except Exception:
        return []
    for _sid, txt in (m or {}).items():
        plain = ' '.join(String(txt or '').split()).strip()
        if plain:
            out.append(plain)
    return out


def _build_export_description(plain_text: str | None) -> str:
    """
    Строит короткое описание статьи (meta description) по первым символам текста.
    """
    if not plain_text:
        return ''
    snippet = ' '.join(plain_text.split())
    if len(snippet) <= EXPORT_DESCRIPTION_LIMIT:
        return snippet
    return f'{snippet[:EXPORT_DESCRIPTION_LIMIT].rstrip()}…'


def _serialize_blocks_for_export(blocks: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    """
    Приводит дерево блоков к тому же формату, который использует клиентский exporter.js
    в buildExportPayload: id/text/collapsed/children.
    """
    if not blocks:
        return []
    result: list[dict[str, Any]] = []
    for blk in blocks:
        if not isinstance(blk, dict):
            continue
        children = blk.get('children') or []
        result.append(
            {
                'id': blk.get('id'),
                'text': blk.get('text') or '',
                'collapsed': bool(blk.get('collapsed')),
                'children': _serialize_blocks_for_export(children),
            },
        )
    return result


def _build_export_payload_for_article(article: dict[str, Any] | None) -> dict[str, Any]:
    """
    Формирует JSON-снапшот memus-export в формате, совместимом с client/exporter.js.
    Этот блок попадает в <script type="application/json" id="memus-export">...</script>.
    """
    if not article:
        return {
            'version': 2,
            'source': 'memus',
            'article': None,
            'docJson': None,
            'blocks': [],
        }

    article_id = article.get('id') or ''
    author_id = article.get('authorId') or ''
    # inbox в базе имеет вид inbox-<userId>, в экспорте достаточно флажка.
    is_inbox = article_id == 'inbox' or (
        isinstance(article_id, str)
        and isinstance(author_id, str)
        and article_id == f'inbox-{author_id}'
    )

    meta = {
        'id': article_id,
        'title': article.get('title') or '',
        'createdAt': article.get('createdAt') or None,
        'updatedAt': article.get('updatedAt') or None,
        'deletedAt': article.get('deletedAt') or None,
        'isInbox': bool(is_inbox),
        'encrypted': bool(article.get('encrypted')),
        'encryptionHint': article.get('encryptionHint') or None,
    }

    return {
        'version': 2,
        'source': 'memus',
        'article': meta,
        'docJson': article.get('docJson') or None,
        # legacy field kept for backwards compatibility
        'blocks': [],
    }


def _build_backup_article_html(article: dict[str, Any], css_text: str, lang: str = 'ru') -> str:
    """
    Собирает полноценный HTML-документ для резервной копии одной статьи:
    - структура блоков и стили такие же, как у клиентского экспорта;
    - внутрь помещается JSON-снапшот memus-export, совместимый с импортом /api/import/html;
    - внутренние ссылки остаются как есть (без переписывания под /p/<slug>).
    """
    title_raw = article.get('title') or 'Без названия'
    title = html_mod.escape(title_raw)
    updated_raw = article.get('updatedAt') or ''
    created_raw = article.get('createdAt') or updated_raw or ''

    # Текст и статистика для description/JSON-LD.
    plain_parts = _collect_plain_text_from_doc_json(article.get('docJson'))
    plain_text = ' '.join(plain_parts).strip()
    word_count = len(plain_text.split()) if plain_text else 0
    description = _build_export_description(plain_text) or title_raw

    # Человеко-читаемая дата обновления для заголовка.
    try:
        updated_label = (
            datetime.fromisoformat(updated_raw).strftime('%Y-%m-%d %H:%M:%S')
            if updated_raw
            else ''
        )
    except Exception:  # noqa: BLE001
        updated_label = updated_raw or ''

    try:
        blocks_html = render_outline_doc_json_html(article.get('docJson'))
    except Exception:  # noqa: BLE001
        blocks_html = ''
    header = f"""
    <div class="panel-header article-header">
      <div class="title-block">
        <div class="title-row">
          <h1 class="export-title">{title}</h1>
        </div>
        {f'<p class="meta">Обновлено: {html_mod.escape(updated_label)}</p>' if updated_label else ''}
      </div>
    </div>
    """
    body_inner = f"""
    <div class="export-shell" aria-label="Экспорт статьи">
      <main class="content export-content">
        <section class="panel export-panel" aria-label="Статья">
          {header}
          <div id="exportBlocksRoot" class="blocks" role="tree">
            {blocks_html}
          </div>
        </section>
      </main>
    </div>
    """

    # Те же базовые стили, что и в публичной версии / клиентском экспорте.
    extra_css = """
    body.export-page {
      margin: 0.1rem;
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
    @media (max-width: 800px) {
      body.export-page .page {
        margin: 0.1rem;
        padding: 0;
        max-width: 100%;
        border-radius: 0;
        box-shadow: none;
      }
      body.export-page .export-content {
        padding: 0.1rem;
      }
    }
    """

    # JSON-LD, как в client/exporter.js.
    json_ld = {
        '@context': 'https://schema.org',
        '@type': 'Article',
        'headline': title_raw,
        'description': description,
        'dateModified': updated_raw or '',
        'datePublished': created_raw or '',
        'wordCount': word_count,
        'inLanguage': lang or 'ru',
    }

    export_payload = _build_export_payload_for_article(article)

    interactions_script = """
    <script>
(function() {
  var root = document.getElementById('exportBlocksRoot');
  if (!root) return;
  var collapseIcon = { open: '▾', closed: '▸' };
  var firstBlock = root.querySelector('.block');
  var currentId = firstBlock ? firstBlock.getAttribute('data-block-id') : null;

  function getParentBlock(block) {
    if (!block || !block.parentElement) return null;
    return block.parentElement.closest('.block');
  }

  function updateBlockView(block, collapsed) {
    block.dataset.collapsed = collapsed ? 'true' : 'false';
    var body = block.querySelector('.block-body');
    var noTitle = block.classList.contains('block--no-title');
    if (body && !noTitle) {
      body.classList.toggle('collapsed', collapsed);
    }
    var children = block.querySelector('.block-children');
    if (children) children.classList.toggle('collapsed', collapsed);
    var btn = block.querySelector('.collapse-btn');
    if (btn) {
      btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      btn.textContent = collapsed ? collapseIcon.closed : collapseIcon.open;
    }
  }

  function collectVisible() {
    var result = [];
    function walk(container) {
      var children = container.children;
      for (var i = 0; i < children.length; i += 1) {
        var node = children[i];
        if (!node.classList || !node.classList.contains('block')) continue;
        result.push(node);
        var isCollapsed = node.dataset.collapsed === 'true';
        var kids = node.querySelector('.block-children');
        if (!isCollapsed && kids) walk(kids);
      }
    }
    walk(root);
    return result;
  }

  function setCurrent(block) {
    if (!block) return;
    currentId = block.getAttribute('data-block-id') || null;
    Array.prototype.forEach.call(
      root.querySelectorAll('.block.selected'),
      function(el) { el.classList.remove('selected'); }
    );
    block.classList.add('selected');
    block.focus({ preventScroll: false });
  }

  function toggleBlock(block, desired) {
    if (!block) return;
    var collapsed = block.dataset.collapsed === 'true';
    var next = typeof desired === 'boolean' ? desired : !collapsed;
    updateBlockView(block, next);
  }

  function moveSelection(offset) {
    if (!currentId) {
      var first = root.querySelector('.block');
      if (first) setCurrent(first);
      return;
    }
    var ordered = collectVisible();
    var index = -1;
    for (var i = 0; i < ordered.length; i += 1) {
      if (ordered[i].getAttribute('data-block-id') === currentId) {
        index = i;
        break;
      }
    }
    if (index === -1) return;
    var next = ordered[index + offset];
    if (next) setCurrent(next);
  }

  function scrollCurrentBlockStep(direction) {
    if (!currentId) return false;
    var el =
      root.querySelector('.block[data-block-id="' + currentId + '"] > .block-surface') ||
      root.querySelector('.block[data-block-id="' + currentId + '"]');
    if (!el) return false;
    var rect = el.getBoundingClientRect();
    var margin = 24;
    var visibleHeight = window.innerHeight - margin * 2;
    if (visibleHeight <= 0) return false;
    if (rect.height <= visibleHeight) return false;
    if (direction === 'down') {
      var bottomLimit = window.innerHeight - margin;
      if (rect.bottom <= bottomLimit) return false;
      var delta = rect.bottom - bottomLimit;
      var baseStep = Math.min(Math.max(delta, 40), 160);
      var step = Math.max(24, Math.round(baseStep / 3));
      window.scrollBy({ top: step, behavior: 'smooth' });
      return true;
    }
    if (direction === 'up') {
      var topLimit = margin;
      if (rect.top >= topLimit) return false;
      var deltaUp = topLimit - rect.top;
      var baseStepUp = Math.min(Math.max(deltaUp, 40), 160);
      var stepUp = Math.max(24, Math.round(baseStepUp / 3));
      window.scrollBy({ top: -stepUp, behavior: 'smooth' });
      return true;
    }
    return false;
  }

  function handleArrowLeft() {
    if (!currentId) return;
    var block = root.querySelector('.block[data-block-id="' + currentId + '"]');
    if (!block) return;
    var collapsed = block.dataset.collapsed === 'true';
    if (!collapsed) {
      toggleBlock(block, true);
      return;
    }
    var parent = getParentBlock(block);
    if (parent) setCurrent(parent);
  }

  function handleArrowRight() {
    if (!currentId) return;
    var block = root.querySelector('.block[data-block-id="' + currentId + '"]');
    if (!block) return;
    var collapsed = block.dataset.collapsed === 'true';
    var firstChild = block.querySelector('.block-children .block');
    if (collapsed) {
      toggleBlock(block, false);
      if (firstChild) setCurrent(firstChild);
      return;
    }
    if (firstChild) {
      setCurrent(firstChild);
    }
  }

  root.addEventListener('click', function(event) {
    var btn = event.target.closest('.collapse-btn');
    if (btn) {
      var targetId = btn.getAttribute('data-block-id');
      var block = root.querySelector('.block[data-block-id=\"' + targetId + '\"]');
      toggleBlock(block);
      setCurrent(block);
      return;
    }
    var block = event.target.closest('.block');
    if (block) {
      var isInteractive = event.target.closest('a, button, input, textarea, select');
      if (!isInteractive) {
        var header = block.querySelector('.block-header');
        var body = block.querySelector('.block-text.block-body');
        var bodyHasNoTitle = body && body.classList.contains('block-body--no-title');
        var clickedInHeader = header && header.contains(event.target);
        var clickedInBody = body && body.contains(event.target);
        var hasLogicalTitle = !!(header && !bodyHasNoTitle);
        var shouldToggle = false;
        if (hasLogicalTitle && clickedInHeader) {
          shouldToggle = true;
        } else if (!hasLogicalTitle && clickedInBody) {
          shouldToggle = true;
        }
        if (shouldToggle) {
          toggleBlock(block);
        }
      }
      setCurrent(block);
    }
  });

  document.addEventListener('keydown', function(event) {
    if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Enter', 'Space', ' '].indexOf(event.code) !== -1) {
      event.preventDefault();
    } else {
      return;
    }
    if (event.code === 'ArrowDown') {
      var scrolledDown = scrollCurrentBlockStep('down');
      if (!scrolledDown) moveSelection(1);
      return;
    }
    if (event.code === 'ArrowUp') {
      var scrolledUp = scrollCurrentBlockStep('up');
      if (!scrolledUp) moveSelection(-1);
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
      var block = root.querySelector('.block[data-block-id="' + currentId + '"]');
      toggleBlock(block);
    }
  });

  if (firstBlock) setCurrent(firstBlock);
})();
    </script>
    """

    lang_safe = html_mod.escape(lang or 'ru')
    description_safe = html_mod.escape(description or title_raw)

    return f"""<!doctype html>
<html lang="{lang_safe}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{title}</title>
    <meta name="description" content="{description_safe}" />
    <meta name="x-memus-export" content="memus;v=1" />
    <meta name="robots" content="index,follow" />
    <meta property="og:type" content="article" />
    <meta property="og:title" content="{title}" />
    <meta property="og:description" content="{description_safe}" />
    <meta name="twitter:card" content="summary_large_image" />
    <link rel="icon" href="/icons/favicon.ico" type="image/x-icon" />
    <style>
{css_text}
{extra_css}
    </style>
    <script type="application/ld+json">
{json.dumps(json_ld, ensure_ascii=False, indent=2)}
    </script>
  </head>
  <body class="export-page">
    <div class="page">
    <script type="application/json" id="memus-export">
{json.dumps(export_payload, ensure_ascii=False, indent=2)}
    </script>
    {body_inner}
    </div>
    {interactions_script}
  </body>
</html>
"""


def _inline_uploads_for_backup(html_text: str, current_user: User | None) -> str:
    """
    Делает резервную HTML-страницу самодостаточной:
    - все ссылки src=\"/uploads/...\" и href=\"/uploads/...\" для текущего пользователя
      конвертирует в data: URL;
    - при этом добавляет data-original-src/href с исходным путём, чтобы импорт
      мог при желании переиспользовать существующие файлы и не плодить дубликаты.
    """
    if not current_user or '/uploads/' not in (html_text or ''):
        return html_text

    def _replace(match: re.Match[str]) -> str:
        attr = match.group(1)  # src | href
        original_url = match.group(2) or ''
        if not original_url.startswith('/uploads/'):
            return match.group(0)
        # Путь внутри uploads
        rel = original_url[len('/uploads/') :].lstrip('/')
        rel_path = PurePosixPath(rel)
        parts = rel_path.parts
        # Гарантируем, что путь принадлежит текущему пользователю.
        if not parts or parts[0] != current_user.id:
            return match.group(0)
        file_path = UPLOADS_DIR / rel_path
        if not file_path.is_file():
            return match.group(0)
        try:
            raw = file_path.read_bytes()
        except OSError:
            return match.group(0)
        mime_type, _ = mimetypes.guess_type(str(file_path))
        if not mime_type:
            mime_type = 'application/octet-stream'
        b64 = base64.b64encode(raw).decode('ascii')
        data_url = f'data:{mime_type};base64,{b64}'
        # src=\"...\" -> src=\"data:...\" data-original-src=\"...\"
        return f'{attr}=\"{data_url}\" data-original-{attr}=\"{original_url}\"'

    pattern = re.compile(r'(src|href)=\"(/uploads/[^\"]+)\"')
    return pattern.sub(_replace, html_text or '')
