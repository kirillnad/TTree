import sqlite3
from pathlib import Path
path = Path(r"servpy/data/servpy.sqlite")
conn = sqlite3.connect(path)
conn.row_factory = sqlite3.Row
row = conn.execute("SELECT collapsed FROM blocks WHERE id='f02a46c9-e948-4993-a3d8-02fc2739137f'").fetchone()
print('collapsed:', row['collapsed'] if row else None)
