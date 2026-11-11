
require("dotenv").config({ quiet: true });

const { PrismaClient } = require("@prisma/client");
const { PrismaMariaDb } = require("@prisma/adapter-mariadb");
const { getDatabaseUrl } = require("./db-url");

const databaseUrl = getDatabaseUrl();

if (!databaseUrl) {
    console.error(
        "Database is not configured. Set DATABASE_URL, or DB_HOST, DB_USER, DB_NAME " +
        "(and DB_PASSWORD / DB_PORT if needed) in your .env file. See .env.example."
    );
    process.exit(1);
}

const dbUrl = new URL(databaseUrl);

const adapter = new PrismaMariaDb({
    host: dbUrl.hostname,
    port: Number(dbUrl.port || 3306),
    user: decodeURIComponent(dbUrl.username),
    password: decodeURIComponent(dbUrl.password),
    database: decodeURIComponent(dbUrl.pathname.slice(1)),
    // Enough connections for the registration race test (20 concurrent
    // requests) to queue on the row lock instead of on the pool.
    connectionLimit: Number(process.env.DB_POOL_SIZE || 10),
});

const prisma = new PrismaClient({ adapter });

module.exports = prisma;
