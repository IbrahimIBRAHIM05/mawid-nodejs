// Runs the real scripts/race.js over HTTP against a small test server that
// uses the real registration controller with the in-memory fake database.
// No MySQL needed. Run: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const SLUG_URL = (port) => `http://localhost:${port}/e/race-test-0123456789abcdef`;

function startServer(port, extraEnv) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(__dirname, "support/race-server.js")], {
            env: { ...process.env, TEST_PORT: String(port), ...extraEnv },
            stdio: ["ignore", "pipe", "inherit"]
        });
        child.stdout.on("data", (d) => { if (String(d).includes("ready")) resolve(child); });
        child.on("exit", (code) => reject(new Error(`test server exited early (${code})`)));
    });
}

function runRace(args) {
    return spawnSync(process.execPath, [path.join(ROOT, "scripts/race.js"), ...args], { encoding: "utf8" });
}

test("race.js refuses to run without an event", () => {
    const r = runRace([]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /No event given/);
});

test("race.js: 20 concurrent requests, capacity 5 -> PASSED, exactly 5 registered", async () => {
    const port = 4100 + Math.floor(Math.random() * 500);
    const server = await startServer(port, { CAPACITY: "5" });
    try {
        const r = runRace(["--url", SLUG_URL(port)]);
        assert.equal(r.status, 0, r.stdout);
        assert.match(r.stdout, /registered: 5/);
        assert.match(r.stdout, /full: 15/);
        assert.match(r.stdout, /After: +5 \/ 5 registered/);

        const dup = runRace(["--url", SLUG_URL(port), "--mode", "same-email"]);
        assert.equal(dup.status, 0, dup.stdout);
    } finally {
        server.kill();
    }
});

test("race.js: same email x20 -> exactly 1 registered", async () => {
    const port = 4700 + Math.floor(Math.random() * 500);
    const server = await startServer(port, { CAPACITY: "50" });
    try {
        const r = runRace(["--url", SLUG_URL(port), "--mode", "same-email"]);
        assert.equal(r.status, 0, r.stdout);
        assert.match(r.stdout, /registered: 1/);
        assert.match(r.stdout, /duplicate: 19/);
    } finally {
        server.kill();
    }
});

test("race.js detects overselling when the row lock is disabled (control)", async () => {
    const port = 5300 + Math.floor(Math.random() * 500);
    const server = await startServer(port, { CAPACITY: "5", NO_LOCKS: "1" });
    try {
        const r = runRace(["--url", SLUG_URL(port)]);
        assert.equal(r.status, 1, r.stdout);
        assert.match(r.stdout, /FAILED/);
    } finally {
        server.kill();
    }
});
