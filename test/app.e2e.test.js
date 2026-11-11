// End-to-end tests of the REAL application stack (src/index.js, Express,
// express-session + Prisma session store, Helmet, EJS, real bcrypt) over
// HTTP. Only the database is replaced by the in-memory fake
// (test/support/fake-prisma.js), so this needs no MySQL.
// For the same checks against your real XAMPP database, run:
//   npm start            (terminal 1)
//   npm run smoke        (terminal 2)
const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const SERVER = path.join(__dirname, "support/app-server.js");

// Run in a temp folder so a developer's real .env is never loaded.
function cleanEnv(extra) {
    const env = { ...process.env };
    for (const k of ["DATABASE_URL", "DB_HOST", "DB_PORT", "DB_USER", "DB_PASSWORD", "DB_NAME", "SESSION_SECRET", "APP_URL"]) delete env[k];
    return { ...env, ...extra };
}

function startApp(port, extraEnv = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [SERVER], {
            cwd: os.tmpdir(),
            env: cleanEnv({ PORT: String(port), ...extraEnv }),
            stdio: ["ignore", "pipe", "pipe"]
        });
        let out = "";
        child.stdout.on("data", (d) => { out += d; if (out.includes("Mawid is running")) resolve(child); });
        child.stderr.on("data", (d) => { out += d; });
        child.on("exit", (code) => reject(new Error(`app exited early (${code}):\n${out}`)));
    });
}

function runOnce(extraEnv) {
    return spawnSync(process.execPath, [SERVER], {
        cwd: os.tmpdir(), env: cleanEnv({ PORT: "0", ...extraEnv }), encoding: "utf8", timeout: 15000
    });
}

test("full smoke test (all workflows + race.js) passes against the real app", async () => {
    const port = 6100 + Math.floor(Math.random() * 800);
    const app = await startApp(port);
    try {
        const r = spawnSync(process.execPath, [path.join(ROOT, "scripts/smoke-test.js"), "--base", `http://localhost:${port}`], { encoding: "utf8", timeout: 60000 });
        assert.equal(r.status, 0, r.stdout + r.stderr);
        assert.match(r.stdout, /ALL CHECKS PASSED/);
        assert.match(r.stdout, /registered: 5\b/);
        assert.match(r.stdout, /registered: 1\b/);
    } finally {
        app.kill();
    }
});

test("security headers, cookie flags, session rotation on login, 413 page", async () => {
    const port = 7000 + Math.floor(Math.random() * 800);
    const app = await startApp(port);
    const base = `http://localhost:${port}`;
    const form = (o) => ({ method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o), redirect: "manual" });
    try {
        const home = await fetch(base + "/");
        assert.ok(home.headers.get("content-security-policy"));
        assert.equal(home.headers.get("x-powered-by"), null);

        const email = `rot-${Date.now()}@example.test`;
        const signup = await fetch(base + "/signup", form({ name: "Rot", email, password: "password123" }));
        const cookie1 = signup.headers.getSetCookie()[0];
        assert.match(cookie1, /HttpOnly/);
        assert.match(cookie1, /SameSite=Lax/);
        const sid1 = cookie1.split(";")[0];

        const login = await fetch(base + "/login", { ...form({ email, password: "password123" }), headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: sid1 } });
        const sid2 = login.headers.getSetCookie()[0].split(";")[0];
        assert.notEqual(sid2, sid1, "session id must change on login");
        const stale = await fetch(base + "/dashboard", { headers: { Cookie: sid1 }, redirect: "manual" });
        assert.equal(stale.status, 302, "old session id must no longer be logged in");

        const big = await fetch(base + "/e/x/register", { ...form({}), body: "name=" + "a".repeat(30000) });
        assert.equal(big.status, 413);
        assert.match(await big.text(), /too large/);
    } finally {
        app.kill();
    }
});

test("unexpected database error -> generic 500 page, no stack trace or SQL leaked", async () => {
    const port = 7900 + Math.floor(Math.random() * 500);
    const app = await startApp(port, { MAWID_TEST_BREAK_EVENTS: "1" });
    try {
        const r = await fetch(`http://localhost:${port}/e/some-event-0123456789abcdef`);
        const html = await r.text();
        assert.equal(r.status, 500);
        assert.match(html, /Something went wrong/);
        assert.doesNotMatch(html, /at .*\.js:\d+|SELECT|simulated database failure/i);
    } finally {
        app.kill();
    }
});

test("startup: DB_* variables are used when DATABASE_URL is not set", () => {
    const r = runOnce({ MAWID_TEST_PRINT_ADAPTER: "1", MAWID_TEST_EXIT_AFTER_START: "1",
        DB_HOST: "127.0.0.1", DB_PORT: "3307", DB_USER: "root", DB_PASSWORD: "p@ss:w/rd", DB_NAME: "mawid" });
    const line = (r.stdout.match(/ADAPTER (.*)/) || [])[1];
    assert.ok(line, r.stdout + r.stderr);
    const cfg = JSON.parse(line);
    assert.equal(cfg.host, "127.0.0.1");
    assert.equal(cfg.port, 3307);
    assert.equal(cfg.user, "root");
    assert.equal(cfg.database, "mawid");
    assert.equal(cfg.password, "<set:9>");
});

test("startup: DATABASE_URL is used and wins over DB_*", () => {
    const r = runOnce({ MAWID_TEST_PRINT_ADAPTER: "1", MAWID_TEST_EXIT_AFTER_START: "1",
        DATABASE_URL: "mysql://appuser:secret@dbhost:3308/mawid_url", DB_HOST: "ignored", DB_USER: "ignored", DB_NAME: "ignored" });
    const cfg = JSON.parse(r.stdout.match(/ADAPTER (.*)/)[1]);
    assert.deepEqual([cfg.host, cfg.port, cfg.user, cfg.database], ["dbhost", 3308, "appuser", "mawid_url"]);
});

test("startup: XAMPP default (root, empty password) works", () => {
    const r = runOnce({ MAWID_TEST_PRINT_ADAPTER: "1", MAWID_TEST_EXIT_AFTER_START: "1",
        DB_HOST: "localhost", DB_USER: "root", DB_PASSWORD: "", DB_NAME: "mawid" });
    const cfg = JSON.parse(r.stdout.match(/ADAPTER (.*)/)[1]);
    assert.deepEqual([cfg.host, cfg.port, cfg.user, cfg.password, cfg.database], ["localhost", 3306, "root", "", "mawid"]);
});

test("startup: missing database settings -> clear message, exit 1", () => {
    const r = runOnce({ DATABASE_URL: "" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Database is not configured/);
});

test("startup: missing SESSION_SECRET -> clear message, exit 1", () => {
    const r = runOnce({ SESSION_SECRET: "" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /SESSION_SECRET is not set/);
});
