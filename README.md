# Mawid

Organizers create events and share a public link. Visitors register with a name and email, and no account is needed. The server enforces each event's capacity and blocks duplicate emails, even when many people register at the same moment.

Stack: Node.js (CommonJS), Express 5, EJS, Prisma 7 (MariaDB driver adapter), MySQL (XAMPP), and sessions stored in MySQL.

---

## 1. Requirements

- **Node.js 20.19 or newer** (Node 22 or 24 recommended). Check with `node -v`.
- **XAMPP** with **MySQL** started from the XAMPP Control Panel.

## 2. Create the database (first time only)

1. Start **MySQL** in the XAMPP Control Panel.
2. Open phpMyAdmin (`http://localhost/phpmyadmin`) → **New** → database name `mawid`, collation `utf8mb4_unicode_ci` → **Create**.
   Don't create any tables yourself. Prisma creates them in step 4.

If you already have a `mawid` database from earlier work, keep it. Step 4 never deletes data.

## 3. Configure `.env`

In the project folder:

```bash
# Windows (PowerShell / cmd)
copy .env.example .env
# macOS / Linux
cp .env.example .env
```

Open `.env` and set:

| Variable | What to put |
| --- | --- |
| `DB_HOST`, `DB_PORT` | `localhost`, `3306` (XAMPP defaults) |
| `DB_USER`, `DB_PASSWORD` | XAMPP default is `root` with an **empty** password |
| `DB_NAME` | `mawid` (the database from step 2) |
| `SESSION_SECRET` | a long random string. Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `APP_URL` | `http://localhost:3000` (used to build public event links) |

You can also set a single `DATABASE_URL=mysql://root:@localhost:3306/mawid` instead of the `DB_*` lines. If it's set, it takes priority.

## 4. Install and start

```bash
npm install        # also runs "prisma generate" automatically (postinstall)
npm start          # applies pending migrations (prisma migrate deploy), then starts the app
```

Open **http://localhost:3000**.

You should see `Connected to MySQL` and `Mawid is running on port 3000`.
For development with auto-reload, run `npm run db:deploy` once, then `npm run dev`.

**Then verify everything against your database:** `npm run smoke` in a second terminal (section 6).

### Database commands (all non-destructive)

| Command | What it does |
| --- | --- |
| `npm run db:deploy` | `prisma migrate deploy`: applies migrations that haven't been applied yet. Never resets or drops data. |
| `npm run db:status` | `prisma migrate status`: shows which migrations are applied |
| `npm run db:validate` | `prisma validate`: checks `prisma/schema.prisma` |
| `npm run db:generate` | `prisma generate`: rebuilds the Prisma client (run after schema changes) |

> Avoid `npx prisma migrate reset` and `npx prisma db push --force-reset`. Both **erase your data**.
> `npm run migrate` (`prisma migrate dev`) is only for creating *new* migrations while developing. If it detects drift, it may offer to reset the database, so answer **No** unless you want to lose your data.

**If `npm start` fails with "table `users` already exists":** the tables were created earlier without Prisma's migration history. Tell Prisma the first migration is already applied (this changes no data), then start again:

```bash
npx prisma migrate resolve --applied 20261108152800_init
npm start
```

### Troubleshooting startup

| Message | Cause and fix |
| --- | --- |
| `Database is not configured…` | `.env` is missing or has no `DATABASE_URL`/`DB_*` values. Do step 3. |
| `SESSION_SECRET is not set…` | Add `SESSION_SECRET` to `.env` (step 3). |
| `Could not connect to MySQL: …` | MySQL isn't started in XAMPP, or the host, port, user, password, or database name is wrong. Start MySQL and check `.env`. |
| `Can't reach database server` / `P1001` during `npm start` | Same as above: `prisma migrate deploy` can't reach MySQL. |
| `Unknown database 'mawid'` / `P1003` | Create the database in phpMyAdmin (step 2). |
| "table `users` already exists" | See the `migrate resolve` note above. |
| `EADDRINUSE` | Port 3000 is in use. Set another `PORT` (and `APP_URL`) in `.env`. |

## 5. Using the app

1. **Sign up** (or log in) as an organizer.
2. **My events → Create a new event**: title, optional location, start date/time (must be in the future), and capacity (1–10,000).
3. After creating it you land on the event's organizer page. It shows the **public link** (`http://localhost:3000/e/<slug>`) and the **attendee list**.
4. Open the public link in a private window (logged out) and register with a name and email.
5. Back on the organizer page, refresh to see the attendee.

### Routes

| Route | Access | Purpose |
| --- | --- | --- |
| `GET /signup`, `POST /signup`, `GET /login`, `POST /login`, `POST /logout` | public | authentication (unchanged) |
| `GET /dashboard` | logged in | your events with registered/capacity counts and public links |
| `GET /events/new`, `POST /events` | logged in | create an event |
| `GET /events/:id` | logged in, **owner only** | event details, public link, attendee list |
| `GET /e/:slug` | public | event page and registration form |
| `POST /e/:slug/register` | public | register (name + email) |

Registration responses: `201` registered · `400` invalid input · `404` unknown event · `409` event full or email already registered · `503` busy (retry).

## 6. Verify everything against your XAMPP database (one command)

With MySQL running in XAMPP and the app started (`npm start`), open a **second terminal** in the project folder and run:

```bash
npm run smoke
```

`scripts/smoke-test.js` uses real HTTP against your running server and real database, with nothing simulated. It checks 31 things in order:

- pages and login guards, and the 404 page
- signup (validation and duplicate email), logout, wrong and correct passwords, session persistence, and that no password hashes appear in pages
- event creation: validation (past date, capacity 0, missing title) and the random public link
- the public page without login, and registration: invalid input → 400, success → 201, the same email in different case → 409, and capacity 3 filling up so the 4th request gets 409
- the attendee list for the owner, a guest redirected to login, another organizer getting **404**, and no attendee emails on the public page
- **`scripts/race.js` twice:** 20 simultaneous registrations on a capacity-5 event (**exactly 5** must succeed), then 20 with the same email (**exactly 1** must succeed)

It ends with `ALL CHECKS PASSED.` (exit code 0) or lists every failure (exit code 1). Use `--base http://localhost:PORT` if you changed `PORT`.

**Test data:** each run adds two users (`smoke-<run>-a@example.test`, `smoke-<run>-b@example.test`), three events named `Smoke <run> …`, and their registrations, all using the reserved `.test` domain. Nothing is ever deleted. To remove them later, delete those users' events and then the users in phpMyAdmin.

## 7. Concurrency test on its own: `scripts/race.js`

The script sends **20 registration requests to one event at the same moment** and checks that the event never goes over capacity and that one email can't register twice. It exits with code `0` when everything held and `1` when a rule was broken.

It never guesses an event. You must pass one:

1. With the app running, create a **throw-away test event**, for example capacity **5**.
2. Copy its public link from the organizer page.
3. Run:

```bash
# Capacity test: 20 different emails, at most 5 (the capacity) may succeed
npm run race -- --url http://localhost:3000/e/<your-test-event-slug>

# Duplicate test: 20 requests with the SAME email, at most 1 may succeed
npm run race -- --url http://localhost:3000/e/<your-test-event-slug> --mode same-email

# Other ways to pass the event
node scripts/race.js --base http://localhost:3000 --slug <slug> --count 20
RACE_EVENT_URL=http://localhost:3000/e/<slug> node scripts/race.js
```

**Test data it creates:** names `Race Test 01` … `Race Test 20` and emails `race-<runId>-01@example.test` …, or `race-<runId>@example.test` in same-email mode. `<runId>` is random for each run, and `.test` is a reserved domain that can never be a real address. These are real rows on the event you target, so use a test event, not a real one.

### Automated tests (no database needed)

```bash
npm test
```

35 tests. They run the real app (Express, sessions, Helmet, EJS, bcrypt, the controllers and models) and `scripts/smoke-test.js` / `scripts/race.js` over HTTP. The **database** is replaced by an in-memory stand-in for Prisma (`test/support/fake-prisma.js`) that imitates MySQL's unique indexes and `SELECT … FOR UPDATE` row locks. A control run with the lock switched off must oversell, which proves the race test can actually fail. They also cover security headers, cookie flags, session-ID rotation on login, the generic 500 page, oversized forms, and startup with `DATABASE_URL`, `DB_*`, or missing settings.

**These tests do not prove real MySQL behaviour.** That's what `npm run smoke` (section 6) is for.

## 8. How the protections work

- **Capacity (atomic).** Each registration runs in one MySQL transaction:
  1. `SELECT … FROM events WHERE slug = ? FOR UPDATE` locks that event's row.
  2. Check for the email, then count the event's registrations.
  3. Insert only if `count < capacity`, then commit.
  The transaction runs at `READ COMMITTED`. Concurrent registrations for the *same* event wait for the row lock and run one at a time, and each one sees the rows the previous one committed, so the count is always current. No gap locks are taken, so registrations for other events aren't blocked. Deadlocks and lock timeouts are retried up to 3 times; if it's still busy the visitor gets a 503 "try again".
- **Duplicates.** Checked inside the same locked transaction. The existing `UNIQUE (event_id, email)` index is the final safety net: a Prisma `P2002` error becomes a clean `409` "already registered", never a 500. Emails are trimmed and lower-cased before saving.
- **Ownership.** Organizer pages require a session, and events are looked up by `id` **and** `organizer_id`. Someone else's event returns the same 404 as a missing one, so IDs can't be probed. Public pages show only the title, time, location, and a spot count, never attendees or organizer details.
- **Slugs.** A readable title prefix plus 16 random hex characters (64 bits), e.g. `team-dinner-3f9a1c0b7d2e4a65`. On the very unlikely slug collision, creation retries with a new slug (up to 5 times).
- **Errors.** Unexpected errors are logged on the server, and the page shows a generic message: no stack traces, SQL, password hashes, or session data.

## 9. Project layout

```
prisma/
  schema.prisma                     # User, Event, Registration, Session (unchanged)
  migrations/20261108152800_init/   # existing migration; no new migration needed
prisma.config.js                    # Prisma CLI config (reads .env)
scripts/race.js                     # concurrency test (20 simultaneous registrations)
scripts/smoke-test.js               # full end-to-end check of a running server (npm run smoke)
test/                               # npm test: feature, race and app end-to-end tests
  support/fake-prisma.js            # in-memory database used ONLY by the tests
src/
  index.js                          # checks DB connection, starts server
  app.js                            # Express setup, routes, 404/500 handlers
  prisma.js                         # Prisma client (MariaDB adapter)
  db-url.js                         # builds the DB URL from DATABASE_URL or DB_* vars
  session.js                        # express-session + Prisma session store
  helpers.js                        # public URL, date formatting, validation helpers
  middleware/auth.middleware.js     # requireAuth
  models/        user.model.js, event.model.js, registration.model.js
  controllers/   auth.controller.js, event.controller.js, registration.controller.js
  routes/        auth.routes.js, event.routes.js, registration.routes.js
  view/          home, login, signup, dashboard, event-new, event-show,
                 public-event, registered, error (+ partials/header, footer)
```

## 10. Known limitations

- Dates are entered and shown in the **server's local time zone** (fine when the server and organizer are the same machine, as with XAMPP).
- There's no CSRF token. Forms rely on the session cookie's `SameSite=Lax`, which stops other sites from submitting forms with the organizer's session in modern browsers.
- There's no rate limiting on the public registration form (it would interfere with `scripts/race.js`). Add `express-rate-limit`, which is already installed, before deploying publicly.
- Organizers can't edit or delete events yet. Neither was part of this feature.
