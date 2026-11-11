const session = require("express-session");
const {PrismaSessionStore} = require("@quixo3/prisma-session-store");

const prisma = require("./prisma");

if (!process.env.SESSION_SECRET) {
  console.error("SESSION_SECRET is not set. Add it to your .env file (see .env.example).");
  process.exit(1);
}

const store = new PrismaSessionStore(prisma, {
  checkPeriod: 2 * 60 * 1000, //ms
  dbRecordIdIsSessionId: true,

});

module.exports = session({
    secret: process.env.SESSION_SECRET,
    store:store,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        sameSite:"lax",
        secure: process.env.NODE_ENV === "production",
        maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
    }
});
