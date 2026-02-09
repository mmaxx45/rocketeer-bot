const { REST, Routes } = require('discord.js');
const config = require('../../config');
const logger = require('../../logger');
const { cleanupMessageCache } = require('../../database/db');

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
  name: 'ready',
  once: true,
  async execute(client) {
    logger.info(`Bot ready as ${client.user.tag}, serving ${client.guilds.cache.size} guild(s)`);

    client.user.setPresence({ activities: [], status: 'online' });

    if (process.env.NODE_ENV !== 'production') {
      try {
        await registerCommands(client);
      } catch (err) {
        logger.error('Failed to register commands on startup:', err);
      }
    }

    setInterval(() => {
      try {
        const deleted = cleanupMessageCache(48);
        if (deleted > 0) {
          logger.debug(`Cleaned up ${deleted} expired cached messages`);
        }
      } catch (err) {
        logger.error('Message cache cleanup failed:', err);
      }
    }, 30 * 60 * 1000);
  },
};
