// In-memory stand-in for the Prisma client, used only by the tests.
// It imitates the parts of MySQL/InnoDB the app relies on: unique indexes
// (P2002 errors) and SELECT ... FOR UPDATE row locks held until the
// transaction ends. It is NOT a substitute for testing against real MySQL;
// use scripts/race.js and scripts/smoke-test.js against your XAMPP database
// for that.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = () => sleep(Math.random() * 4);

function p2002(target) {
    const e = new Error("Unique constraint failed");
    e.code = "P2002";
    e.meta = { target };
    return e;
}

function createFakePrisma(opts = {}) {
    const db = { users: [], events: [], registrations: [], seq: { u: 0, e: 0, r: 0 } };
    const locks = new Map(); // eventId -> promise chain
    const options = { useLocks: true, ...opts };
    const queryLog = [];

    async function acquire(eventId) {
        const prev = locks.get(eventId) || Promise.resolve();
        let release;
        const mine = new Promise((r) => (release = r));
        locks.set(eventId, prev.then(() => mine));
        await prev;
        return release;
    }

    function selectFields(obj, select) {
        if (!select) return { ...obj };
        const out = {};
        for (const k of Object.keys(select)) if (k !== "_count") out[k] = obj[k];
        return out;
    }

    const regCount = (eventId) => db.registrations.filter((r) => r.eventId === eventId).length;

    function makeClient(txState) {
        return {
            user: {
                findUnique: async ({ where }) => db.users.find((u) => u.email === where.email) || null,
                create: async ({ data }) => {
                    if (db.users.some((u) => u.email === data.email)) throw p2002("users_email_key");
                    const u = { id: ++db.seq.u, createdAt: new Date(), ...data };
                    db.users.push(u);
                    return u;
                }
            },
            event: {
                create: async ({ data }) => {
                    if (options.forceSlugCollisions > 0) {
                        options.forceSlugCollisions--;
                        throw p2002("events_slug_key");
                    }
                    if (db.events.some((e) => e.slug === data.slug)) throw p2002("events_slug_key");
                    const e = { id: ++db.seq.e, createdAt: new Date(), ...data };
                    db.events.push(e);
                    return { ...e };
                },
                findFirst: async ({ where, include }) => {
                    const e = db.events.find((x) => x.id === where.id && x.organizerId === where.organizerId);
                    if (!e) return null;
                    const out = { ...e };
                    if (include && include.registrations) {
                        out.registrations = db.registrations
                            .filter((r) => r.eventId === e.id)
                            .map((r) => selectFields(r, include.registrations.select));
                    }
                    return out;
                },
                findMany: async ({ where }) =>
                    db.events
                        .filter((e) => e.organizerId === where.organizerId)
                        .sort((a, b) => a.startsAt - b.startsAt)
                        .map((e) => ({ ...e, _count: { registrations: regCount(e.id) } })),
                findUnique: async ({ where, select }) => {
                    const e = db.events.find((x) => x.slug === where.slug);
                    if (!e) return null;
                    const out = selectFields(e, select);
                    if (select && select._count) out._count = { registrations: regCount(e.id) };
                    // Make sure no organizer/attendee data leaks into the public object.
                    return out;
                }
            },
            registration: {
                findUnique: async ({ where }) => {
                    await jitter();
                    const k = where.eventId_email;
                    const r = db.registrations.find((x) => x.eventId === k.eventId && x.email === k.email);
                    return r ? { id: r.id } : null;
                },
                create: async ({ data }) => {
                    await jitter();
                    if (db.registrations.some((x) => x.eventId === data.eventId && x.email === data.email)) {
                        throw p2002("registrations_event_id_email_key");
                    }
                    const r = { id: ++db.seq.r, createdAt: new Date(), ...data };
                    db.registrations.push(r);
                    return { id: r.id, name: r.name, email: r.email, createdAt: r.createdAt };
                }
            },
            $queryRaw: async (strings, ...values) => {
                const sql = strings.join("?").replace(/\s+/g, " ").trim();
                queryLog.push(sql);
                await jitter();
                if (/FROM events WHERE slug = \? FOR UPDATE/.test(sql)) {
                    const e = db.events.find((x) => x.slug === values[0]);
                    if (!e) return [];
                    if (options.useLocks && txState) {
                        txState.releases.push(await acquire(e.id));
                    }
                    return [{ id: e.id, capacity: e.capacity }];
                }
                if (/SELECT COUNT\(\*\) AS taken FROM registrations WHERE event_id = \?$/.test(sql)) {
                    return [{ taken: BigInt(regCount(values[0])) }];
                }
                if (sql === "SELECT 1") return [{ 1: 1 }];
                throw new Error("Unexpected SQL in fake prisma: " + sql);
            }
        };
    }

    const client = makeClient(null);

    // Session table used by @quixo3/prisma-session-store (model "Session").
    const sessions = new Map();
    const matchSession = (where) => {
        if (!where) return () => true;
        if (where.sid !== undefined) return (s) => s.sid === where.sid;
        if (where.expiresAt && where.expiresAt.lt) return (s) => s.expiresAt < where.expiresAt.lt;
        return () => true;
    };
    client.session = {
        findUnique: async ({ where }) => {
            const s = sessions.get(where.sid);
            return s ? { ...s } : null;
        },
        findMany: async (args = {}) => [...sessions.values()].filter(matchSession(args.where)).map((s) => ({ ...s })),
        create: async ({ data }) => {
            if (sessions.has(data.sid)) throw p2002("sessions_sid_key");
            sessions.set(data.sid, { ...data });
            return { ...data };
        },
        update: async ({ where, data }) => {
            const s = sessions.get(where.sid);
            if (!s) { const e = new Error("Record to update not found"); e.code = "P2025"; throw e; }
            Object.assign(s, data);
            return { ...s };
        },
        delete: async ({ where }) => {
            const s = sessions.get(where.sid);
            if (!s) { const e = new Error("Record to delete does not exist"); e.code = "P2025"; throw e; }
            sessions.delete(where.sid);
            return s;
        },
        deleteMany: async (args = {}) => {
            let count = 0;
            for (const s of [...sessions.values()].filter(matchSession(args.where))) { sessions.delete(s.sid); count++; }
            return { count };
        }
    };
    client.$connect = async () => {};
    client.$disconnect = async () => {};
    client._sessions = sessions;
    client.$transaction = async (fn, txOpts) => {
        client.lastTxOptions = txOpts;
        const state = { releases: [] };
        try {
            return await fn(makeClient(state));
        } finally {
            state.releases.forEach((r) => r());
        }
    };
    client._db = db;
    client._queryLog = queryLog;
    client._options = options;
    return client;
}

module.exports = { createFakePrisma, sleep };
