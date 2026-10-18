require('dotenv').config();

const required = ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'SESSION_SECRET'];

for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

// The value shipped in .env.example is public: anyone could forge a dashboard
// session with it.
if (process.env.SESSION_SECRET === 'random_session_secret' || process.env.SESSION_SECRET.length < 16) {
  throw new Error('SESSION_SECRET is the example value or shorter than 16 characters; set a long random string (e.g. `openssl rand -hex 32`)');
}

const DATABASE_CLIENTS = { sqlite: 'sqlite', postgres: 'postgres', postgresql: 'postgres', pg: 'postgres' };
const databaseClient = DATABASE_CLIENTS[String(process.env.DATABASE_CLIENT || 'sqlite').trim().toLowerCase()];
if (!databaseClient) {
  // Falling back to SQLite here would silently start the bot on an empty database.
  throw new Error(`DATABASE_CLIENT must be sqlite or postgres, got "${process.env.DATABASE_CLIENT}"`);
}

// DATABASE_SSL: unset/false = no TLS, true = TLS with certificate verification,
// no-verify = TLS without verification (some managed hosts use self-signed certs).
const DATABASE_SSL_MODES = { '': false, false: false, true: 'verify', 'no-verify': 'no-verify' };
const databaseSsl = DATABASE_SSL_MODES[String(process.env.DATABASE_SSL || '').trim().toLowerCase()];
if (databaseSsl === undefined) {
  throw new Error(`DATABASE_SSL must be true, false or no-verify, got "${process.env.DATABASE_SSL}"`);
}

module.exports = {
  discord: {
    token: process.env.DISCORD_TOKEN,
    clientId: process.env.DISCORD_CLIENT_ID,
    clientSecret: process.env.DISCORD_CLIENT_SECRET,
    callbackUrl: process.env.DISCORD_CALLBACK_URL || 'http://localhost:3000/auth/discord/callback',
  },
  database: {
    client: databaseClient,
    path: process.env.DATABASE_PATH || './data/rocketeerbot.db',
    url: process.env.DATABASE_URL || null,
    host: process.env.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT, 10) || 5432,
    name: process.env.PGDATABASE || 'rocketeerbot',
    user: process.env.PGUSER || 'rocketeerbot',
    password: process.env.PGPASSWORD || null,
    ssl: databaseSsl,
    poolSize: parseInt(process.env.DATABASE_POOL_SIZE, 10) || 10,
  },
  web: {
    port: parseInt(process.env.PORT, 10) || 3000,
    sessionSecret: process.env.SESSION_SECRET,
    dashboardUrl: process.env.DASHBOARD_URL || 'http://localhost:3000',
  },
  defaults: {
    crosspostThreshold: 80,
    crosspostWindowHours: 48,
    warningThresholdForBan: 3,
  },
};
