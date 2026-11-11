#!/usr/bin/env node
/*
 * scripts/smoke-test.js — end-to-end check of a RUNNING Mawid server
 * (normally your local XAMPP setup), over real HTTP, against the real
 * database. Nothing is mocked.
 *
 * USAGE (start the app first with `npm start` in another terminal):
 *
 *   npm run smoke
 *   npm run smoke -- --base http://localhost:3000
 *   node scripts/smoke-test.js --base http://localhost:3000 --skip-race
 *
 * What it checks, in order:
 *   pages & auth guards · signup (validation, duplicate email) · login /
 *   logout · session persistence · event creation (validation, public link)
 *   · public page without login · registration (validation, duplicate email,
 *   capacity) · organizer-only attendee list · ownership (another organizer
 *   gets 404) · then scripts/race.js: 20 simultaneous registrations on a
 *   capacity-5 event (exactly 5 must succeed) and 20 with the same email
 *   (exactly 1 must succeed).
 *
 * TEST DATA it creates in your database (it never deletes anything):
 *   users   "Smoke A <run>" / "Smoke B <run>", emails smoke-<run>-a@example.test
 *   events  "Smoke <run> …" (capacity 3, 5 and 50), registrations with
 *           @example.test emails. <run> is random for each run.
 * The ".test" domain is reserved and can never be a real address.
 *
 * Exit code: 0 = every check passed, 1 = at least one failed, 2 = could not run.
 */

const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--skip-race") { args.skipRace = true; continue; }
        if (a === "--help" || a === "-h") { args.help = true; continue; }
        const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
        if (!m) throw new Error(`Unknown argument: ${a}`);
        args[m[1]] = m[2] !== undefined ? m[2] : argv[++i];
    }
    return args;
}

// Minimal browser-like client: keeps its own cookies, never follows redirects.
function createClient(base) {
    const jar = new Map();
    return {
        jar,
        async request(method, urlPath, form) {
            const headers = {};
            if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
            let body;
            if (form) {
                headers["Content-Type"] = "application/x-www-form-urlencoded";
                body = new URLSearchParams(form).toString();
            }
            const res = await fetch(base + urlPath, { method, headers, body, redirect: "manual" });
            const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
            for (const c of setCookies) {
                const [pair, ...attrs] = c.split(";");
                const idx = pair.indexOf("=");
                const name = pair.slice(0, idx).trim();
                const value = pair.slice(idx + 1).trim();
                const expired = attrs.some((x) => /expires=thu, 01 jan 1970/i.test(x.trim()));
                if (expired || value === "") jar.delete(name); else jar.set(name, value);
            }
            return { status: res.status, location: res.headers.get("location"), html: await res.text() };
        },
        get(p) { return this.request("GET", p); },
        post(p, form) { return this.request("POST", p, form || {}); }
    };
}

function futureLocal(days) {
    const d = new Date(Date.now() + days * 86400000);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T19:00`;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        console.log("Usage: node scripts/smoke-test.js [--base http://localhost:3000] [--skip-race]");
        return 0;
    }
    const base = (args.base || process.env.SMOKE_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
    const run = crypto.randomBytes(3).toString("hex");
    const results = [];

    async function check(name, fn) {
        try {
            await fn();
            results.push({ name, ok: true });
            console.log(`  PASS  ${name}`);
        } catch (err) {
            results.push({ name, ok: false, err: err.message });
            console.log(`  FAIL  ${name}\n        ${err.message}`);
        }
    }
    function expect(cond, msg) { if (!cond) throw new Error(msg); }
    function expectStatus(res, status, what) {
        expect(res.status === status, `${what}: expected HTTP ${status}, got ${res.status}${res.location ? " -> " + res.location : ""}`);
    }

    console.log(`Mawid smoke test against ${base} (run ${run})\n`);

    const guest = createClient(base);
    try {
        await guest.get("/");
    } catch (err) {
        console.error(`Cannot reach ${base}: ${err.message}\nStart the app first (npm start) and check the URL/port.`);
        return 2;
    }

    const A = createClient(base);
    const B = createClient(base);
    const emailA = `smoke-${run}-a@example.test`;
    const emailB = `smoke-${run}-b@example.test`;
    const password = `Pw-${run}-secret`;
    let eventId = null;
    let slug = null;

    console.log("Pages and guards");
    await check("home page loads", async () => expectStatus(await guest.get("/"), 200, "GET /"));
    await check("guest is redirected from /dashboard to /login", async () => {
        const r = await guest.get("/dashboard");
        expectStatus(r, 302, "GET /dashboard");
        expect(r.location === "/login", `redirected to ${r.location}`);
    });
    await check("guest is redirected from /events/new", async () => expectStatus(await guest.get("/events/new"), 302, "GET /events/new"));
    await check("unknown page returns 404 page", async () => expectStatus(await guest.get(`/no-such-page-${run}`), 404, "GET unknown"));

    console.log("\nSignup / login / logout / session");
    await check("signup rejects missing fields (400)", async () => expectStatus(await A.post("/signup", { name: "", email: emailA, password }), 400, "signup"));
    await check("signup rejects short password (400)", async () => expectStatus(await A.post("/signup", { name: "x", email: emailA, password: "short" }), 400, "signup"));
    await check("signup organizer A", async () => {
        const r = await A.post("/signup", { name: `Smoke A ${run}`, email: emailA, password });
        expectStatus(r, 302, "signup A");
        expect(A.jar.size > 0, "no session cookie was set");
    });
    await check("session persists: home greets A, dashboard opens", async () => {
        const home = await A.get("/");
        expect(home.html.includes(`Smoke A ${run}`), "home page does not greet the logged-in user");
        expectStatus(await A.get("/dashboard"), 200, "GET /dashboard");
    });
    await check("signup with an existing email is rejected (400)", async () => {
        const other = createClient(base);
        const r = await other.post("/signup", { name: "Dup", email: emailA.toUpperCase(), password });
        expectStatus(r, 400, "duplicate signup");
        expect(/already taken/i.test(r.html), "no 'already taken' message");
    });
    await check("logout ends the session", async () => {
        expectStatus(await A.post("/logout"), 302, "POST /logout");
        const r = await A.get("/dashboard");
        expect(r.status === 302 && r.location === "/login", `after logout /dashboard gave ${r.status}`);
    });
    await check("login with wrong password is rejected (401)", async () => expectStatus(await A.post("/login", { email: emailA, password: "wrong-password" }), 401, "login"));
    await check("login with correct password works", async () => {
        expectStatus(await A.post("/login", { email: emailA, password }), 302, "login");
        expectStatus(await A.get("/dashboard"), 200, "GET /dashboard after login");
    });
    await check("page HTML never contains password hashes", async () => {
        const r = await A.get("/dashboard");
        expect(!/\$2[aby]\$\d\d\$/.test(r.html) && !/password_?hash/i.test(r.html), "hash-like data found in page");
    });

    console.log("\nEvent creation");
    await check("rejects past start date (400)", async () => expectStatus(await A.post("/events", { title: "x", startsAt: "2020-01-01T10:00", capacity: "3" }), 400, "create"));
    await check("rejects capacity 0 (400)", async () => expectStatus(await A.post("/events", { title: "x", startsAt: futureLocal(7), capacity: "0" }), 400, "create"));
    await check("rejects missing title (400)", async () => expectStatus(await A.post("/events", { title: "", startsAt: futureLocal(7), capacity: "3" }), 400, "create"));
    await check("creates event (capacity 3) and shows the public link", async () => {
        const r = await A.post("/events", { title: `Smoke ${run} dinner`, location: "Test Hall", startsAt: futureLocal(7), capacity: "3" });
        expectStatus(r, 302, "create event");
        const m = /^\/events\/(\d+)\?created=1$/.exec(r.location || "");
        expect(m, `unexpected redirect ${r.location}`);
        eventId = m[1];
        const page = await A.get(`/events/${eventId}?created=1`);
        expectStatus(page, 200, "organizer event page");
        const link = /value="(https?:\/\/[^"]+\/e\/([a-z0-9-]+))"/.exec(page.html);
        expect(link, "public link not found on the page");
        slug = link[2];
        expect(/-[0-9a-f]{16}$/.test(slug), `slug does not look random: ${slug}`);
    });

    console.log("\nPublic page and registration (no login)");
    await check("public page opens without login and shows 3 spots", async () => {
        const r = await guest.get(`/e/${slug}`);
        expectStatus(r, 200, "public page");
        expect(/3 of 3 spots left/.test(r.html), "spot counter missing");
        expect(!r.html.includes(emailA), "organizer email leaked on public page");
    });
    await check("unknown slug returns 404", async () => expectStatus(await guest.get(`/e/does-not-exist-${run}`), 404, "unknown slug"));
    await check("invalid email is rejected (400)", async () => expectStatus(await guest.post(`/e/${slug}/register`, { name: "Bad", email: "not-an-email" }), 400, "register"));
    await check("missing name is rejected (400)", async () => expectStatus(await guest.post(`/e/${slug}/register`, { name: "", email: `p1-${run}@example.test` }), 400, "register"));
    await check("registration succeeds (201)", async () => expectStatus(await guest.post(`/e/${slug}/register`, { name: "Person One", email: `p1-${run}@example.test` }), 201, "register"));
    await check("same email again (different case) is rejected (409)", async () => {
        const r = await guest.post(`/e/${slug}/register`, { name: "Person One", email: `P1-${run}@Example.test` });
        expectStatus(r, 409, "duplicate");
        expect(/already registered/i.test(r.html), "no 'already registered' message");
    });
    await check("fills the remaining 2 spots (201, 201)", async () => {
        expectStatus(await guest.post(`/e/${slug}/register`, { name: "Person Two", email: `p2-${run}@example.test` }), 201, "register 2");
        expectStatus(await guest.post(`/e/${slug}/register`, { name: "Person Three", email: `p3-${run}@example.test` }), 201, "register 3");
    });
    await check("4th registration is rejected: event full (409)", async () => {
        const r = await guest.post(`/e/${slug}/register`, { name: "Person Four", email: `p4-${run}@example.test` });
        expectStatus(r, 409, "over capacity");
        expect(/full/i.test(r.html), "no 'full' message");
    });

    console.log("\nAttendee list and ownership");
    await check("organizer sees all 3 attendees", async () => {
        const r = await A.get(`/events/${eventId}`);
        expectStatus(r, 200, "attendee page");
        for (const n of [1, 2, 3]) expect(r.html.includes(`p${n}-${run}@example.test`), `attendee p${n} missing`);
        expect(!r.html.includes(`p4-${run}@example.test`), "rejected attendee is listed");
        expect(/Registered: 3 \/ 3/.test(r.html), "count is not 3 / 3");
    });
    await check("guest cannot open the attendee page (redirect to login)", async () => {
        const r = await guest.get(`/events/${eventId}`);
        expect(r.status === 302 && r.location === "/login", `guest got ${r.status}`);
    });
    await check("another organizer gets 404 for A's event", async () => {
        expectStatus(await B.post("/signup", { name: `Smoke B ${run}`, email: emailB, password }), 302, "signup B");
        const r = await B.get(`/events/${eventId}`);
        expectStatus(r, 404, "B opening A's event");
        expect(!r.html.includes(`p1-${run}@example.test`), "attendee email leaked to another organizer");
        const dash = await B.get("/dashboard");
        expect(!dash.html.includes(`Smoke ${run} dinner`), "A's event shows on B's dashboard");
    });
    await check("public page never lists attendee emails", async () => {
        const r = await guest.get(`/e/${slug}`);
        expect(!r.html.includes(`p1-${run}@example.test`), "attendee email on public page");
    });

    if (!args.skipRace) {
        console.log("\nConcurrency (scripts/race.js)");
        const raceScript = path.join(__dirname, "race.js");
        const runRace = (eventSlug, mode) => spawnSync(process.execPath,
            [raceScript, "--url", `${base}/e/${eventSlug}`, "--mode", mode, "--count", "20"], { encoding: "utf8" });

        async function createRaceEvent(title, capacity) {
            const r = await A.post("/events", { title, startsAt: futureLocal(14), capacity: String(capacity) });
            expectStatus(r, 302, `create ${title}`);
            const id = /^\/events\/(\d+)/.exec(r.location)[1];
            const page = await A.get(`/events/${id}`);
            return { id, slug: /\/e\/([a-z0-9-]+)"/.exec(page.html)[1] };
        }

        await check("20 simultaneous registrations, capacity 5 -> exactly 5 succeed", async () => {
            const ev = await createRaceEvent(`Smoke ${run} race capacity`, 5);
            const out = runRace(ev.slug, "unique");
            process.stdout.write(out.stdout.split("\n").filter((l) => /Results|registered:|full:|duplicate:|busy|After|PASSED|FAILED|  - /.test(l)).map((l) => "        " + l).join("\n") + "\n");
            expect(out.status === 0, `race.js exited with ${out.status}: ${out.stderr || ""}`);
            expect(/registered: 5\b/.test(out.stdout), "registered count is not 5");
            const page = await A.get(`/events/${ev.id}`);
            expect(/Registered: 5 \/ 5/.test(page.html), "organizer page does not show 5 / 5");
        });
        await check("20 simultaneous registrations, same email -> exactly 1 succeeds", async () => {
            const ev = await createRaceEvent(`Smoke ${run} race same email`, 50);
            const out = runRace(ev.slug, "same-email");
            process.stdout.write(out.stdout.split("\n").filter((l) => /Results|registered:|full:|duplicate:|busy|After|PASSED|FAILED|  - /.test(l)).map((l) => "        " + l).join("\n") + "\n");
            expect(out.status === 0, `race.js exited with ${out.status}: ${out.stderr || ""}`);
            expect(/registered: 1\b/.test(out.stdout), "registered count is not 1");
        });
    }

    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length} passed, ${failed.length} failed.`);
    if (failed.length) {
        failed.forEach((f) => console.log(`  - ${f.name}: ${f.err}`));
        return 1;
    }
    console.log("ALL CHECKS PASSED.");
    return 0;
}

main()
    .then((code) => { process.exitCode = code; })
    .catch((err) => { console.error(`Error: ${err.stack || err.message}`); process.exitCode = 2; });
