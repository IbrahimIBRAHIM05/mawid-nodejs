// Starts the REAL application (src/index.js -> src/app.js with real Express,
// express-session, the Prisma session store, Helmet and EJS) with the
// in-memory fake Prisma client in place of @prisma/client. Used by
// test/app.e2e.test.js. Not used in normal operation.
const Module = require("module");
const path = require("path");
const { createFakePrisma } = require("./fake-prisma");

globalThis.__fakePrisma = createFakePrisma({ useLocks: process.env.NO_LOCKS !== "1" });

// Test switch: make public event lookups fail like a lost DB connection.
if (process.env.MAWID_TEST_BREAK_EVENTS === "1") {
    globalThis.__fakePrisma.event.findUnique = async () => {
        throw new Error("simulated database failure: SELECT * FROM events");
    };
}

// Test switch: exit as soon as the server reports it is listening.
if (process.env.MAWID_TEST_EXIT_AFTER_START === "1") {
    const log = console.log;
    console.log = (...args) => {
        log(...args);
        if (String(args[0]).startsWith("Mawid is running")) process.exit(0);
    };
}

const fakeModules = {
    "@prisma/client": {
        PrismaClient: class {
            constructor(opts) { globalThis.__prismaOptions = opts; return globalThis.__fakePrisma; }
        }
    },
    "@prisma/adapter-mariadb": {
        PrismaMariaDb: class { constructor(cfg) { this.config = cfg; globalThis.__adapterConfig = cfg; } }
    }
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    if (fakeModules[request]) return "fake:" + request;
    return origResolve.call(this, request, ...rest);
};
for (const [name, exp] of Object.entries(fakeModules)) {
    const m = new Module("fake:" + name);
    m.exports = exp;
    m.loaded = true;
    require.cache["fake:" + name] = m;
}

// Defaults only when the caller did not set them at all (an explicit empty
// value is kept, so startup error handling can be tested).
if (process.env.DATABASE_URL === undefined && process.env.DB_HOST === undefined) {
    process.env.DATABASE_URL = "mysql://root:@localhost:3306/mawid_test";
}
if (process.env.SESSION_SECRET === undefined) {
    process.env.SESSION_SECRET = "test-only-secret";
}

if (process.env.MAWID_TEST_PRINT_ADAPTER === "1") {
    process.on("exit", () => {
        const cfg = globalThis.__adapterConfig || {};
        console.log("ADAPTER " + JSON.stringify({ ...cfg, password: cfg.password ? "<set:" + cfg.password.length + ">" : "" }));
    });
}

require(path.resolve(__dirname, "../../src/index.js"));
