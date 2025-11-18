const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data', 'data.sqlite');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

module.exports = db;
