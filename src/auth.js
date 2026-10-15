const session = require('express-session');

// Minimal SQLite-backed session store (avoids the MemoryStore leak and
// survives restarts, with no extra dependencies).
class SQLiteStore extends session.Store {
  constructor(db) {
    super();
    this.db = db;
    this.db
      .prepare(
        `CREATE TABLE IF NOT EXISTS sessions (
           sid TEXT PRIMARY KEY,
           sess TEXT NOT NULL,
           expires INTEGER NOT NULL
         )`
      )
      .run();
    this.getStmt = this.db.prepare('SELECT sess, expires FROM sessions WHERE sid = ?');
    this.setStmt = this.db.prepare(
      `INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?)
       ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires`
    );
    this.destroyStmt = this.db.prepare('DELETE FROM sessions WHERE sid = ?');
    // Opportunistic cleanup of expired sessions (at most once per minute).
    this.lastSweep = 0;
  }

  get(sid, cb) {
    try {
      const row = this.getStmt.get(sid);
      if (!row) return cb(null, null);
      if (row.expires <= Date.now()) {
        this.destroyStmt.run(sid);
        return cb(null, null);
      }
      cb(null, JSON.parse(row.sess));
    } catch (err) {
      cb(err);
    }
  }

  set(sid, sess, cb) {
    try {
      const expires =
        sess.cookie && sess.cookie.expires
          ? new Date(sess.cookie.expires).getTime()
          : Date.now() + 7 * 24 * 3600 * 1000;
      this.setStmt.run(sid, JSON.stringify(sess), expires);
      if (Date.now() - this.lastSweep > 60000) {
        this.lastSweep = Date.now();
        this.db.prepare('DELETE FROM sessions WHERE expires <= ?').run(Date.now());
      }
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  destroy(sid, cb) {
    try {
      this.destroyStmt.run(sid);
      cb(null);
    } catch (err) {
      cb(err);
    }
  }
}

function sessionMiddleware(db) {
  if (!process.env.SESSION_SECRET) {
    throw new Error('SESSION_SECRET env var is required');
  }
  return session({
    store: new SQLiteStore(db),
    name: 'looscout.sid',
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 7 * 24 * 3600 * 1000,
    },
  });
}

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Login required' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.userId || !req.session.isAdmin) {
    return res.status(403).json({ error: 'Admin required' });
  }
  next();
}

module.exports = { sessionMiddleware, requireAuth, requireAdmin };
