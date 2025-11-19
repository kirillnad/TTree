from pathlib import Path
path = Path(r"servpy/app/data_store.py")
data = path.read_text(encoding="utf-8")
insert_after = "def create_default_block() -> Dict[str, Any]:\n    return {\n        'id': str(uuid.uuid4()),\n        'text': 'Новый блок',\n        'collapsed': False,\n        'children': [],\n    }\n\n\n"
helper = "def count_blocks(blocks: List[Dict[str, Any]]) -> int:\n    total = 0\n    for block in blocks or []:\n        total += 1\n        total += count_blocks(block.get('children', []))\n    return total\n\n\n"
if helper.strip() in data:
    raise SystemExit('helper already inserted')
data = data.replace(insert_after, insert_after + helper, 1)
path.write_text(data, encoding="utf-8")
