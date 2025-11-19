from pathlib import Path
path = Path(r"client/app.js")
data = path.read_bytes()
old = b"function deleteCurrentBlock() {\r\n  if (!state.currentBlockId) return;\r\n  const fallbackId = findFallbackBlockId(state.currentBlockId);\r\n"
new = b"function deleteCurrentBlock() {\r\n  if (!state.currentBlockId) return;\r\n  if (countBlocks(state.article?.blocks || []) <= 1) {\r\n    showToast('Нельзя удалять последний блок');\r\n    return;\r\n  }\r\n  const fallbackId = findFallbackBlockId(state.currentBlockId);\r\n"
if old not in data:
    raise SystemExit('delete snippet not found')
data = data.replace(old, new, 1)
path.write_bytes(data)
