const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { requireAuth, requireAdmin } = require('./auth');
const { haversineKm } = require('./db');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isInt = (v, min, max) =>
  Number.isInteger(v) && v >= min && (max === undefined || v <= max);
const num = (v) => (v === undefined || v === null || v === '' ? undefined : Number(v));

function publicUser(u) {
  return { id: u.id, displayName: u.display_name, email: u.email, isAdmin: !!u.is_admin };
}

function adminEmail() {
  return (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
}

module.exports = function apiRoutes(db) {
  const router = express.Router();

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many attempts, try again later' },
  });
  const writeLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 120,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many requests, try again later' },
  });

  // ---------- Auth ----------
  router.post('/auth/register', authLimiter, (req, res) => {
    const { displayName, email, password } = req.body || {};
    const name = (displayName || '').trim();
    const mail = (email || '').trim().toLowerCase();
    if (!name || name.length > 40) return res.status(400).json({ error: 'Display name is required (max 40 chars)' });
    if (!EMAIL_RE.test(mail)) return res.status(400).json({ error: 'Valid email required' });
    if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
      return res.status(400).json({ error: 'Password must be 8-128 characters' });
    }
    if (db.prepare('SELECT id FROM users WHERE email = ?').get(mail)) {
      return res.status(409).json({ error: 'Email already registered' });
    }
    const hash = bcrypt.hashSync(password, 10);
    const isAdmin = adminEmail() !== '' && mail === adminEmail() ? 1 : 0;
    const info = db
      .prepare('INSERT INTO users (display_name, email, password_hash, is_admin) VALUES (?, ?, ?, ?)')
      .run(name, mail, hash, isAdmin);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    req.session.userId = user.id;
    req.session.isAdmin = !!user.is_admin;
    res.status(201).json(publicUser(user));
  });

  router.post('/auth/login', authLimiter, (req, res) => {
    const { email, password } = req.body || {};
    const mail = (email || '').trim().toLowerCase();
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(mail);
    if (!user || !bcrypt.compareSync(String(password || ''), user.password_hash)) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    // Re-derive admin from ADMIN_EMAIL so the owner is admin even if the
    // account was created before the env var was set.
    const shouldBeAdmin = adminEmail() !== '' && mail === adminEmail();
    if (shouldBeAdmin && !user.is_admin) {
      db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(user.id);
      user.is_admin = 1;
    }
    req.session.userId = user.id;
    req.session.isAdmin = !!user.is_admin;
    res.json(publicUser(user));
  });

  router.post('/auth/logout', (req, res) => {
    req.session.destroy(() => {
      res.clearCookie('looscout.sid');
      res.json({ ok: true });
    });
  });

  router.get('/auth/me', (req, res) => {
    if (!req.session.userId) return res.json({ user: null });
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
    if (!user) return res.json({ user: null });
    req.session.isAdmin = !!user.is_admin;
    res.json({ user: publicUser(user) });
  });

  // ---------- Washrooms ----------
  router.get('/washrooms', (req, res) => {
    const q = (req.query.q || '').trim();
    const wheelchair = req.query.wheelchair === '1';
    const baby = req.query.baby === '1';
    const sort = req.query.sort === 'rating' ? 'rating' : 'distance';
    const lat = num(req.query.lat);
    const lng = num(req.query.lng);
    const useDistance =
      lat !== undefined && lng !== undefined && !Number.isNaN(lat) && !Number.isNaN(lng);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 100));

    const conds = [`w.status = 'approved'`];
    const params = [];
    if (q) {
      conds.push(`w.name LIKE '%' || ? || '%' ESCAPE '\\'`);
      params.push(q.replace(/[\\%_]/g, '\\$&'));
    }
    if (wheelchair) conds.push('w.wheelchair_accessible = 1');
    if (baby) conds.push('w.baby_change_table = 1');
    const order =
      sort === 'rating' ? 'avg_cleanliness DESC NULLS LAST, rating_count DESC' : 'w.created_at DESC';
    // Bounded candidate set; distance is computed and sorted in JS below
    // (node:sqlite has no user-defined SQL functions).
    const rows = db
      .prepare(
        `SELECT w.id, w.name, w.latitude, w.longitude, w.notes,
                w.wheelchair_accessible, w.baby_change_table, w.created_at,
                COUNT(r.id) AS rating_count,
                AVG(r.cleanliness) AS avg_cleanliness,
                AVG(r.privacy) AS avg_privacy
         FROM washrooms w LEFT JOIN ratings r ON r.washroom_id = w.id
         WHERE ${conds.join(' AND ')}
         GROUP BY w.id ORDER BY ${order} LIMIT 2000`
      )
      .all(...params);
    let shaped = rows.map((r) => {
      const s = shapeWashroomSummary(r);
      if (useDistance) s.distanceKm = round2(haversineKm(r.latitude, r.longitude, lat, lng));
      return s;
    });
    if (useDistance && sort === 'distance') {
      shaped.sort((a, b) => a.distanceKm - b.distanceKm);
    }
    res.json(shaped.slice(0, limit));
  });

  router.post('/washrooms', requireAuth, writeLimiter, (req, res) => {
    const { name, latitude, longitude, notes, wheelchairAccessible, babyChangeTable } = req.body || {};
    const cleanName = (name || '').trim();
    const lat = Number(latitude);
    const lng = Number(longitude);
    const cleanNotes = (notes || '').trim();
    if (!cleanName || cleanName.length > 120) {
      return res.status(400).json({ error: 'Name is required (max 120 chars)' });
    }
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
      return res.status(400).json({ error: 'Valid latitude/longitude required' });
    }
    if (cleanNotes.length > 2000) return res.status(400).json({ error: 'Notes max 2000 chars' });
    const info = db
      .prepare(
        `INSERT INTO washrooms (name, latitude, longitude, notes, wheelchair_accessible, baby_change_table, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        cleanName,
        lat,
        lng,
        cleanNotes,
        wheelchairAccessible ? 1 : 0,
        babyChangeTable ? 1 : 0,
        req.session.userId
      );
    res.status(201).json({ id: info.lastInsertRowid });
  });

  router.get('/washrooms/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const w = db.prepare('SELECT * FROM washrooms WHERE id = ?').get(id);
    if (!w) return res.status(404).json({ error: 'Not found' });
    const isAdmin = !!req.session.isAdmin;
    if (w.status !== 'approved' && !isAdmin) return res.status(404).json({ error: 'Not found' });

    const agg = db
      .prepare(
        `SELECT COUNT(*) AS rating_count, AVG(cleanliness) AS avg_cleanliness,
                AVG(privacy) AS avg_privacy, AVG(stalls) AS avg_stalls, AVG(urinals) AS avg_urinals
         FROM ratings WHERE washroom_id = ?`
      )
      .get(id);
    const ratings = db
      .prepare(
        `SELECT r.id, r.cleanliness, r.privacy, r.stalls, r.urinals, r.comment,
                r.created_at, r.updated_at, u.display_name
         FROM ratings r JOIN users u ON u.id = r.user_id
         WHERE r.washroom_id = ? ORDER BY r.updated_at DESC`
      )
      .all(id);
    let distanceKm = null;
    const lat = num(req.query.lat);
    const lng = num(req.query.lng);
    if (lat !== undefined && lng !== undefined && !Number.isNaN(lat) && !Number.isNaN(lng)) {
      distanceKm = round2(haversineKm(w.latitude, w.longitude, lat, lng));
    }
    res.json({
      ...shapeWashroomSummary({ ...w, rating_count: agg.rating_count, avg_cleanliness: agg.avg_cleanliness, avg_privacy: agg.avg_privacy }),
      status: w.status,
      avgStalls: agg.avg_stalls === null ? null : Math.round(agg.avg_stalls),
      avgUrinals: agg.avg_urinals === null ? null : Math.round(agg.avg_urinals),
      distanceKm,
      ratings: ratings.map((r) => ({
        id: r.id,
        displayName: r.display_name,
        cleanliness: r.cleanliness,
        privacy: r.privacy,
        stalls: r.stalls,
        urinals: r.urinals,
        comment: r.comment,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
      ownRating: req.session.userId
        ? db.prepare('SELECT * FROM ratings WHERE washroom_id = ? AND user_id = ?').get(id, req.session.userId) || null
        : null,
    });
  });

  // ---------- Ratings (one per user per washroom; POST upserts) ----------
  router.post('/washrooms/:id/ratings', requireAuth, writeLimiter, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const w = db.prepare("SELECT id FROM washrooms WHERE id = ? AND status = 'approved'").get(id);
    if (!w) return res.status(404).json({ error: 'Washroom not found' });
    const { cleanliness, privacy, stalls, urinals, comment } = req.body || {};
    if (!isInt(cleanliness, 1, 5)) return res.status(400).json({ error: 'cleanliness must be 1-5' });
    if (!isInt(privacy, 1, 5)) return res.status(400).json({ error: 'privacy must be 1-5' });
    if (!isInt(stalls, 0, 1000)) return res.status(400).json({ error: 'stalls must be >= 0' });
    if (!isInt(urinals, 0, 1000)) return res.status(400).json({ error: 'urinals must be >= 0' });
    const cleanComment = (comment || '').trim();
    if (cleanComment.length > 1000) return res.status(400).json({ error: 'Comment max 1000 chars' });

    const existing = db
      .prepare('SELECT id FROM ratings WHERE washroom_id = ? AND user_id = ?')
      .get(id, req.session.userId);
    db.prepare(
      `INSERT INTO ratings (washroom_id, user_id, cleanliness, privacy, stalls, urinals, comment, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(washroom_id, user_id) DO UPDATE SET
         cleanliness = excluded.cleanliness, privacy = excluded.privacy,
         stalls = excluded.stalls, urinals = excluded.urinals,
         comment = excluded.comment, updated_at = datetime('now')`
    ).run(id, req.session.userId, cleanliness, privacy, stalls, urinals, cleanComment);
    const rating = db
      .prepare('SELECT * FROM ratings WHERE washroom_id = ? AND user_id = ?')
      .get(id, req.session.userId);
    res.status(existing ? 200 : 201).json({ rating: shapeRating(rating), updated: !!existing });
  });

  router.delete('/washrooms/:id/ratings', requireAuth, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const info = db
      .prepare('DELETE FROM ratings WHERE washroom_id = ? AND user_id = ?')
      .run(id, req.session.userId);
    if (!info.changes) return res.status(404).json({ error: 'No rating to delete' });
    res.json({ ok: true });
  });

  // ---------- Reports ----------
  router.post('/reports', requireAuth, writeLimiter, (req, res) => {
    const { targetType, targetId, reason } = req.body || {};
    const tid = parseInt(targetId, 10);
    const cleanReason = (reason || '').trim();
    if (targetType !== 'washroom' && targetType !== 'rating') {
      return res.status(400).json({ error: "targetType must be 'washroom' or 'rating'" });
    }
    if (!Number.isInteger(tid) || tid <= 0) return res.status(400).json({ error: 'Valid targetId required' });
    if (!cleanReason || cleanReason.length > 500) {
      return res.status(400).json({ error: 'Reason is required (max 500 chars)' });
    }
    const exists =
      targetType === 'washroom'
        ? db.prepare('SELECT id FROM washrooms WHERE id = ?').get(tid)
        : db.prepare('SELECT id FROM ratings WHERE id = ?').get(tid);
    if (!exists) return res.status(404).json({ error: 'Target not found' });
    const info = db
      .prepare(
        'INSERT INTO reports (target_type, target_id, reporter_user_id, reason) VALUES (?, ?, ?, ?)'
      )
      .run(targetType, tid, req.session.userId, cleanReason);
    res.status(201).json({ id: info.lastInsertRowid });
  });

  // ---------- Admin ----------
  router.get('/admin/reports', requireAdmin, (req, res) => {
    const unresolvedOnly = req.query.unresolved !== '0';
    const rows = db
      .prepare(
        `SELECT rep.id, rep.target_type, rep.target_id, rep.reason, rep.created_at, rep.resolved,
                u.display_name AS reporter_name,
                CASE WHEN rep.target_type = 'washroom'
                     THEN (SELECT name FROM washrooms WHERE id = rep.target_id)
                     ELSE (SELECT 'Rating on ' || COALESCE((SELECT name FROM washrooms WHERE id = ratings.washroom_id), '(deleted)')
                           FROM ratings WHERE id = rep.target_id)
                END AS target_summary
         FROM reports rep JOIN users u ON u.id = rep.reporter_user_id
         ${unresolvedOnly ? 'WHERE rep.resolved = 0' : ''}
         ORDER BY rep.created_at DESC`
      )
      .all();
    res.json(rows);
  });

  router.post('/admin/reports/:id/resolve', requireAdmin, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const resolved = req.body && req.body.resolved === false ? 0 : 1;
    const info = db.prepare('UPDATE reports SET resolved = ? WHERE id = ?').run(resolved, id);
    if (!info.changes) return res.status(404).json({ error: 'Report not found' });
    res.json({ ok: true });
  });

  router.get('/admin/washrooms', requireAdmin, (req, res) => {
    const status = req.query.status === 'flagged' ? 'flagged' : 'approved';
    const rows = db
      .prepare(
        `SELECT w.*, u.display_name AS created_by_name,
                (SELECT COUNT(*) FROM ratings r WHERE r.washroom_id = w.id) AS rating_count,
                (SELECT COUNT(*) FROM reports rep WHERE rep.target_type = 'washroom' AND rep.target_id = w.id AND rep.resolved = 0) AS open_reports
         FROM washrooms w LEFT JOIN users u ON u.id = w.created_by
         WHERE w.status = ? ORDER BY w.created_at DESC`
      )
      .all(status);
    res.json(rows.map(shapeWashroomSummary));
  });

  router.post('/admin/washrooms/:id/status', requireAdmin, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const status = req.body && req.body.status;
    if (status !== 'approved' && status !== 'flagged') {
      return res.status(400).json({ error: "status must be 'approved' or 'flagged'" });
    }
    const info = db.prepare('UPDATE washrooms SET status = ? WHERE id = ?').run(status, id);
    if (!info.changes) return res.status(404).json({ error: 'Washroom not found' });
    res.json({ ok: true });
  });

  router.delete('/admin/washrooms/:id', requireAdmin, (req, res) => {
    const id = parseInt(req.params.id, 10);
    let changes = 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare("DELETE FROM reports WHERE target_type = 'washroom' AND target_id = ?").run(id);
      changes = db.prepare('DELETE FROM washrooms WHERE id = ?').run(id).changes;
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    if (!changes) return res.status(404).json({ error: 'Washroom not found' });
    res.json({ ok: true });
  });

  router.delete('/admin/ratings/:id', requireAdmin, (req, res) => {
    const id = parseInt(req.params.id, 10);
    let changes = 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare("DELETE FROM reports WHERE target_type = 'rating' AND target_id = ?").run(id);
      changes = db.prepare('DELETE FROM ratings WHERE id = ?').run(id).changes;
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    if (!changes) return res.status(404).json({ error: 'Rating not found' });
    res.json({ ok: true });
  });

  router.get('/health', (req, res) => res.json({ ok: true }));

  return router;
};

function shapeWashroomSummary(w) {
  return {
    id: w.id,
    name: w.name,
    latitude: w.latitude,
    longitude: w.longitude,
    notes: w.notes,
    wheelchairAccessible: !!w.wheelchair_accessible,
    babyChangeTable: !!w.baby_change_table,
    createdAt: w.created_at,
    createdByName: w.created_by_name,
    status: w.status,
    ratingCount: w.rating_count || 0,
    avgCleanliness: w.avg_cleanliness === null || w.avg_cleanliness === undefined ? null : round1(w.avg_cleanliness),
    avgPrivacy: w.avg_privacy === null || w.avg_privacy === undefined ? null : round1(w.avg_privacy),
    distanceKm: w.distance_km === undefined ? undefined : round2(w.distance_km),
    openReports: w.open_reports,
  };
}

function shapeRating(r) {
  if (!r) return null;
  return {
    id: r.id,
    washroomId: r.washroom_id,
    cleanliness: r.cleanliness,
    privacy: r.privacy,
    stalls: r.stalls,
    urinals: r.urinals,
    comment: r.comment,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function round1(v) {
  return Math.round(v * 10) / 10;
}
function round2(v) {
  return v === null ? null : Math.round(v * 100) / 100;
}
