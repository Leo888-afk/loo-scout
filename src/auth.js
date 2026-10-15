const session = require('express-session');

// libSQL-backed session store (avoids the MemoryStore leak and survives
// restarts, with no extra dependencies). Works against Turso or a local file.
class LibsqlStore extends session.Store {
  constructor(db) {
    super();
    this.db = db;
    // Opportunistic cleanup of expired sessions (at most once per minute).
    this.lastSweep = 0;
  }

  static async create(db) {
    const store = new LibsqlStore(db);
    await db.exec(
      `CREATE TABLE IF NOT EXISTS sessions (
         sid TEXT PRIMARY KEY,
         sess TEXT NOT NULL,
         expires INTEGER NOT NULL
       )`
    );
    return store;
  }

  get(sid, cb) {
    this.db.get('SELECT sess, expires FROM sessions WHERE sid = ?', sid).then(
      (row) => {
        if (!row) return cb(null, null);
        if (row.expires <= Date.now()) {
          this.db.run('DELETE FROM sessions WHERE sid = ?', sid).then(
            () => cb(null, null),
            cb
          );
          return;
        }
        try {
          cb(null, JSON.parse(row.sess));
        } catch (err) {
          cb(err);
        }
      },
      cb
    );
  }

  set(sid, sess, cb) {
    const expires =
      sess.cookie && sess.cookie.expires
        ? new Date(sess.cookie.expires).getTime()
        : Date.now() + 7 * 24 * 3600 * 1000;
    this.db
      .run(
        `INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?)
         ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires`,
        sid,
        JSON.stringify(sess),
        expires
      )
      .then(
        () => {
          if (Date.now() - this.lastSweep > 60000) {
            this.lastSweep = Date.now();
            this.db.run('DELETE FROM sessions WHERE expires <= ?', Date.now()).then(
              () => cb(null),
              cb
            );
          } else {
            cb(null);
          }
        },
        cb
      );
  }

  destroy(sid, cb) {
    this.db.run('DELETE FROM sessions WHERE sid = ?', sid).then(() => cb(null), cb);
  }
}

async function sessionMiddleware(db) {
  if (!process.env.SESSION_SECRET) {
    throw new Error('SESSION_SECRET env var is required');
  }
  return session({
    store: await LibsqlStore.create(db),
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
