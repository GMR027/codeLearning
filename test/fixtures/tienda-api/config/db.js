const { DatabaseSync } = require("node:sqlite");

// Una sola conexión para toda la aplicación.
const db = new DatabaseSync(process.env.DB_FILE || ":memory:");

db.exec(`
  CREATE TABLE IF NOT EXISTS productos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    precio REAL NOT NULL,
    stock INTEGER NOT NULL DEFAULT 0
  )
`);

module.exports = db;
