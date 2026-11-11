// Minimal HTTP server routing /e/:slug and /e/:slug/register to the REAL
// registration controller (fake in-memory Prisma underneath), so the real
// scripts/race.js can be exercised over HTTP.
const http = require("http");
const env = require("./fake-env");

const fake = env.createFakePrisma({ useLocks: process.env.NO_LOCKS !== "1" });
env.installPrisma(fake);
const helpers = env.freshRequire("src/helpers.js");
env.appLocals.formatDateTime = helpers.formatDateTime;
const controller = env.freshRequire("src/controllers/registration.controller.js");

fake._db.events.push({
    id: 1, organizerId: 1, slug: "race-test-0123456789abcdef", title: "Race test",
    location: null, startsAt: new Date(Date.now() + 86400000), capacity: Number(process.env.CAPACITY || 5),
    createdAt: new Date()
});

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const m = /^\/e\/([^/]+)(\/register)?$/.exec(url.pathname);
    let body = "";
    for await (const chunk of req) body += chunk;
    const fakeReq = env.makeReq({ params: { slug: m ? m[1] : "" }, body: Object.fromEntries(new URLSearchParams(body)) });
    const fakeRes = env.makeRes(fakeReq);
    try {
        if (m && req.method === "GET" && !m[2]) await controller.showEvent(fakeReq, fakeRes);
        else if (m && req.method === "POST" && m[2]) await controller.register(fakeReq, fakeRes);
        else { fakeRes.statusCode = 404; fakeRes.html = "not found"; }
    } catch (err) {
        fakeRes.statusCode = 500; fakeRes.html = "error";
    }
    res.writeHead(fakeRes.statusCode, { "Content-Type": "text/html" });
    res.end(fakeRes.html || "");
});

server.listen(Number(process.env.TEST_PORT || 3999), () => console.log("race test server ready"));
