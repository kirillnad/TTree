# -*- coding: utf-8 -*-
import re
import textwrap
from pathlib import Path
path = Path("main.py")
text = path.read_text(encoding="utf-8")
pattern = r"@app.post\('/api/uploads'\)\s+async def upload_file\(file: UploadFile = File\(\.\.\.\)\):\s+[\s\S]*?return \{'url': f'/uploads/\{dest.relative_to\(UPLOADS_DIR\).as_posix\(\)\}'\}\n"
replacement = textwrap.dedent('''
@app.post('/api/uploads')
async def upload_file(file: UploadFile = File(...)):
    if not file.content_type or not file.content_type.startswith('image/'):
        raise HTTPException(status_code=400, detail='Ошибка формата: нужен image/*')
    now = datetime.utcnow()
    target_dir = UPLOADS_DIR / str(now.year) / f"{now.month:02}"
    target_dir.mkdir(parents=True, exist_ok=True)
    filename = f"{int(now.timestamp()*1000)}-{os.urandom(4).hex()}.webp"
    dest = target_dir / filename

    buffer = BytesIO()
    size = 0
    while chunk := await file.read(1024 * 256):
        size += len(chunk)
        if size > 20 * 1024 * 1024:
            raise HTTPException(status_code=400, detail='Размер файла превышает лимит')
        buffer.write(chunk)
    buffer.seek(0)

    try:
        img = Image.open(buffer)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail='Не удалось прочитать изображение') from exc

    max_width = 1920
    if img.width > max_width:
        new_height = int(img.height * max_width / img.width)
        img = img.resize((max_width, max(new_height, 1)), Image.Resampling.LANCZOS)

    if img.mode in ('RGBA', 'LA', 'P'):
        img = img.convert('RGBA')
    else:
        img = img.convert('RGB')

    out_buf = BytesIO()
    img.save(out_buf, 'WEBP', quality=80, method=6)
    out_bytes = out_buf.getvalue()

    async with aiofiles.open(dest, 'wb') as out_file:
        await out_file.write(out_bytes)

    return {'url': f"/uploads/{dest.relative_to(UPLOADS_DIR).as_posix()}"}

''')
new_text, count = re.subn(pattern, replacement, text)
if count != 1:
    raise SystemExit(f'pattern matches: {count}')
path.write_text(new_text, encoding="utf-8")
