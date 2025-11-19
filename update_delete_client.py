from pathlib import Path
path = Path(r"client/app.js")
data = path.read_bytes()
marker = b"function renderSidebarArticleList() {\r\n  if (!refs.sidebarArticleList) return;\r\n  const filtered = state.articlesIndex.filter((article) => {\r\n    if (!state.articleFilterQuery.trim()) return true;\r\n    return (article.title || '')\r\n      .toLowerCase()\r\n      .includes(state.articleFilterQuery.trim().toLowerCase());\r\n  });\r\n"  # unused? we'll insert after renderSidebar?? need snippet near function definitions? maybe better search for 'function deleteCurrentBlock' etc? easier to insert helper before delete function? Keep simple insert before delete function marker.
marker = b"function deleteCurrentBlock() {\r\n  if (!state.currentBlockId) return;\r\n"
helper = b"function countBlocks(blocks = []) {\r\n  return (blocks || []).reduce((acc, block) => acc + 1 + countBlocks(block.children || []), 0);\r\n}\r\n\r\n"
if helper not in data:
    data = data.replace(marker, helper + marker, 1)
else:
    raise SystemExit('helper already exists?')
path.write_bytes(data)
