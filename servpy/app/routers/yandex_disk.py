from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import RedirectResponse

from ..auth import User, get_current_user
from ..data_store import get_yandex_tokens
from ..oauth_config import YANDEX_DISK_APP_ROOT

# Вынесено из app/main.py → app/routers/yandex_disk.py

router = APIRouter()
logger = logging.getLogger('uvicorn.error')


@router.get('/api/yandex/disk/app-root')
def yandex_app_root(current_user: User = Depends(get_current_user)):
    """
    Тестовый эндпоинт для проверки интеграции с Яндекс.Диском.
    Возвращает метаданные app‑папки (path=app:/) по access_token текущего пользователя.
    """
    tokens = get_yandex_tokens(current_user.id)
    access_token = tokens.get('accessToken') if tokens else None
    if not access_token:
        raise HTTPException(status_code=400, detail='Интеграция с Яндекс.Диском не настроена')

    try:
        encoded_path = urllib.parse.quote(YANDEX_DISK_APP_ROOT, safe='')
        req = urllib.request.Request(
            f'https://cloud-api.yandex.net/v1/disk/resources?path={encoded_path}',
            headers={'Authorization': f'OAuth {access_token}'},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            info = json.loads(resp.read().decode('utf-8'))
    except Exception as exc:  # noqa: BLE001
        logger.error('Failed to fetch Yandex Disk app folder: %r', exc)
        raise HTTPException(status_code=502, detail='Не удалось обратиться к Яндекс.Диску')

    return info


@router.post('/api/yandex/disk/upload-url')
def yandex_upload_url(payload: dict[str, Any], current_user: User = Depends(get_current_user)):
    """
    Возвращает URL для загрузки файла в app‑папку Яндекс.Диска текущего пользователя.

    Ожидает JSON:
      {
        "filename": "report.pdf",
        "articleId": "<optional>",
        "overwrite": false
      }

    Возвращает:
      {
        "href": "<upload_url>",
        "method": "PUT" | ...,
        "path": "app:/.../report.pdf"
      }
    """
    tokens = get_yandex_tokens(current_user.id)
    access_token = tokens.get('accessToken') if tokens else None
    disk_root = (tokens.get('diskRoot') if tokens else None) or YANDEX_DISK_APP_ROOT or 'app:/'
    if not access_token:
        raise HTTPException(status_code=400, detail='Интеграция с Яндекс.Диском не настроена')

    filename = (payload.get('filename') or '').strip()
    if not filename:
        raise HTTPException(status_code=400, detail='Не указано имя файла')
    # Простая санация имени файла.
    safe_name = ''.join(ch if ch not in '/\\' else '_' for ch in filename)

    # Дополнительные метаданные файла от клиента для сравнения
    size_val = payload.get('size')
    size_int: int | None
    try:
        size_int = int(size_val) if size_val is not None else None
    except Exception:  # noqa: BLE001
        size_int = None

    base = disk_root.rstrip('/')
    # Складываем файлы плоско в корень папки приложения,
    # чтобы пользователю было проще управлять ими в Memus.pro на Диске.
    target_path = f'{base}/{safe_name}'

    # 1. Проверяем, есть ли уже файл с таким именем, и если есть — совпадает ли содержимое.
    exists = False
    same = False
    remote_size: int | None = None
    encoded_target = urllib.parse.quote(target_path, safe='')
    # Нас в первую очередь интересует размер; его достаточно для
    # дедупликации «пользователь, скорее всего, загрузил тот же файл».
    meta_url = f'https://cloud-api.yandex.net/v1/disk/resources?path={encoded_target}&fields=size'
    try:
        meta_req = urllib.request.Request(
            meta_url,
            headers={'Authorization': f'OAuth {access_token}'},
        )
        with urllib.request.urlopen(meta_req, timeout=10) as resp:
            meta = json.loads(resp.read().decode('utf-8'))
        exists = True
        remote_size = meta.get('size')
        if size_int is not None and isinstance(remote_size, int) and remote_size == size_int:
            same = True
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            exists = False
        else:
            logger.error('Failed to check Yandex Disk resource meta: %r', exc)
    except Exception as exc:  # noqa: BLE001
        logger.error('Failed to check Yandex Disk resource meta: %r', exc)

    # Если файл уже есть и содержимое совпадает — повторно не загружаем,
    # просто даём понять клиенту, что можно использовать существующий ресурс.
    if exists and same:
        return {
            'href': None,
            'method': None,
            'path': target_path,
            'exists': True,
            'same': True,
            'size': remote_size,
        }

    # 2. Если файл с таким именем есть, но содержимое другое — подбираем свободное имя.
    candidate_name = safe_name
    name_root, ext = os.path.splitext(safe_name)
    suffix = 2
    final_path = target_path
    if exists:
        while True:
            candidate_name = f'{name_root} ({suffix}){ext}'
            candidate_path = f'{base}/{candidate_name}'
            encoded_candidate = urllib.parse.quote(candidate_path, safe='')
            check_url = f'https://cloud-api.yandex.net/v1/disk/resources?path={encoded_candidate}&fields=size'
            try:
                check_req = urllib.request.Request(
                    check_url,
                    headers={'Authorization': f'OAuth {access_token}'},
                )
                with urllib.request.urlopen(check_req, timeout=10) as resp:
                    _ = resp.read()
                # Файл существует — пробуем следующий суффикс.
                suffix += 1
                if suffix > 50:
                    # Защитимся от бесконечного цикла.
                    break
            except urllib.error.HTTPError as exc:
                if exc.code == 404:
                    final_path = candidate_path
                    break
                logger.error('Failed to probe Yandex Disk name candidate: %r', exc)
                break
            except Exception as exc:  # noqa: BLE001
                logger.error('Failed to probe Yandex Disk name candidate: %r', exc)
                break
    else:
        final_path = target_path

    overwrite = bool(payload.get('overwrite'))
    query = urllib.parse.urlencode(
        {
            'path': final_path,
            'overwrite': 'true' if overwrite else 'false',
        },
    )
    try:
        req = urllib.request.Request(
            f'https://cloud-api.yandex.net/v1/disk/resources/upload?{query}',
            headers={'Authorization': f'OAuth {access_token}'},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode('utf-8'))
    except Exception as exc:  # noqa: BLE001
        logger.error('Failed to get Yandex Disk upload URL: %r', exc)
        raise HTTPException(status_code=502, detail='Не удалось получить URL загрузки на Яндекс.Диск')

    href = data.get('href') or ''
    method = (data.get('method') or 'PUT').upper()
    if not href:
        raise HTTPException(status_code=502, detail='Яндекс.Диск не вернул ссылку для загрузки')
    return {
        'href': href,
        'method': method,
        'path': final_path,
        'exists': exists,
        'same': same,
    }


@router.get('/api/yandex/disk/file')
def yandex_open_file(
    path: str = Query(..., description='Путь ресурса на Яндекс.Диске (app:/ или disk:/)'),
    current_user: User = Depends(get_current_user),
):
    """
    Проксирует скачивание файла с Яндекс.Диска через API.

    Принимает логический путь (app:/... или disk:/...) и:
      - по access_token текущего пользователя запрашивает href для скачивания;
      - делает редирект на этот href.

    Это позволяет открывать вложения из app‑папки без необходимости
    угадывать URL веб‑интерфейса Диска.
    """
    tokens = get_yandex_tokens(current_user.id)
    access_token = tokens.get('accessToken') if tokens else None
    if not access_token:
        raise HTTPException(status_code=400, detail='Интеграция с Яндекс.Диском не настроена')

    disk_path = (path or '').strip()
    if not disk_path:
        raise HTTPException(status_code=400, detail='Не указан путь на Яндекс.Диске')

    encoded = urllib.parse.quote(disk_path, safe='')

    # 1. Если у ресурса уже есть публичная ссылка (пользователь делился им в интерфейсе),
    #    просто перенаправляем на неё — так файл открывается в приложении/веб‑просмотрщике.
    meta_url = f'https://cloud-api.yandex.net/v1/disk/resources?path={encoded}&fields=public_url'
    public_url: str | None = None
    try:
        meta_req = urllib.request.Request(
            meta_url,
            headers={'Authorization': f'OAuth {access_token}'},
        )
        with urllib.request.urlopen(meta_req, timeout=10) as resp:
            meta = json.loads(resp.read().decode('utf-8'))
        public_url = meta.get('public_url') or None
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            raise HTTPException(status_code=404, detail='Файл на Яндекс.Диске не найден')
        logger.error('Failed to fetch Yandex Disk resource meta: %r', exc)
    except Exception as exc:  # noqa: BLE001
        logger.error('Failed to fetch Yandex Disk resource meta: %r', exc)

    if public_url:
        return RedirectResponse(public_url)

    # 2. Публичной ссылки нет — публикуем ресурс, чтобы получить
    #    стабильный public_url (disk.yandex.ru/d/...), который
    #    открывается в соответствующем приложении/просмотрщике.
    publish_url = f'https://cloud-api.yandex.net/v1/disk/resources/publish?path={encoded}'
    try:
        pub_req = urllib.request.Request(
            publish_url,
            method='PUT',
            headers={'Authorization': f'OAuth {access_token}'},
        )
        with urllib.request.urlopen(pub_req, timeout=10) as resp:
            pub_data = json.loads(resp.read().decode('utf-8'))
        public_url = pub_data.get('public_url') or None
    except urllib.error.HTTPError as exc:
        logger.error('Failed to publish Yandex Disk resource: %r', exc)
        if exc.code == 404:
            raise HTTPException(status_code=404, detail='Файл на Яндекс.Диске не найден')
        # Если публикация не удалась по другой причине — пробуем ещё раз прочитать мету.
        try:
            meta_req = urllib.request.Request(
                meta_url,
                headers={'Authorization': f'OAuth {access_token}'},
            )
            with urllib.request.urlopen(meta_req, timeout=10) as resp:
                meta = json.loads(resp.read().decode('utf-8'))
            public_url = meta.get('public_url') or None
        except Exception as exc2:  # noqa: BLE001
            logger.error('Failed to refetch Yandex Disk resource meta after publish error: %r', exc2)
            raise HTTPException(status_code=502, detail='Не удалось опубликовать файл на Яндекс.Диске')
    except Exception as exc:  # noqa: BLE001
        logger.error('Failed to publish Yandex Disk resource: %r', exc)
        raise HTTPException(status_code=502, detail='Не удалось опубликовать файл на Яндекс.Диске')

    # На практике Яндекс.Диск иногда не возвращает public_url сразу в ответе на publish,
    # хотя ссылка появляется в метаданных чуть позже. Чтобы не заставлять пользователя
    # кликать второй раз, пробуем ещё раз прочитать мету.
    if not public_url:
        try:
            meta_req = urllib.request.Request(
                meta_url,
                headers={'Authorization': f'OAuth {access_token}'},
            )
            with urllib.request.urlopen(meta_req, timeout=10) as resp:
                meta = json.loads(resp.read().decode('utf-8'))
            public_url = meta.get('public_url') or None
        except Exception as exc:  # noqa: BLE001
            logger.error('Failed to refetch Yandex Disk resource meta after publish success: %r', exc)

    # Если даже после повторного чтения метаданных нет public_url, делаем
    # запасной вариант — прямую ссылку на скачивание через resources/download.
    if not public_url:
        download_url = f'https://cloud-api.yandex.net/v1/disk/resources/download?path={encoded}'
        try:
            dl_req = urllib.request.Request(
                download_url,
                headers={'Authorization': f'OAuth {access_token}'},
            )
            with urllib.request.urlopen(dl_req, timeout=10) as resp:
                dl_data = json.loads(resp.read().decode('utf-8'))
            href = dl_data.get('href') or None
            if href:
                return RedirectResponse(href)
        except urllib.error.HTTPError as exc:  # noqa: BLE001
            logger.error('Failed to get Yandex Disk download href: %r', exc)
            if exc.code == 404:
                raise HTTPException(status_code=404, detail='Файл на Яндекс.Диске не найден')
        except Exception as exc:  # noqa: BLE001
            logger.error('Failed to get Yandex Disk download href: %r', exc)

    if not public_url:
        raise HTTPException(status_code=502, detail='Яндекс.Диск не вернул публичную ссылку')

    return RedirectResponse(public_url)

