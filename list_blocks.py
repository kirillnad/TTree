import sqlite3
from pathlib import Path
path = Path(r"servpy/data/servpy.sqlite")
conn = sqlite3.connect(path)
conn.row_factory = sqlite3.Row
rows = conn.execute("SELECT id, text FROM blocks LIMIT 1").fetchall()
for row in rows:
    print(row['id'])
    print(row['text'][:200])
