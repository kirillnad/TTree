from __future__ import annotations

import json
import logging
import os
import re
import tempfile
import threading
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

import httpx

from .auth import get_user_by_id
from .data_store import get_article, get_yandex_tokens, save_article_doc_json
from .db import CONN

logger = logging.getLogger('uvicorn.error')

BASE_DIR = Path(__file__).resolve().parents[3]
UPLOADS_DIR = BASE_DIR / 'uploads'

OPENAI_API_KEY = os.environ.get('SERVPY_OPENAI_API_KEY') or os.environ.get('OPENAI_API_KEY') or ''
OPENAI_BASE_URL = os.environ.get('SERVPY_OPENAI_BASE_URL') or 'https://api.openai.com/v1'
TRANSCRIBE_MODEL = os.environ.get('SERVPY_AUDIO_TRANSCRIBE_MODEL') or 'gpt-4o-mini-transcribe'
CLEANUP_MODEL = os.environ.get('SERVPY_AUDIO_CLEANUP_MODEL') or 'gpt-4o-mini'

TRANSCRIBE_TIMEOUT_SECONDS = float(os.environ.get('SERVPY_AUDIO_TRANSCRIBE_TIMEOUT_SECONDS') or '120')
CLEANUP_TIMEOUT_SECONDS = float(os.environ.get('SERVPY_AUDIO_CLEANUP_TIMEOUT_SECONDS') or '120')

CHUNK_SECONDS = 600
OVERLAP_SECONDS = 2
MAX_AUDIO_BYTES = int(os.environ.get('SERVPY_AUDIO_MAX_BYTES') or str(20 * 1024 * 1024))  # 20MB

HTTP_PROXY = os.environ.get('SERVPY_HTTP_PROXY') or os.environ.get('HTTP_PROXY') or ''
HTTPS_PROXY = os.environ.get('SERVPY_HTTPS_PROXY') or os.environ.get('HTTPS_PROXY') or ''
ALL_PROXY = os.environ.get('SERVPY_ALL_PROXY') or os.environ.get('ALL_PROXY') or ''

_AUDIO_EXTS = {'.oga', '.ogg', '.opus', '.mp3', '.wav', '.m4a', '.aac', '.flac', '.webm'}


def is_audio_attachment(*, original_name: str, content_type: str = '') -> bool:
    name = str(original_name or '').lower()
    ctype = str(content_type or '').lower()
    if ctype.startswith('audio/'):
        return True
    try:
        ext = Path(name).suffix.lower()
    except Exception:
        ext = ''
    return ext in _AUDIO_EXTS


def _httpx_proxies() -> str | dict | None:
    if ALL_PROXY:
        return ALL_PROXY
    if HTTP_PROXY or HTTPS_PROXY:
        proxies: dict[str, str] = {}
        if HTTP_PROXY:
            proxies['http://'] = HTTP_PROXY
        if HTTPS_PROXY:
            proxies['https://'] = HTTPS_PROXY
        return proxies
    return None


def _iso_now() -> str:
    return datetime.utcnow().isoformat()


def _json_extract_object(text: str) -> dict[str, Any]:
    raw = (text or '').strip()
    if not raw:
        return {}
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}
    except Exception:
        pass
    # Fallback: try to extract the first {...} block.
    m = re.search(r'\{[\s\S]*\}', raw)
    if not m:
        return {}
    try:
        data = json.loads(m.group(0))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _download_yandex_disk_bytes(user_id: str, stored_path: str) -> bytes:
    if not user_id or not stored_path:
        raise RuntimeError('Missing user_id or stored_path')
    tokens = get_yandex_tokens(user_id) or {}
    access_token = tokens.get('accessToken') if tokens else None
    if not access_token:
        raise RuntimeError('Yandex Disk OAuth token not configured')
    path = str(stored_path)
    encoded = urllib.parse.quote(path, safe='')
    href_url = f'https://cloud-api.yandex.net/v1/disk/resources/download?path={encoded}'
    req = urllib.request.Request(href_url, headers={'Authorization': f'OAuth {access_token}'})
    with urllib.request.urlopen(req, timeout=20) as resp:
        data = json.loads(resp.read().decode('utf-8'))
    href = data.get('href') or ''
    if not href:
        raise RuntimeError('Yandex Disk: download href missing')
    with urllib.request.urlopen(href, timeout=120) as resp:
        return resp.read()


def _download_local_upload_bytes(*, user_id: str, article_id: str, stored_path: str) -> bytes:
    """
    Reads bytes for a local /uploads/... attachment.
    Supports:
      - /uploads/<user_id>/attachments/<article_id>/<filename>
      - legacy public: /uploads/<article_id>/<filename>
    """
    path = str(stored_path or '').strip()
    if not path.startswith('/uploads/'):
        raise RuntimeError('Not a local upload path')
    rel = path[len('/uploads/') :]
    rel_parts = [p for p in rel.split('/') if p and p not in ('.', '..')]
    if not rel_parts:
        raise RuntimeError('Invalid upload path')

    # Direct physical path.
    if rel_parts[0] == str(user_id):
        full_path = UPLOADS_DIR.joinpath(*rel_parts)
        if full_path.is_file():
            return full_path.read_bytes()

    # Legacy public /uploads/<article_id>/<filename> → map to /uploads/<user_id>/attachments/<article_id>/<filename>
    if len(rel_parts) >= 2:
        filename = rel_parts[-1]
        full_path = UPLOADS_DIR / str(user_id) / 'attachments' / str(article_id) / filename
        if full_path.is_file():
            return full_path.read_bytes()

    raise RuntimeError('Local upload file not found')


def _download_attachment_bytes(*, user_id: str, article_id: str, stored_path: str) -> bytes:
    path = str(stored_path or '').strip()
    if path.startswith('app:/') or path.startswith('disk:/'):
        return _download_yandex_disk_bytes(user_id, path)
    if path.startswith('/uploads/'):
        return _download_local_upload_bytes(user_id=user_id, article_id=article_id, stored_path=path)
    raise RuntimeError('Unsupported attachment stored_path')
def _log_job(job_id: str, event: str, **data: Any) -> None:
    payload = {'job': job_id, 'event': event, **data}
    try:
        logger.info('audio_transcripts: %s', json.dumps(payload, ensure_ascii=False, sort_keys=True))
    except Exception:
        logger.info('audio_transcripts: job=%s event=%s', job_id, event)


def _run_ffmpeg(args: list[str]) -> None:
    import subprocess

    proc = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f'ffmpeg failed: {proc.stderr.strip() or proc.stdout.strip() or proc.returncode}')


def _convert_audio_to_mp3(input_path: Path, output_path: Path) -> None:
    _run_ffmpeg(
        [
            'ffmpeg',
            '-y',
            '-i',
            str(input_path),
            '-vn',
            '-ac',
            '1',
            '-ar',
            '16000',
            '-b:a',
            '96k',
            str(output_path),
        ],
    )


def _probe_duration_seconds(input_path: Path) -> float:
    import subprocess

    proc = subprocess.run(
        [
            'ffprobe',
            '-v',
            'error',
            '-show_entries',
            'format=duration',
            '-of',
            'default=noprint_wrappers=1:nokey=1',
            str(input_path),
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f'ffprobe failed: {proc.stderr.strip() or proc.stdout.strip() or proc.returncode}')
    try:
        return float((proc.stdout or '').strip() or '0')
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError('ffprobe: invalid duration') from exc


def _split_mp3_into_chunks(mp3_path: Path, out_dir: Path) -> list[Path]:
    duration = _probe_duration_seconds(mp3_path)
    if duration <= 0:
        return [mp3_path]
    chunks: list[Path] = []
    i = 0
    while True:
        start = i * CHUNK_SECONDS
        if start >= duration:
            break
        chunk_start = max(0.0, start - (OVERLAP_SECONDS if i > 0 else 0))
        chunk_dur = CHUNK_SECONDS + OVERLAP_SECONDS + (OVERLAP_SECONDS if i > 0 else 0)
        out_path = out_dir / f'chunk-{i:04d}.mp3'
        _run_ffmpeg(
            [
                'ffmpeg',
                '-y',
                '-i',
                str(mp3_path),
                '-ss',
                str(chunk_start),
                '-t',
                str(chunk_dur),
                '-c',
                'copy',
                str(out_path),
            ],
        )
        chunks.append(out_path)
        i += 1
    return chunks


def _dedupe_overlap(prev_text: str, next_text: str, window_words: int = 30) -> str:
    def norm_words(s: str) -> list[str]:
        s = (s or '').replace('\u00a0', ' ')
        s = re.sub(r'\s+', ' ', s).strip()
        if not s:
            return []
        return s.split(' ')

    prev_words = norm_words(prev_text)
    next_words = norm_words(next_text)
    if not prev_words or not next_words:
        return next_text
    tail = prev_words[-window_words:]
    head = next_words[:window_words]
    # Find the largest k where tail[-k:] == head[:k]
    max_k = min(len(tail), len(head))
    best = 0
    for k in range(1, max_k + 1):
        if tail[-k:] == head[:k]:
            best = k
    if best <= 0:
        return next_text
    trimmed_words = next_words[best:]
    return ' '.join(trimmed_words).strip()


def _openai_audio_transcribe_mp3(mp3_bytes: bytes) -> dict[str, Any]:
    if not OPENAI_API_KEY:
        raise RuntimeError('OpenAI API key not configured')
    prompt = (
        'Расшифруй аудио в текст (один спикер).\n'
        'Условия:\n'
        '- Не добавляй ничего от себя.\n'
        '- Сохраняй слова максимально дословно.\n'
        '- Восстанови пунктуацию и заглавные буквы.\n'
        '- Делай абзацы по смыслу (без таймкодов).\n'
        '- Если кусок не разобрать: напиши [неразборчиво].\n'
    )
    url = f'{OPENAI_BASE_URL.rstrip("/")}/audio/transcriptions'
    with httpx.Client(timeout=TRANSCRIBE_TIMEOUT_SECONDS, proxies=_httpx_proxies()) as client:
        resp = client.post(url, headers={'Authorization': f'Bearer {OPENAI_API_KEY}'}, files={
            'file': ('audio.mp3', mp3_bytes, 'audio/mpeg'),
        }, data={
            'model': TRANSCRIBE_MODEL,
            'prompt': prompt,
            # gpt-4o-mini-transcribe supports 'json' or 'text' (not 'verbose_json').
            'response_format': 'json',
        })
        resp.raise_for_status()
        data = resp.json()
    if isinstance(data, dict):
        return data
    return {}


def _openai_chat_text_to_clean(raw_text: str) -> dict[str, Any]:
    if not OPENAI_API_KEY:
        raise RuntimeError('OpenAI API key not configured')
    text = (raw_text or '').strip()
    if not text:
        return {'clean': '', 'notes': ''}
    if len(text) > 120000:
        text = text[:120000]
    system = 'Ты — редактор русского текста.'
    user = (
        'Приведи текст к “литературному” виду, не меняя смысл.\n'
        'Условия:\n'
        '- Один спикер.\n'
        '- Убери слова‑паразиты, повторы, междометия, “э-э”, “ну”, “как бы”, и т.п.\n'
        '- Перепиши фразы в нормальные предложения: пунктуация, согласование, порядок слов.\n'
        '- Не добавляй новых фактов.\n'
        '- Имена/термины/числа сохраняй как есть.\n'
        '- Если есть [неразборчиво] — оставь, но не размножай.\n'
        '- Делай абзацы по смыслу.\n\n'
        'Верни результат строго в JSON:\n'
        '{\n'
        '  "clean": "<литературный текст>",\n'
        '  "notes": "<если есть важные замечания (например, много неразборчивого), иначе пустая строка>"\n'
        '}\n\n'
        'Текст:\n'
        + text
    )
    url = f'{OPENAI_BASE_URL.rstrip("/")}/chat/completions'
    payload = {
        'model': CLEANUP_MODEL,
        'messages': [
            {'role': 'system', 'content': system},
            {'role': 'user', 'content': user},
        ],
        'temperature': 0.2,
        'max_tokens': 4000,
    }
    with httpx.Client(timeout=CLEANUP_TIMEOUT_SECONDS, proxies=_httpx_proxies()) as client:
        resp = client.post(
            url,
            headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {OPENAI_API_KEY}'},
            json=payload,
        )
        resp.raise_for_status()
        data = resp.json()
    content = ''
    try:
        choices = data.get('choices') if isinstance(data, dict) else None
        msg = (choices or [])[0].get('message') if choices else None
        content = (msg or {}).get('content') if isinstance(msg, dict) else ''
    except Exception:
        content = ''
    return _json_extract_object(content)


def _append_transcript_to_doc_json(
    *,
    doc_json: dict[str, Any],
    section_id: str,
    article_id: str,
    attachment_id: str,
    attachment_name: str,
    attachment_href: str,
    raw_text: str,
    clean_text: str,
) -> tuple[dict[str, Any], bool]:
    sid = str(section_id or '').strip()
    if not sid:
        return doc_json, False
    att_id = str(attachment_id or '').strip()
    if not att_id:
        return doc_json, False
    href = str(attachment_href or '').strip()
    hrefs: list[str] = []
    if href:
        hrefs.append(href)
        # Yandex public download proxy variant.
        if href.startswith('app:/') or href.startswith('disk:/'):
            encoded = urllib.parse.quote(href, safe='')
            hrefs.append(f'/api/yandex/disk/file?path={encoded}')
        # Local public variant: /uploads/<article_id>/<filename>
        if href.startswith('/uploads/') and '/attachments/' in href:
            filename = href.rsplit('/', 1)[-1]
            if filename:
                aid = str(article_id or '').strip()
                if aid:
                    hrefs.append(f'/uploads/{aid}/{filename}')

    def p(text: str, *, strong: bool = False) -> dict[str, Any]:
        t = (text or '').strip()
        if not t:
            return {'type': 'paragraph'}
        node: dict[str, Any] = {'type': 'text', 'text': t}
        if strong:
            node['marks'] = [{'type': 'bold'}]
        return {'type': 'paragraph', 'content': [node]}

    def paragraph_text(node: Any) -> str:
        if not isinstance(node, dict) or node.get('type') != 'paragraph':
            return ''
        parts: list[str] = []
        for c in node.get('content') or []:
            if isinstance(c, dict) and c.get('type') == 'text':
                parts.append(str(c.get('text') or ''))
        return ''.join(parts)

    def paragraphs_from_text(text: str) -> list[dict[str, Any]]:
        lines = (text or '').replace('\r\n', '\n').replace('\r', '\n').split('\n')
        out: list[dict[str, Any]] = []
        for ln in lines:
            ln = ln.strip()
            if not ln:
                out.append({'type': 'paragraph'})
                continue
            out.append(p(ln))
        # trim leading/trailing empty paragraphs
        while out and out[0].get('type') == 'paragraph' and not out[0].get('content'):
            out.pop(0)
        while out and out[-1].get('type') == 'paragraph' and not out[-1].get('content'):
            out.pop()
        return out or [{'type': 'paragraph'}]

    content = doc_json.get('content')
    if not isinstance(content, list):
        return doc_json, False

    # Avoid duplicates if we already appended for this attachment.
    marker = att_id

    def try_patch_section(section_node: dict[str, Any]) -> bool:
        node_content = section_node.get('content')
        if not isinstance(node_content, list) or len(node_content) < 2:
            return False
        body = node_content[1]
        if not isinstance(body, dict) or body.get('type') != 'outlineBody':
            return False
        body_content = body.get('content')
        if not isinstance(body_content, list):
            body_content = []
            body['content'] = body_content

        attrs = section_node.get('attrs')
        if not isinstance(attrs, dict):
            attrs = {}
            section_node['attrs'] = attrs
        ids = attrs.get('transcriptAttachmentIds')
        already_marked = isinstance(ids, list) and marker in [str(x) for x in ids]

        # Remove placeholder/legacy paragraphs if they exist.
        placeholder = 'Расшифровываем аудио'
        legacy_mark = '[transcript:'

        def paragraph_has_link_hrefs(par: Any, targets: list[str]) -> bool:
            if not targets:
                return False
            if not isinstance(par, dict) or par.get('type') != 'paragraph':
                return False
            for c in par.get('content') or []:
                if not isinstance(c, dict) or c.get('type') != 'text':
                    continue
                for m in c.get('marks') or []:
                    if isinstance(m, dict) and m.get('type') == 'link':
                        attrs = m.get('attrs') if isinstance(m.get('attrs'), dict) else {}
                        href_val = str(attrs.get('href') or '').strip()
                        if href_val and href_val in targets:
                            return True
            return False

        # Locate the paragraph containing the attachment link; fallback to text match by name.
        link_par_idx: int | None = None
        for i, item in enumerate(body_content):
            if paragraph_has_link_hrefs(item, hrefs):
                link_par_idx = i
                break
        if link_par_idx is None:
            for i, item in enumerate(body_content):
                t = paragraph_text(item)
                if t and attachment_name and attachment_name in t:
                    link_par_idx = i
                    break
        if link_par_idx is None:
            link_par_idx = len(body_content) - 1 if body_content else 0

        # Always remove placeholder paragraph (anywhere).
        filtered: list[dict[str, Any]] = []
        for item in body_content:
            t = paragraph_text(item)
            if t and placeholder in t:
                continue
            if t and (t.startswith('Расшифровка аудио:') or t.strip() == 'Сырой текст:' or legacy_mark in t):
                continue
            filtered.append(item)

        # Recompute link paragraph index in filtered list (best-effort).
        body_content = filtered
        if link_par_idx >= len(body_content):
            link_par_idx = len(body_content) - 1 if body_content else 0

        # Insert clean transcript right after link paragraph.
        insert_at = min(len(body_content), max(0, int(link_par_idx) + 1))
        clean_nodes = paragraphs_from_text(clean_text)
        body_content = body_content[:insert_at] + clean_nodes + body_content[insert_at:]
        body['content'] = body_content

        # Persist non-visual marker in section attrs for idempotency.
        ids = attrs.get('transcriptAttachmentIds')
        if not isinstance(ids, list):
            ids = []
            attrs['transcriptAttachmentIds'] = ids
        if not already_marked:
            ids.append(marker)
        return True

    def walk(nodes: Any) -> bool:
        if isinstance(nodes, list):
            for item in nodes:
                if walk(item):
                    return True
            return False
        if not isinstance(nodes, dict):
            return False
        if nodes.get('type') == 'outlineSection':
            attrs = nodes.get('attrs') if isinstance(nodes.get('attrs'), dict) else {}
            if str(attrs.get('id') or '') == sid:
                return try_patch_section(nodes)
            for child in nodes.get('content') or []:
                if isinstance(child, dict) and child.get('type') == 'outlineChildren':
                    if walk(child.get('content') or []):
                        return True
                    break
            return False
        return walk(nodes.get('content') or [])

    appended = walk(content)
    return doc_json, bool(appended)


def enqueue_audio_transcript_job(*, user_id: str, article_id: str, section_id: str, attachment: dict[str, Any]) -> str | None:
    """
    Creates a queued job for a single audio attachment (e.g. .oga from Telegram) and starts the worker thread.
    Returns job_id or None.
    """
    if not user_id or not article_id or not section_id:
        return None
    attachment_id = str((attachment or {}).get('id') or '').strip()
    stored_path = str((attachment or {}).get('url') or (attachment or {}).get('storedPath') or '').strip()
    original_name = str((attachment or {}).get('originalName') or '').strip() or 'audio.oga'
    if not attachment_id or not stored_path:
        return None

    job_id = str(uuid4())
    now = _iso_now()
    with CONN:
        # Deduplicate: one job per attachment.
        row = CONN.execute(
            'SELECT id FROM audio_transcript_jobs WHERE attachment_id = ?',
            (attachment_id,),
        ).fetchone()
        if row and row.get('id'):
            kick_audio_transcript_worker()
            return str(row['id'])
        CONN.execute(
            '''
            INSERT INTO audio_transcript_jobs (
              id, user_id, article_id, section_id, attachment_id, stored_path, original_name,
              status, attempts, created_at, updated_at, next_attempt_at, raw_text, clean_text, error_message
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, '', '', '')
            ''',
            (job_id, user_id, article_id, section_id, attachment_id, stored_path, original_name, now, now, now),
        )
    kick_audio_transcript_worker()
    _log_job(job_id, 'enqueued', article=article_id, section=section_id, attachment=attachment_id, name=original_name)
    return job_id


_WORKER_LOCK = threading.Lock()
_WORKER_THREAD: threading.Thread | None = None
_WORKER_STOP = False


def _requeue_running_jobs_on_startup() -> None:
    """
    If the server restarts mid-job, rows can be left in `running` forever.
    We reset them back to `queued` so the worker can retry.
    """
    now = _iso_now()
    try:
        with CONN:
            CONN.execute(
                """
                UPDATE audio_transcript_jobs
                SET status = 'queued', updated_at = ?, next_attempt_at = ?, error_message = ''
                WHERE status = 'running'
                """,
                (now, now),
            )
    except Exception:
        # Never break app startup because of background worker housekeeping.
        return


def _requeue_done_jobs_missing_transcript_marker_on_startup(limit: int = 50) -> None:
    """
    Best-effort repair: if a job is marked 'done' but the transcript marker is missing from
    the current article_doc_json (e.g. overwritten by a stale client save), re-queue it.
    """
    now = _iso_now()
    try:
        rows = CONN.execute(
            """
            SELECT id, article_id, section_id, attachment_id
            FROM audio_transcript_jobs
            WHERE status = 'done'
            ORDER BY updated_at DESC
            LIMIT ?
            """,
            (int(limit),),
        ).fetchall()
    except Exception:
        return
    if not rows:
        return
    for row in rows:
        try:
            job_id = str(row.get('id') or '')
            article_id = str(row.get('article_id') or '')
            section_id = str(row.get('section_id') or '')
            attachment_id = str(row.get('attachment_id') or '')
            if not job_id or not article_id or not attachment_id:
                continue
            marker = f'[transcript:{attachment_id}]'
            art = CONN.execute('SELECT article_doc_json FROM articles WHERE id = ? AND deleted_at IS NULL', (article_id,)).fetchone()
            doc_str = (art.get('article_doc_json') if art else '') or ''
            # New marker is stored in outlineSection.attrs.transcriptAttachmentIds.
            has_new_marker = ('transcriptAttachmentIds' in doc_str) and (f'\"{attachment_id}\"' in doc_str)
            has_old_marker = marker in doc_str
            if has_new_marker or has_old_marker:
                continue
            # If the target section is gone, don't requeue forever.
            if section_id and section_id not in doc_str:
                continue
            with CONN:
                CONN.execute(
                    """
                    UPDATE audio_transcript_jobs
                    SET status = 'queued', updated_at = ?, next_attempt_at = ?, error_message = ''
                    WHERE id = ?
                    """,
                    (now, now, job_id),
                )
            _log_job(job_id, 'requeued_missing_marker', article=article_id, attachment=attachment_id)
        except Exception:
            continue


def kick_audio_transcript_worker() -> None:
    global _WORKER_THREAD
    if _WORKER_STOP:
        return
    _requeue_running_jobs_on_startup()
    _requeue_done_jobs_missing_transcript_marker_on_startup()
    with _WORKER_LOCK:
        if _WORKER_THREAD and _WORKER_THREAD.is_alive():
            return

        def _runner() -> None:
            logger.info('audio_transcripts: worker started')
            while not _WORKER_STOP:
                try:
                    processed = _run_worker_once()
                    if not processed:
                        time.sleep(2.0)
                except Exception as exc:  # noqa: BLE001
                    logger.error('audio_transcripts: worker loop error: %r', exc)
                    time.sleep(2.0)

        _WORKER_THREAD = threading.Thread(target=_runner, name='audio-transcripts', daemon=True)
        _WORKER_THREAD.start()


def _claim_next_job() -> dict[str, Any] | None:
    now = _iso_now()
    with CONN:
        row = CONN.execute(
            '''
            SELECT id, user_id, article_id, section_id, attachment_id, stored_path, original_name, attempts
            FROM audio_transcript_jobs
            WHERE status = 'queued' AND next_attempt_at <= ?
            ORDER BY created_at ASC
            LIMIT 1
            ''',
            (now,),
        ).fetchone()
        if not row:
            return None
        job_id = str(row['id'])
        attempts = int(row.get('attempts') or 0)
        CONN.execute(
            '''
            UPDATE audio_transcript_jobs
            SET status = 'running', attempts = ?, updated_at = ?
            WHERE id = ?
            ''',
            (attempts + 1, now, job_id),
        )
    return dict(row)


def _fail_job(job_id: str, message: str, *, retry_in_seconds: int = 30) -> None:
    now = _iso_now()
    next_at = datetime.utcnow().timestamp() + max(1, retry_in_seconds)
    next_iso = datetime.utcfromtimestamp(next_at).isoformat()
    with CONN:
        CONN.execute(
            '''
            UPDATE audio_transcript_jobs
            SET status = 'queued', error_message = ?, updated_at = ?, next_attempt_at = ?
            WHERE id = ?
            ''',
            (str(message or 'error'), now, next_iso, str(job_id)),
        )
    _log_job(job_id, 'retry', retryInSeconds=int(retry_in_seconds), error=str(message or 'error'))


def _orphan_job(job_id: str, message: str) -> None:
    now = _iso_now()
    with CONN:
        CONN.execute(
            '''
            UPDATE audio_transcript_jobs
            SET status = 'orphaned', error_message = ?, updated_at = ?
            WHERE id = ?
            ''',
            (str(message or 'orphaned'), now, str(job_id)),
        )
    _log_job(job_id, 'orphaned', error=str(message or 'orphaned'))


def _complete_job(job_id: str, raw_text: str, clean_text: str) -> None:
    now = _iso_now()
    with CONN:
        CONN.execute(
            '''
            UPDATE audio_transcript_jobs
            SET status = 'done', raw_text = ?, clean_text = ?, error_message = '', updated_at = ?
            WHERE id = ?
            ''',
            (raw_text or '', clean_text or '', now, str(job_id)),
        )
    _log_job(job_id, 'done', rawChars=len(raw_text or ''), cleanChars=len(clean_text or ''))


def _run_worker_once() -> bool:
    job = _claim_next_job()
    if not job:
        return False
    job_id = str(job.get('id') or '')
    user_id = str(job.get('user_id') or '')
    article_id = str(job.get('article_id') or '')
    section_id = str(job.get('section_id') or '')
    stored_path = str(job.get('stored_path') or '')
    original_name = str(job.get('original_name') or 'audio.oga')
    attachment_id = str(job.get('attachment_id') or '').strip()

    try:
        _log_job(job_id, 'start', article=article_id, section=section_id, attachment=str(job.get('attachment_id') or ''), name=original_name)
        raw_bytes = _download_attachment_bytes(user_id=user_id, article_id=article_id, stored_path=stored_path)
        if not raw_bytes:
            raise RuntimeError('Empty audio bytes')
        _log_job(job_id, 'downloaded', bytes=len(raw_bytes))

        with tempfile.TemporaryDirectory(prefix='memus-audio-') as tmp:
            tmp_dir = Path(tmp)
            suffix = Path(original_name).suffix or '.ogg'
            if len(suffix) > 10 or not suffix.startswith('.'):
                suffix = '.ogg'
            input_path = tmp_dir / f'input{suffix}'
            input_path.write_bytes(raw_bytes)
            mp3_path = tmp_dir / 'audio.mp3'
            _convert_audio_to_mp3(input_path, mp3_path)

            mp3_bytes = mp3_path.read_bytes()
            duration_seconds = _probe_duration_seconds(mp3_path)
            _log_job(job_id, 'converted', mp3Bytes=len(mp3_bytes), durationSeconds=round(float(duration_seconds or 0.0), 3))
            if duration_seconds > CHUNK_SECONDS or len(mp3_bytes) > MAX_AUDIO_BYTES:
                chunk_dir = tmp_dir / 'chunks'
                chunk_dir.mkdir(parents=True, exist_ok=True)
                chunk_paths = _split_mp3_into_chunks(mp3_path, chunk_dir)
            else:
                chunk_paths = [mp3_path]
            _log_job(job_id, 'chunking', chunks=len(chunk_paths))

            raw_chunks: list[str] = []
            for idx, chunk_path in enumerate(chunk_paths, start=1):
                chunk_bytes = chunk_path.read_bytes()
                if len(chunk_bytes) > MAX_AUDIO_BYTES:
                    raise RuntimeError('Chunk exceeds MAX_AUDIO_BYTES even after splitting')
                _log_job(job_id, 'transcribe_chunk', i=idx, n=len(chunk_paths), bytes=len(chunk_bytes))
                data = _openai_audio_transcribe_mp3(chunk_bytes)
                raw = str((data or {}).get('text') or '').strip()
                if not raw:
                    raw = '[неразборчиво]'
                raw_chunks.append(raw)

            # Dedupe overlaps on joins.
            merged = ''
            for i, piece in enumerate(raw_chunks):
                if i == 0:
                    merged = piece.strip()
                    continue
                deduped = _dedupe_overlap(merged, piece)
                if deduped:
                    merged = (merged.rstrip() + '\n\n' + deduped.lstrip()).strip()

            _log_job(job_id, 'cleanup_start', rawChars=len(merged))
            cleanup = _openai_chat_text_to_clean(merged)
            clean = str(cleanup.get('clean') or '').strip()
            if not clean:
                clean = merged

            # Patch article docJson.
            user = get_user_by_id(user_id)
            if not user:
                raise RuntimeError('User not found')
            article = get_article(article_id, author_id=user_id, include_blocks=False) or {}
            doc_json_raw = article.get('docJson')
            doc_json = doc_json_raw if isinstance(doc_json_raw, dict) else {}
            if doc_json.get('type') != 'doc':
                raise RuntimeError('Article docJson missing')
            _log_job(job_id, 'patch_doc_start', cleanChars=len(clean))
            updated_doc = _append_transcript_to_doc_json(
                doc_json=doc_json,
                section_id=section_id,
                article_id=article_id,
                attachment_id=attachment_id,
                attachment_name=original_name,
                attachment_href=stored_path,
                raw_text=merged,
                clean_text=clean,
            )
            updated_doc_json, appended = updated_doc
            if not appended:
                raise RuntimeError('Section not found (or not patchable) for transcript append')
            save_article_doc_json(article_id=article_id, author_id=user_id, doc_json=updated_doc_json)

            _complete_job(job_id, merged, clean)
            return True
    except Exception as exc:  # noqa: BLE001
        _log_job(job_id, 'fail', error=repr(exc))
        logger.error('audio_transcripts: failed job=%s: %r', job_id, exc)
        msg = str(exc)
        if isinstance(exc, RuntimeError) and 'Section not found' in msg:
            _orphan_job(job_id, msg)
        else:
            _fail_job(job_id, msg, retry_in_seconds=60)
        return True
