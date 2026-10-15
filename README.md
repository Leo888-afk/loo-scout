# 🚻 Loo Scout

Find public washrooms nearby and share honest ratings — cleanliness, privacy,
stall and urinal counts. A public, multi-user web app: everyone shares one
map and one set of community ratings.

## Stack

- **Backend:** Node.js 24 + Express 4, SQLite via Node's built-in `node:sqlite`
  (zero native dependencies — no build tools needed anywhere)
- **Auth:** cookie sessions (SQLite-backed store) + bcryptjs password hashing
- **Frontend:** vanilla JS single-page app, Leaflet 1.9.4 + OpenStreetMap tiles via CDN
- **Hardening:** helmet headers, rate limits on auth/write endpoints, input validation

## Project structure

```
loo-scout/
├── src/
│   ├── server.js   # Express app: middleware, static frontend, error handling
│   ├── db.js       # SQLite init, schema, haversine helper
│   ├── auth.js     # SQLite session store, requireAuth / requireAdmin
│   └── routes.js   # All /api/* routes (auth, washrooms, ratings, reports, admin)
├── public/
│   ├── index.html  # App shell
│   ├── styles.css  # Mobile-first styles
│   └── app.js      # SPA: map/list/detail/add/auth/admin views
├── test/
│   └── smoke.sh    # 32 API smoke tests (curl) — `npm test`
├── Dockerfile      # Single-stage, node:24-slim
├── fly.toml        # Fly.io config (256 MB VM + 1 GB volume)
└── README.md
```

## Data model

- **users** — id, display_name, email (unique), password_hash, is_admin, created_at
- **washrooms** — id, name, latitude, longitude, notes, wheelchair_accessible,
  baby_change_table, created_by, created_at, status (`approved` / `flagged`)
- **ratings** — id, washroom_id, user_id, cleanliness (1–5), privacy (1–5),
  stalls (≥0), urinals (≥0), comment, created_at, updated_at.
  **One rating per user per washroom** (UNIQUE constraint); re-submitting updates it.
- **reports** — id, target_type (`washroom` / `rating`), target_id,
  reporter_user_id, reason, created_at, resolved

**Stall/urinal display decision:** the detail view shows the **rounded average**
of all submitted stall/urinal counts (labeled "avg"). Cleanliness and privacy
show the average to 1 decimal plus the individual ratings list.

## Run locally

```bash
npm install
SESSION_SECRET=<long-random-string> ADMIN_EMAIL=you@example.com npm start
# → http://localhost:3000
```

| Env var          | Required | Default                  | Purpose                                    |
|------------------|----------|--------------------------|--------------------------------------------|
| `PORT`           | no       | `3000`                   | HTTP port                                  |
| `DB_PATH`        | no       | `./data/looscout.db`     | SQLite file location                       |
| `SESSION_SECRET` | **yes**  | —                        | Signs session cookies (use a long secret)  |
| `ADMIN_EMAIL`    | **yes**  | —                        | The login email that gets admin rights     |
| `NODE_ENV`       | no       | —                        | Set `production` for secure cookies        |

Register with the `ADMIN_EMAIL` address and that account becomes admin
(it is also re-derived on every login, so setting the var later still works).

## API reference

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/auth/register` | — | `{displayName, email, password}` → user |
| POST | `/api/auth/login` | — | `{email, password}` → user |
| POST | `/api/auth/logout` | — | destroys session |
| GET | `/api/auth/me` | — | current user or `{user: null}` |
| GET | `/api/washrooms?lat&lng&q&wheelchair=1&baby=1&sort=distance\|rating` | — | approved washrooms; distance in km when lat/lng given |
| POST | `/api/washrooms` | user | `{name, latitude, longitude, notes, wheelchairAccessible, babyChangeTable}` |
| GET | `/api/washrooms/:id?lat&lng` | — | detail: averages, stall/urinal avgs, ratings, own rating |
| POST | `/api/washrooms/:id/ratings` | user | create **or update** own rating |
| DELETE | `/api/washrooms/:id/ratings` | user | delete own rating |
| POST | `/api/reports` | user | `{targetType: washroom\|rating, targetId, reason}` |
| GET | `/api/admin/reports` | admin | open reports with target summaries |
| POST | `/api/admin/reports/:id/resolve` | admin | `{resolved: true/false}` |
| GET | `/api/admin/washrooms?status=flagged` | admin | moderation queue |
| POST | `/api/admin/washrooms/:id/status` | admin | `{status: approved\|flagged}` |
| DELETE | `/api/admin/washrooms/:id` | admin | deletes washroom + its ratings/reports |
| DELETE | `/api/admin/ratings/:id` | admin | deletes a rating |

## Deploy on Fly.io (free tier)

Fly.io's free allowance covers this app: one shared 256 MB VM plus a 1 GB
persistent volume for the SQLite database.

```bash
# 1. Install flyctl and log in
curl -L https://fly.io/install.sh | sh
fly auth login

# 2. From the loo-scout directory, create the app (skip when prompted to deploy)
fly launch --no-deploy
#    → accept the generated name or set your own; region: iad is fine

# 3. Persistent disk for the database (without this, data is lost on restart)
fly volumes create loo_scout_data --size 1

# 4. Secrets (never commit these)
fly secrets set SESSION_SECRET="$(openssl rand -hex 32)"
fly secrets set ADMIN_EMAIL="you@example.com"

# 5. Deploy
fly deploy

# 6. Open it
fly open
```

Notes:
- `fly.toml` already sets `DB_PATH=/data/looscout.db` on the mounted volume.
- Machines auto-stop when idle and auto-start on request, so it stays in the
  free allowance for a low-traffic app.
- To update later: `fly deploy` again. The volume (and all washrooms/ratings)
  survives deploys.

## Privacy notes

- No analytics, no trackers, no third-party scripts except Leaflet via CDN.
- Map tiles load from OpenStreetMap's tile servers (that's how the map renders).
- "Get directions" links out to Google Maps with the washroom's coordinates.
- Passwords are hashed with bcrypt (cost 10); sessions are httpOnly cookies.

## Tests

```bash
npm test   # 32 curl-based smoke tests against a throwaway DB in /tmp
```

Covers: register/login/logout, validation errors, admin derivation from
`ADMIN_EMAIL`, add washroom, search/filters, distance sorting, rating
create → update (one-per-user enforced), averages, reporting, admin
resolve/flag/re-approve, auth guards (401/403), and empty-state listing.
