// Builds the MySQL connection URL used by both the app (src/prisma.js)
// and the Prisma CLI (prisma.config.js).
//
// Priority:
//   1. DATABASE_URL, if set (e.g. mysql://root:@localhost:3306/mawid)
//   2. Otherwise it is assembled from DB_HOST, DB_PORT, DB_USER,
//      DB_PASSWORD and DB_NAME (the variables listed in .env.example).
//
// Returns undefined when neither form is configured so callers can show
// a clear error instead of crashing on `new URL(undefined)`.

function getDatabaseUrl() {
    if (process.env.DATABASE_URL && process.env.DATABASE_URL.trim()) {
        return process.env.DATABASE_URL.trim();
    }

    const host = process.env.DB_HOST;
    const name = process.env.DB_NAME;
    const user = process.env.DB_USER;

    if (!host || !name || !user) {
        return undefined;
    }

    const port = process.env.DB_PORT || "3306";
    const password = process.env.DB_PASSWORD || "";
    const auth = password
        ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}`
        : encodeURIComponent(user);

    return `mysql://${auth}@${host}:${port}/${encodeURIComponent(name)}`;
}

module.exports = { getDatabaseUrl };
