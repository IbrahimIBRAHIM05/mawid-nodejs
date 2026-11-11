#!/usr/bin/env node
/*
 * scripts/race.js — fire many registration requests at ONE event at the
 * same moment, to check that the server never goes over capacity and never
 * stores the same email twice.
 *
 * USAGE (the event link is required; there is no built-in default):
 *
 *   node scripts/race.js --url http://localhost:3000/e/<your-event-slug>
 *   node scripts/race.js --base http://localhost:3000 --slug <your-event-slug>
 *   RACE_EVENT_URL=http://localhost:3000/e/<slug> node scripts/race.js
 *   npm run race -- --url http://localhost:3000/e/<slug>
 *
 * Options:
 *   --url <url>        Full public event link (copy it from the organizer's event page).
 *   --base <url>       Server base URL, used with --slug (default http://localhost:3000).
 *   --slug <slug>      Event slug: the part after /e/ in the public link.
 *   --count <n>        Number of simultaneous requests (default 20, max 500).
 *   --mode <mode>      "unique"     each request uses a different email (tests capacity)
 *                      "same-email" every request uses the same email (tests duplicates)
 *                      (default "unique").
 *
 * TEST DATA: every run gets a random run ID, and the requests use
 *   name:  "Race Test 01" ... "Race Test 20"
 *   email: race-<runId>-01@example.test ... (unique mode)
 *          race-<runId>@example.test        (same-email mode)
 * The ".test" domain is reserved and can never be a real mailbox. These rows
 * are real registrations on the event you point the script at, so use a
 * throw-away test event (e.g. capacity 5), not a real one.
 *
 * The script reads the event page before and after the run (the spot
 * counter carries data-capacity / data-registered attributes) and exits
 * with code 1 if any rule was broken.
 */

const crypto = require("crypto");

function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--help" || arg === "-h") {
            args.help = true;
            continue;
        }
        const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
        if (!match) {
            throw new Error(`Unknown argument: ${arg}`);
        }
        const value = match[2] !== undefined ? match[2] : argv[++i];
        if (value === undefined) {
            throw new Error(`Missing value for --${match[1]}`);
        }
        args[match[1]] = value;
    }
    return args;
}

function usage() {
    console.log([
        "Usage:",
        "  node scripts/race.js --url http://localhost:3000/e/<event-slug> [--count 20] [--mode unique|same-email]",
        "  node scripts/race.js --base http://localhost:3000 --slug <event-slug> [--count 20] [--mode unique|same-email]",
        "",
        "Get the event link from the organizer's event page (\"Public link\").",
        "See the comment at the top of scripts/race.js for details and test data."
    ].join("\n"));
}

function resolveEventUrl(args) {
    const raw = args.url || process.env.RACE_EVENT_URL;

    if (raw) {
        const url = new URL(raw);
        if (!/^\/e\/[a-z0-9-]+\/?$/.test(url.pathname)) {
            throw new Error(`--url must look like http://host:port/e/<slug>, got: ${raw}`);
        }
        url.pathname = url.pathname.replace(/\/$/, "");
        url.search = "";
        url.hash = "";
        return url.toString();
    }

    if (args.slug) {
        if (!/^[a-z0-9-]{1,120}$/.test(args.slug)) {
            throw new Error(`--slug may only contain a-z, 0-9 and "-", got: ${args.slug}`);
        }
        const base = (args.base || process.env.RACE_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
        return `${base}/e/${args.slug}`;
    }

    return null;
}

async function readCounters(eventUrl) {
    const res = await fetch(eventUrl, { redirect: "manual" });
    if (res.status === 404) {
        throw new Error(`Event not found at ${eventUrl} (HTTP 404). Check the slug.`);
    }
    if (res.status !== 200) {
        throw new Error(`Could not load ${eventUrl}: HTTP ${res.status}`);
    }
    const html = await res.text();
    const capacity = /data-capacity="(\d+)"/.exec(html);
    const registered = /data-registered="(\d+)"/.exec(html);
    if (!capacity || !registered) {
        throw new Error("The event page did not contain the spot counter (data-capacity / data-registered).");
    }
    return { capacity: Number(capacity[1]), registered: Number(registered[1]) };
}

function classify(status, body) {
    if (status === 201) return "registered";
    if (status === 409 && /already registered/i.test(body)) return "duplicate";
    if (status === 409 && /full/i.test(body)) return "full";
    if (status === 400) return "invalid";
    if (status === 404) return "not found";
    if (status === 503) return "busy";
    return `HTTP ${status}`;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));

    if (args.help) {
        usage();
        return 0;
    }

    const eventUrl = resolveEventUrl(args);
    if (!eventUrl) {
        console.error("No event given. Pass --url or --slug (or set RACE_EVENT_URL).\n");
        usage();
        return 2;
    }

    const count = Number(args.count || 20);
    if (!Number.isInteger(count) || count < 1 || count > 500) {
        throw new Error("--count must be a whole number between 1 and 500.");
    }

    const mode = args.mode || "unique";
    if (mode !== "unique" && mode !== "same-email") {
        throw new Error('--mode must be "unique" or "same-email".');
    }

    const runId = crypto.randomBytes(4).toString("hex");
    const pad = (n) => String(n).padStart(String(count).length < 2 ? 2 : String(count).length, "0");

    console.log(`Event:    ${eventUrl}`);
    console.log(`Requests: ${count} at the same time, mode "${mode}", run ID ${runId}`);

    const before = await readCounters(eventUrl);
    const spotsBefore = Math.max(before.capacity - before.registered, 0);
    console.log(`Before:   ${before.registered} / ${before.capacity} registered (${spotsBefore} spots left)\n`);

    const requests = [];
    for (let i = 1; i <= count; i++) {
        const email = mode === "same-email"
            ? `race-${runId}@example.test`
            : `race-${runId}-${pad(i)}@example.test`;
        requests.push({ name: `Race Test ${pad(i)}`, email });
    }

    // Build every request first, then release them together.
    let release;
    const gate = new Promise((resolve) => { release = resolve; });

    const inFlight = requests.map(async (data) => {
        await gate;
        try {
            const res = await fetch(`${eventUrl}/register`, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams(data).toString(),
                redirect: "manual"
            });
            const body = await res.text();
            return { ...data, status: res.status, outcome: classify(res.status, body) };
        } catch (err) {
            return { ...data, status: 0, outcome: `network error: ${err.message}` };
        }
    });

    const started = Date.now();
    release();
    const results = await Promise.all(inFlight);
    const elapsed = Date.now() - started;

    const tally = {};
    for (const r of results) {
        tally[r.outcome] = (tally[r.outcome] || 0) + 1;
        console.log(`  ${r.name}  ${r.email}  ->  ${r.status} ${r.outcome}`);
    }

    console.log(`\nFinished in ${elapsed} ms. Results:`);
    for (const [outcome, n] of Object.entries(tally)) {
        console.log(`  ${outcome}: ${n}`);
    }

    const after = await readCounters(eventUrl);
    console.log(`\nAfter:    ${after.registered} / ${after.capacity} registered`);

    const successes = tally.registered || 0;
    const expectedMax = mode === "same-email" ? Math.min(1, spotsBefore) : Math.min(count, spotsBefore);
    const problems = [];

    if (after.registered > after.capacity) {
        problems.push(`Registrations (${after.registered}) exceed capacity (${after.capacity}).`);
    }
    if (successes > expectedMax) {
        problems.push(`${successes} requests succeeded, but at most ${expectedMax} should have.`);
    }
    if (after.registered - before.registered !== successes) {
        problems.push(
            `Registration count went from ${before.registered} to ${after.registered}, ` +
            `but ${successes} requests reported success (other traffic on this event can also cause this).`
        );
    }
    const unexpected = results.filter((r) => !["registered", "full", "duplicate"].includes(r.outcome));
    if (unexpected.length > 0) {
        problems.push(`${unexpected.length} request(s) got an unexpected response (see list above).`);
    }

    if (successes < expectedMax) {
        console.log(`\nNote: ${successes} succeeded although ${expectedMax} spot(s) were available.`);
    }

    if (problems.length > 0) {
        console.log("\nFAILED:");
        problems.forEach((p) => console.log(`  - ${p}`));
        return 1;
    }

    console.log(`\nPASSED: ${successes} registered (max allowed ${expectedMax}), capacity and duplicate rules held.`);
    return 0;
}

main()
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
        console.error(`Error: ${err.message}`);
        process.exitCode = 2;
    });
