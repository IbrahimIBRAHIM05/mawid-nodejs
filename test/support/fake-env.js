// Test environment: fake Prisma (in-memory, with MySQL-like FOR UPDATE row
// locks), stubbed native/unavailable modules, and fake req/res that render
// the real EJS views.
const path = require("path");
const Module = require("module");
const ejs = require("ejs");

const PROJECT = path.resolve(__dirname, "../..");
const VIEWS = path.join(PROJECT, "src/view");

// ---------- stub modules that are not installed here ----------
const stubs = {
    bcrypt: {
        hash: async (pw) => "hash:" + pw,
        compare: async (pw, h) => h === "hash:" + pw
    },
    dotenv: { config: () => ({}) }
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (stubs[request]) return "stub:" + request;
    return origResolve.call(this, request, parent, ...rest);
};
for (const [name, exp] of Object.entries(stubs)) {
    const m = new Module("stub:" + name);
    m.exports = exp;
    m.loaded = true;
    require.cache["stub:" + name] = m;
}

const { createFakePrisma, sleep } = require("./fake-prisma");

// Install a fake prisma as the project's src/prisma.js module.
function installPrisma(fake) {
    const file = path.join(PROJECT, "src/prisma.js");
    const m = new Module(file);
    m.filename = file;
    m.exports = fake;
    m.loaded = true;
    require.cache[file] = m;
}

function freshRequire(rel) {
    const file = require.resolve(path.join(PROJECT, rel));
    return require(file);
}

// ---------- fake req / res ----------
const appLocals = { formatDateTime: null };

function makeReq({ params = {}, body = {}, query = {}, user = null, host = "localhost:3000" } = {}) {
    const session = {
        user,
        regenerated: 0,
        regenerate(cb) { this.regenerated++; this.user = undefined; cb(); },
        save(cb) { cb(); }
    };
    return {
        params, body, query, session,
        protocol: "http",
        get: (h) => (h.toLowerCase() === "host" ? host : undefined)
    };
}

function makeRes(req) {
    const res = {
        statusCode: 200,
        locals: { user: (req && req.session && req.session.user) || null },
        status(code) { this.statusCode = code; return this; },
        redirect(url) { this.statusCode = 302; this.redirectedTo = url; this.done = true; return this; },
        render(view, locals) {
            this.view = view;
            this.viewLocals = locals;
            this.html = ejs.render(
                require("fs").readFileSync(path.join(VIEWS, view + ".ejs"), "utf8"),
                { ...appLocals, ...this.locals, ...locals },
                { filename: path.join(VIEWS, view + ".ejs") }
            );
            this.done = true;
            return this;
        }
    };
    return res;
}

module.exports = {
    PROJECT, VIEWS, createFakePrisma, installPrisma, freshRequire, makeReq, makeRes, appLocals, sleep
};
