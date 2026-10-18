require('dotenv').config();

const required = ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'SESSION_SECRET'];

for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

module.exports = {
  discord: {
    token: process.env.DISCORD_TOKEN,
    clientId: process.env.DISCORD_CLIENT_ID,
    clientSecret: process.env.DISCORD_CLIENT_SECRET,
    callbackUrl: process.env.DISCORD_CALLBACK_URL || 'http://localhost:3000/auth/discord/callback',
  },
  database: {
    client: process.env.DATABASE_CLIENT || 'sqlite',
    path: process.env.DATABASE_PATH || './data/rocketeerbot.db',
    url: process.env.DATABASE_URL || null,
    host: process.env.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT, 10) || 5432,
    name: process.env.PGDATABASE || 'rocketeerbot',
    user: process.env.PGUSER || 'rocketeerbot',
    password: process.env.PGPASSWORD || null,
    ssl: process.env.DATABASE_SSL === 'true',
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
