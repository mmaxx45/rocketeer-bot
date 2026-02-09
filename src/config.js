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
    path: process.env.DATABASE_PATH || './data/rocketeerbot.db',
  },
  web: {
    port: parseInt(process.env.PORT, 10) || 3000,
    sessionSecret: process.env.SESSION_SECRET,
  },
  defaults: {
    crosspostThreshold: 80,
    crosspostWindowHours: 48,
    warningThresholdForBan: 3,
  },
};
