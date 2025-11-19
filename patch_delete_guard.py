from pathlib import Path
path = Path(r"client/app.js")
data = path.read_bytes()
old = b"  return located.parent ? located.parent.id : null;\r\n}\r\n\r\nasync function deleteCurrentBlock() {\r\n  if (!state.currentBlockId) return;\r\n"
if old not in data:
    raise SystemExit('marker not found for helper insert')
helper = b"  return located.parent ? located.parent.id : null;\r\n}\r\n\r\nfunction countBlocks(blocks = []) {\r\n  return (blocks || []).reduce((acc, block) => acc + 1 + countBlocks(block.children || []), 0);\r\n}\r\n\r\nasync function deleteCurrentBlock() {\r\n  if (!state.currentBlockId) return;\r\n  if (countBlocks(state.article?.blocks || []) <= 1) {\r\n    showToast('\\u041d\\u0435\\u043b\\u044c\\u0437\\u044f \\u0443\\u0434\\u0430\\u043b\\u044f\\u0442\\u044c \\\\u043f\\u043e\\u0441\\u043b\\u0435\\u0434\\u043d\\u0438\\u0439 \\\\u0431\\u043b\\u043e\\u043a');\r\n    return;\r\n  }\r\n"
# need actual Unicode message; easier to embed direct in bytes by encoding string; build using encode.
helper = ("  return located.parent ? located.parent.id : null;\r\n}\r\n\r\nfunction countBlocks(blocks = []) {\r\n  return (blocks || []).reduce((acc, block) => acc + 1 + countBlocks(block.children || []), 0);\r\n}\r\n\r\nasync function deleteCurrentBlock() {\r\n  if (!state.currentBlockId) return;\r\n  if (countBlocks(state.article?.blocks || []) <= 1) {\r\n    showToast('Нельзя удалять последний блок');\r\n    return;\r\n  }\r\n" ).encode('utf-8')
data = data.replace(old, helper, 1)
path.write_bytes(data)
