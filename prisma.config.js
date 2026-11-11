require('dotenv').config({ quiet: true });

const { getDatabaseUrl } = require('./src/db-url');

// The URL comes from DATABASE_URL or the DB_* variables in .env.
// It is left out when not configured (e.g. `npm install` runs
// `prisma generate` before .env exists; generate does not need it).
const url = getDatabaseUrl();

module.exports = {
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations'
  },
  datasource: url ? { url } : {}
};
