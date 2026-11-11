// Unit/integration tests that need NO database: Prisma is replaced by an
// in-memory fake that mimics MySQL row locks (see test/support/fake-env.js).
// Real controllers, models and EJS views are used. Run: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const env = require("./support/fake-env");

const fake = env.createFakePrisma();
env.installPrisma(fake);

const helpers = env.freshRequire("src/helpers.js");
env.appLocals.formatDateTime = helpers.formatDateTime;
const { getDatabaseUrl } = env.freshRequire("src/db-url.js");
const { requireAuth } = env.freshRequire("src/middleware/auth.middleware.js");
const EventModel = env.freshRequire("src/models/event.model.js");
const RegistrationModel = env.freshRequire("src/models/registration.model.js");
const eventController = env.freshRequire("src/controllers/event.controller.js");
const registrationController = env.freshRequire("src/controllers/registration.controller.js");
const authController = env.freshRequire("src/controllers/auth.controller.js");

const ALICE = { id: 1, name: "Alice" };
const BOB = { id: 2, name: "Bob" };

function futureLocal(daysAhead = 7) {
    const d = new Date(Date.now() + daysAhead * 86400000);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T18:30`;
}

async function call(handler, reqOpts) {
    const req = env.makeReq(reqOpts);
    const res = env.makeRes(req);
    let nextCalled = false;
    await handler(req, res, () => { nextCalled = true; });
    return { req, res, nextCalled };
}

async function createEvent(user, fields) {
    const { res } = await call(eventController.create, {
        user,
        body: { title: "Test event", location: "Hall A", startsAt: futureLocal(), capacity: "5", ...fields }
    });
    assert.equal(res.statusCode, 302, res.viewLocals && res.viewLocals.error);
    const id = Number(/\/events\/(\d+)\?created=1$/.exec(res.redirectedTo)[1]);
    return fake._db.events.find((e) => e.id === id);
}

// ---------------- helpers ----------------
test("db-url: DATABASE_URL wins, else built from DB_* vars, else undefined", () => {
    const saved = { ...process.env };
    try {
        for (const k of ["DATABASE_URL", "DB_HOST", "DB_PORT", "DB_USER", "DB_PASSWORD", "DB_NAME"]) delete process.env[k];
        assert.equal(getDatabaseUrl(), undefined);
        Object.assign(process.env, { DB_HOST: "localhost", DB_USER: "root", DB_PASSWORD: "", DB_NAME: "mawid" });
        assert.equal(getDatabaseUrl(), "mysql://root@localhost:3306/mawid");
        process.env.DB_PASSWORD = "p@ss:w/rd";
        const url = new URL(getDatabaseUrl());
        assert.equal(decodeURIComponent(url.password), "p@ss:w/rd");
        assert.equal(url.pathname, "/mawid");
        process.env.DATABASE_URL = "mysql://u:p@db:3307/x";
        assert.equal(getDatabaseUrl(), "mysql://u:p@db:3307/x");
    } finally {
        process.env = saved;
    }
});

test("parseLocalDateTime accepts datetime-local values and rejects impossible dates", () => {
    const d = helpers.parseLocalDateTime("2030-02-28T09:05");
    assert.equal(d.getFullYear(), 2030);
    assert.equal(d.getHours(), 9);
    assert.equal(helpers.parseLocalDateTime("2030-02-30T09:05"), null);
    assert.equal(helpers.parseLocalDateTime("2030-13-01T09:05"), null);
    assert.equal(helpers.parseLocalDateTime("2030-01-01 09:05"), null);
    assert.equal(helpers.parseLocalDateTime("tomorrow"), null);
});

test("isValidEmail", () => {
    assert.ok(helpers.isValidEmail("a@b.co"));
    assert.ok(!helpers.isValidEmail("a@b"));
    assert.ok(!helpers.isValidEmail("a b@c.de"));
    assert.ok(!helpers.isValidEmail("x".repeat(250) + "@b.com"));
});

test("slugs: readable prefix + 16 hex chars, unique, within 120 chars", () => {
    const s = EventModel.generateSlug("Ramadan Iftar 2026!");
    assert.match(s, /^ramadan-iftar-2026-[0-9a-f]{16}$/);
    assert.match(EventModel.generateSlug("إفطار رمضان"), /^event-[0-9a-f]{16}$/);
    assert.ok(EventModel.generateSlug("x".repeat(500)).length <= 120);
    const many = new Set(Array.from({ length: 2000 }, () => EventModel.generateSlug("same title")));
    assert.equal(many.size, 2000);
});

// ---------------- auth middleware ----------------
test("requireAuth redirects guests to /login and lets organizers through", async () => {
    const guest = await call(requireAuth, {});
    assert.equal(guest.res.redirectedTo, "/login");
    assert.equal(guest.nextCalled, false);
    const user = await call(requireAuth, { user: ALICE });
    assert.equal(user.nextCalled, true);
});

// ---------------- auth controller ----------------
test("signup creates user and regenerates the session", async () => {
    const { req, res } = await call(authController.signup, {
        body: { name: "Alice", email: " Alice@Example.com ", password: "password123" }
    });
    assert.equal(res.redirectedTo, "/");
    assert.equal(req.session.regenerated, 1);
    assert.deepEqual(req.session.user, { id: 1, name: "Alice" });
    assert.equal(fake._db.users[0].email, "alice@example.com");
    assert.equal(fake._db.users[0].passwordHash, "hash:password123");
});

test("signup race on same email returns 400, not 500", async () => {
    const original = fake.user.findUnique;
    fake.user.findUnique = async () => null; // simulate both requests passing the pre-check
    try {
        const { res } = await call(authController.signup, {
            body: { name: "Copy", email: "alice@example.com", password: "password123" }
        });
        assert.equal(res.statusCode, 400);
        assert.match(res.html, /already taken/);
    } finally {
        fake.user.findUnique = original;
    }
});

test("login: wrong password 401; right password regenerates session", async () => {
    const bad = await call(authController.login, { body: { email: "alice@example.com", password: "nope" } });
    assert.equal(bad.res.statusCode, 401);
    const ok = await call(authController.login, { body: { email: "ALICE@example.com", password: "password123" } });
    assert.equal(ok.res.redirectedTo, "/");
    assert.equal(ok.req.session.regenerated, 1);
    assert.deepEqual(ok.req.session.user, { id: 1, name: "Alice" });
    assert.doesNotMatch(JSON.stringify(ok.req.session.user), /hash/);
});

// ---------------- event creation ----------------
test("event creation validation errors return 400 and keep values (escaped)", async () => {
    const cases = [
        [{ title: "" }, /required/],
        [{ capacity: "" }, /required/],
        [{ title: "x".repeat(201) }, /200 characters/],
        [{ location: "x".repeat(256) }, /255 characters/],
        [{ startsAt: "2020-01-01T10:00" }, /future/],
        [{ startsAt: "2030-02-30T10:00" }, /not a valid date/],
        [{ capacity: "abc" }, /whole number/],
        [{ capacity: "5.5" }, /whole number/],
        [{ capacity: "-3" }, /whole number/],
        [{ capacity: "0" }, /between 1 and 10000/],
        [{ capacity: "10001" }, /between 1 and 10000/]
    ];
    for (const [fields, msg] of cases) {
        const { res } = await call(eventController.create, {
            user: ALICE,
            body: { title: "T", startsAt: futureLocal(), capacity: "5", ...fields }
        });
        assert.equal(res.statusCode, 400, JSON.stringify(fields));
        assert.equal(res.view, "event-new");
        assert.match(res.viewLocals.error, msg, JSON.stringify(fields));
    }
    const xss = await call(eventController.create, {
        user: ALICE, body: { title: '"><script>alert(1)</script>', startsAt: "", capacity: "5" }
    });
    assert.doesNotMatch(xss.res.html, /<script>alert/);
    assert.match(xss.res.html, /&lt;script&gt;/);
    assert.equal(fake._db.events.length, 0);
});

test("create event -> redirect to owner page with public link; empty location stored as null", async () => {
    const event = await createEvent(ALICE, { title: "Team Dinner", location: "  " });
    assert.equal(event.organizerId, 1);
    assert.equal(event.location, null);
    assert.equal(event.capacity, 5);
    assert.ok(event.startsAt instanceof Date);
    assert.match(event.slug, /^team-dinner-[0-9a-f]{16}$/);

    const { res } = await call(eventController.show, { user: ALICE, params: { id: String(event.id) }, query: { created: "1" } });
    assert.equal(res.statusCode, 200);
    assert.match(res.html, /Your event was created/);
    assert.ok(res.html.includes(`http://localhost:3000/e/${event.slug}`));
});

test("APP_URL is used for public links when set", async () => {
    process.env.APP_URL = "https://mawid.example.org/";
    try {
        const event = fake._db.events[0];
        const { res } = await call(eventController.show, { user: ALICE, params: { id: String(event.id) } });
        assert.ok(res.html.includes(`https://mawid.example.org/e/${event.slug}`));
    } finally {
        delete process.env.APP_URL;
    }
});

test("slug collisions are retried", async () => {
    fake._options.forceSlugCollisions = 3;
    const event = await createEvent(ALICE, { title: "Collide" });
    assert.ok(event);
    assert.equal(fake._options.forceSlugCollisions, 0);
});

test("ownership: other organizers and bad ids get 404; dashboard shows only own events", async () => {
    const aliceEvent = fake._db.events[0];
    const bobEvent = await createEvent(BOB, { title: "Bob's party" });

    const asBob = await call(eventController.show, { user: BOB, params: { id: String(aliceEvent.id) } });
    assert.equal(asBob.res.statusCode, 404);
    assert.doesNotMatch(asBob.res.html, /Team Dinner/);

    for (const id of ["999", "abc", "1e3", "99999999999999999999"]) {
        const r = await call(eventController.show, { user: ALICE, params: { id } });
        assert.equal(r.res.statusCode, 404, id);
    }

    const dash = await call(eventController.dashboard, { user: ALICE });
    assert.match(dash.res.html, /Team Dinner/);
    assert.doesNotMatch(dash.res.html, /Bob&#39;s party|Bob's party/);
    const bobDash = await call(eventController.dashboard, { user: BOB });
    assert.match(bobDash.res.html, /Bob&#39;s party/);
    assert.ok(bobEvent);
});

// ---------------- public pages + registration ----------------
test("public event page: 200, shows spots, no attendee data; bad/unknown slug 404", async () => {
    const event = fake._db.events[0];
    const ok = await call(registrationController.showEvent, { params: { slug: event.slug } });
    assert.equal(ok.res.statusCode, 200);
    assert.match(ok.res.html, /5 of 5 spots left/);
    assert.match(ok.res.html, /data-capacity="5" data-registered="0"/);
    assert.doesNotMatch(ok.res.html, /organizer|alice@example/i);
    assert.equal(ok.res.viewLocals.event.organizerId, undefined);

    assert.equal((await call(registrationController.showEvent, { params: { slug: "nope-0000" } })).res.statusCode, 404);
    assert.equal((await call(registrationController.showEvent, { params: { slug: "../etc" } })).res.statusCode, 404);
    assert.equal((await call(registrationController.register, { params: { slug: "nope" }, body: { name: "a", email: "a@b.co" } })).res.statusCode, 404);
});

test("registration validation 400s", async () => {
    const slug = fake._db.events[0].slug;
    const cases = [
        [{ name: "", email: "a@b.co" }, /required/],
        [{ name: "A", email: "" }, /required/],
        [{ name: "x".repeat(101), email: "a@b.co" }, /100 characters/],
        [{ name: "A", email: "not-an-email" }, /valid email/]
    ];
    for (const [body, msg] of cases) {
        const { res } = await call(registrationController.register, { params: { slug }, body });
        assert.equal(res.statusCode, 400);
        assert.match(res.viewLocals.error, msg);
    }
    assert.equal(fake._db.registrations.length, 0);
});

test("register: 201, email normalised; duplicate 409; organizer sees attendee (escaped)", async () => {
    const event = fake._db.events[0];
    const first = await call(registrationController.register, {
        params: { slug: event.slug }, body: { name: "<b>Sara</b>", email: "  Sara@Example.COM " }
    });
    assert.equal(first.res.statusCode, 201);
    assert.equal(first.res.view, "registered");
    assert.equal(fake._db.registrations[0].email, "sara@example.com");

    const dup = await call(registrationController.register, {
        params: { slug: event.slug }, body: { name: "Sara again", email: "sara@example.com" }
    });
    assert.equal(dup.res.statusCode, 409);
    assert.match(dup.res.html, /already registered/);

    const owner = await call(eventController.show, { user: ALICE, params: { id: String(event.id) } });
    assert.match(owner.res.html, /&lt;b&gt;Sara&lt;\/b&gt;/);
    assert.match(owner.res.html, /sara@example.com/);
    assert.match(owner.res.html, /Registered: 1 \/ 5/);
});

test("register: event full -> 409 and form hidden", async () => {
    const event = await createEvent(ALICE, { title: "Tiny", capacity: "2" });
    for (const n of [1, 2]) {
        const r = await call(registrationController.register, { params: { slug: event.slug }, body: { name: "P" + n, email: `p${n}@x.io` } });
        assert.equal(r.res.statusCode, 201);
    }
    const full = await call(registrationController.register, { params: { slug: event.slug }, body: { name: "P3", email: "p3@x.io" } });
    assert.equal(full.res.statusCode, 409);
    assert.match(full.res.html, /this event is full/i);
    assert.doesNotMatch(full.res.html, /<form action="\/e\//);
});

test("transaction options give room for lock waits", async () => {
    assert.deepEqual(fake.lastTxOptions, { isolationLevel: "ReadCommitted", maxWait: 10000, timeout: 10000 });
});

test("unexpected DB errors propagate (to the 500 handler), deadlocks retry", async () => {
    const event = await createEvent(ALICE, { title: "Flaky", capacity: "3" });
    const original = fake.$transaction;
    let calls = 0;
    fake.$transaction = async (fn, o) => {
        calls++;
        if (calls === 1) { const e = new Error("Deadlock found when trying to get lock; try restarting transaction"); throw e; }
        return original(fn, o);
    };
    const ok = await RegistrationModel.register(event.slug, "Retry", "retry@x.io");
    assert.equal(ok.email, "retry@x.io");
    assert.equal(calls, 2);

    fake.$transaction = async () => { throw new Error("connection lost"); };
    await assert.rejects(() => RegistrationModel.register(event.slug, "X", "x@x.io"), /connection lost/);

    fake.$transaction = async () => { const e = new Error("timeout"); e.code = "P2028"; throw e; };
    await assert.rejects(() => RegistrationModel.register(event.slug, "X", "x@x.io"), (e) => e.code === "BUSY");
    fake.$transaction = original;
});

// ---------------- concurrency ----------------
test("20 concurrent registrations never exceed capacity 5", async () => {
    const event = await createEvent(ALICE, { title: "Race", capacity: "5" });
    const results = await Promise.allSettled(
        Array.from({ length: 20 }, (_, i) => RegistrationModel.register(event.slug, "R" + i, `r${i}@race.test`))
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const full = results.filter((r) => r.status === "rejected" && r.reason.code === "FULL").length;
    assert.equal(ok, 5);
    assert.equal(full, 15);
    assert.equal(fake._db.registrations.filter((r) => r.eventId === event.id).length, 5);
});

test("20 concurrent registrations with the same email -> exactly 1", async () => {
    const event = await createEvent(ALICE, { title: "Dup race", capacity: "50" });
    const results = await Promise.allSettled(
        Array.from({ length: 20 }, () => RegistrationModel.register(event.slug, "Same", "same@race.test"))
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.ok(results.filter((r) => r.status === "rejected").every((r) => r.reason.code === "DUPLICATE"));
});

test("control: WITHOUT the row lock the same race oversells (proves the test can fail)", async () => {
    const event = await createEvent(ALICE, { title: "No lock", capacity: "5" });
    fake._options.useLocks = false;
    try {
        await Promise.allSettled(
            Array.from({ length: 20 }, (_, i) => RegistrationModel.register(event.slug, "N" + i, `n${i}@race.test`))
        );
        const count = fake._db.registrations.filter((r) => r.eventId === event.id).length;
        assert.ok(count > 5, `expected oversell without locks, got ${count}`);

        // and duplicate emails are still caught by the unique index (P2002 -> DUPLICATE, not 500)
        const e2 = await createEvent(ALICE, { title: "No lock dup", capacity: "50" });
        const res = await Promise.allSettled(
            Array.from({ length: 20 }, () => RegistrationModel.register(e2.slug, "S", "s@race.test"))
        );
        assert.equal(res.filter((r) => r.status === "fulfilled").length, 1);
        assert.ok(res.filter((r) => r.status === "rejected").every((r) => r.reason.code === "DUPLICATE"));
    } finally {
        fake._options.useLocks = true;
    }
});

// ---------------- other views ----------------
test("home and error views render for guests and users", async () => {
    const guest = env.makeRes(env.makeReq({}));
    guest.render("home", {});
    assert.match(guest.html, /Log in/);
    const user = env.makeRes(env.makeReq({ user: ALICE }));
    user.render("home", {});
    assert.match(user.html, /Create an event/);
    assert.match(user.html, /My events/);
    const err = env.makeRes(env.makeReq({}));
    err.locals.user = null;
    err.render("error", { status: 500, message: "Something went wrong. Please try again." });
    assert.match(err.html, /<h1>Error<\/h1>/);
    const nf = env.makeRes(env.makeReq({}));
    nf.render("event-new", { error: null, values: {} });
    assert.match(nf.html, /type="datetime-local"/);
    const dash = env.makeRes(env.makeReq({ user: BOB }));
    dash.render("dashboard", { events: [] });
    assert.match(dash.html, /not created any events/);
});
