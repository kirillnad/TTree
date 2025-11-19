import sqlite3
from pathlib import Path
path = Path(r"servpy/data/servpy.sqlite")
conn = sqlite3.connect(path)
conn.row_factory = sqlite3.Row
row = conn.execute("SELECT id, title, updated_at FROM articles WHERE id = 'c4131270-8cd0-4ac7-ba7f-1ff83083d15e'").fetchone()
print('row:', dict(row) if row else None)
print('total', conn.execute('SELECT count(*) FROM articles').fetchone()[0])
