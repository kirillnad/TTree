from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, PlainTextResponse, Response

router = APIRouter()
logger = logging.getLogger('uvicorn.error')

# Вынесено из app/main.py → app/routers/misc.py
BASE_DIR = Path(__file__).resolve().parents[3]
CLIENT_DIR = BASE_DIR / "client"


# Вынесено из app/main.py → app/routers/misc.py
@router.post('/api/client/log')
async def client_log(payload: dict[str, Any]):
    """
    Простейший приёмник клиентских отладочных логов.

    Используется только временно для диагностики проблем на мобильных устройствах
    (например, загрузки изображений), чтобы увидеть параметры запроса в server‑log.
    """
    kind = (payload.get('kind') or '').strip() or 'generic'
    data = payload.get('data')
    logger.error('[client-log] kind=%s data=%s', kind, json.dumps(data, ensure_ascii=False))
    return {'status': 'ok'}


# Вынесено из app/main.py → app/routers/misc.py
@router.get('/api/changelog')
def get_changelog():
    changelog = BASE_DIR / 'changelog.txt'
    if not changelog.exists():
        raise HTTPException(status_code=404, detail='Changelog not found')
    return PlainTextResponse(changelog.read_text(encoding='utf-8'))


# Вынесено из app/main.py → app/routers/misc.py
@router.get('/api/health')
def health():
    return {'status': 'ok'}


# Вынесено из app/main.py → app/routers/misc.py
@router.get('/favicon.ico')
def favicon():
    svg = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<rect width="64" height="64" fill="#0d6efd"/>
<path d="M18 18h8v20h-8zM30 18h8l8 12-8 12h-8l8-12z" fill="#fff"/>
</svg>"""
    return Response(content=svg, media_type='image/svg+xml')


# Вынесено из app/main.py → app/routers/misc.py
@router.get('/manifest.webmanifest')
def pwa_manifest():
    """
    Отдаёт PWA-манифест по тому же пути, что и в <link rel="manifest" href="/manifest.webmanifest">.
    Дублируем через явный маршрут, чтобы избежать любых проблем с StaticFiles/SPA-фолбеком.
    """
    manifest_path = CLIENT_DIR / 'manifest.webmanifest'
    if not manifest_path.is_file():
        raise HTTPException(status_code=404, detail='Manifest not found')
    return FileResponse(manifest_path, media_type='application/manifest+json')

