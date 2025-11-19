import sqlite3
from pathlib import Path
path = Path(r"servpy/data/servpy.sqlite")
conn = sqlite3.connect(path)
conn.row_factory = sqlite3.Row
rows = conn.execute("SELECT id, text FROM blocks WHERE text LIKE '%Jupiter%' LIMIT 5").fetchall()
for row in rows:
    print('ID:', row['id'])
    print(row['text'])
    print('-'*40)
