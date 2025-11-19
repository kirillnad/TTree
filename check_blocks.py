import sqlite3
from pathlib import Path
path = Path(r"servpy/data/servpy.sqlite")
conn = sqlite3.connect(path)
conn.row_factory = sqlite3.Row
row = conn.execute("SELECT text FROM blocks WHERE text LIKE '%block-header%' LIMIT 1").fetchone()
if row:
    print('found')
    print(row['text'])
else:
    print('not found')
