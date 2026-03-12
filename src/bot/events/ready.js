const { REST, Routes, ActivityType } = require('discord.js');
const config = require('../../config');
const logger = require('../../logger');
const { db } = require('../../database/db');

async function registerCommands(client) {
  const commands = [...client.commands.values()].map(c => c.data.toJSON());
  const rest = new REST({ version: '10' }).setToken(config.discord.token);
  const devGuildId = process.env.DEV_GUILD_ID;

  if (devGuildId) {
    logger.info(`Dev mode: registering ${commands.length} command(s) to guild ${devGuildId}...`);
    await rest.put(
      Routes.applicationGuildCommands(config.discord.clientId, devGuildId),
      { body: commands }
    );
    logger.info('Guild commands registered.');
  } else {
    logger.info(`Dev mode: registering ${commands.length} command(s) globally...`);
    await rest.put(
      Routes.applicationCommands(config.discord.clientId),
      { body: commands }
    );
    logger.info('Global commands registered (may take up to 1 hour to propagate).');
  }
}

module.exports = {
  name: 'clientReady',
  once: true,
  async execute(client) {
    logger.info(`Bot ready as ${client.user.username}, serving ${client.guilds.cache.size} guild(s)`);

    // Load status message from the bot's first guild
    let statusMessage = 'DM for help!';
    try {
      const guildIds = [...client.guilds.cache.keys()];
      const placeholders = guildIds.map(() => '?').join(',');
      const row = guildIds.length > 0
        ? db.prepare(`SELECT bot_status_message FROM guild_settings WHERE guild_id IN (${placeholders}) AND bot_status_message IS NOT NULL LIMIT 1`).get(...guildIds)
        : null;
      if (row && row.bot_status_message) {
        statusMessage = row.bot_status_message;
      }
    } catch (err) {
      logger.warn(`Failed to load bot status from database: ${err.message}`);
    }

    client.user.setPresence({
      activities: [{ name: statusMessage, type: ActivityType.Custom }],
      status: 'online',
    });

    if (process.env.NODE_ENV !== 'production') {
      try {
        await registerCommands(client);
      } catch (err) {
        logger.error('Failed to register commands on startup:', err);
      }
    }

  },
};
