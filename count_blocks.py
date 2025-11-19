import sqlite3
from pathlib import Path
path = Path(r"servpy/data/servpy.sqlite")
conn = sqlite3.connect(path)
count = conn.execute("SELECT COUNT(*) FROM blocks").fetchone()[0]
print('blocks', count)
