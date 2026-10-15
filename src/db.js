const { createClient } = require('@libsql/client');
const fs = require('fs');
const path = require('path');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  display_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS washrooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  wheelchair_accessible INTEGER NOT NULL DEFAULT 0,
  baby_change_table INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('approved', 'flagged'))
);

CREATE TABLE IF NOT EXISTS ratings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  washroom_id INTEGER NOT NULL REFERENCES washrooms(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cleanliness INTEGER NOT NULL CHECK (cleanliness BETWEEN 1 AND 5),
  privacy INTEGER NOT NULL CHECK (privacy BETWEEN 1 AND 5),
  stalls INTEGER NOT NULL CHECK (stalls >= 0),
  urinals INTEGER NOT NULL CHECK (urinals >= 0),
  comment TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (washroom_id, user_id)
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type TEXT NOT NULL CHECK (target_type IN ('washroom', 'rating')),
  target_id INTEGER NOT NULL,
  reporter_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_ratings_washroom ON ratings(washroom_id);
CREATE INDEX IF NOT EXISTS idx_reports_resolved ON reports(resolved);
CREATE INDEX IF NOT EXISTS idx_washrooms_status ON washrooms(status);
`;

const SCHEMA_STATEMENTS = SCHEMA.split(';')
  .map((s) => s.trim())
  .filter(Boolean);

// Haversine distance in km, computed in JS (no UDF support over the wire);
// the washroom table is small, so in-app sorting is cheap and exact.
function haversineKm(lat1, lon1, lat2, lon2) {
  if ([lat1, lon1, lat2, lon2].some((v) => v === null || v === undefined || Number.isNaN(v))) return null;
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Thin async wrapper around a libSQL client with a small, sqlite-flavoured
// surface (get/all/run/exec/transaction) so call sites stay readable.
class Db {
  constructor(client) {
    this.client = client;
  }

  async get(sql, ...args) {
    const rs = await this.client.execute({ sql, args });
    return rs.rows[0];
  }

  async all(sql, ...args) {
    const rs = await this.client.execute({ sql, args });
    return rs.rows;
  }

  async run(sql, ...args) {
    const rs = await this.client.execute({ sql, args });
    const id = rs.lastInsertRowid;
    return {
      lastInsertRowid: id === undefined || id === null ? id : Number(id),
      changes: rs.rowsAffected,
    };
  }

  async exec(sql) {
    await this.client.execute({ sql, args: [] });
  }

  async transaction(fn) {
    const tx = await this.client.transaction('write');
    try {
      const result = await fn(new Db(tx));
      await tx.commit();
      return result;
    } catch (e) {
      await tx.rollback();
      throw e;
    }
  }
}

async function initDb() {
  const tursoUrl = process.env.TURSO_DATABASE_URL;
  let client;
  if (tursoUrl) {
    client = createClient({ url: tursoUrl, authToken: process.env.TURSO_AUTH_TOKEN });
  } else {
    // Local file database (dev + tests). DB_PATH is honoured so the
    // existing smoke test keeps working unchanged.
    const filePath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'looscout.db');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    client = createClient({ url: 'file:' + filePath });
  }
  const db = new Db(client);
  await db.client.batch(SCHEMA_STATEMENTS.map((sql) => ({ sql, args: [] })));
  return db;
}

module.exports = { initDb, Db, haversineKm };
