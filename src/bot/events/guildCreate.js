const logger = require('../../logger');
const config = require('../../config');

module.exports = {
  name: 'guildCreate',
  async execute(guild) {
    logger.info(`Bot added to guild: ${guild.name} (${guild.id}) — ${guild.memberCount} members`);

    // If allowlist is configured, auto-leave unauthorized guilds
    if (config.allowedGuildIds.length > 0 && !config.allowedGuildIds.includes(guild.id)) {
      logger.warn(`Unauthorized guild ${guild.name} (${guild.id}) — auto-leaving`);

      // Try to notify the guild owner before leaving
      try {
        const owner = await guild.fetchOwner();
        await owner.send(`This bot is private and not authorized to join **${guild.name}**. It has automatically left your server.`);
      } catch {
        // Can't DM owner — that's fine
      }

      try {
        await guild.leave();
        logger.info(`Left unauthorized guild: ${guild.name} (${guild.id})`);
      } catch (err) {
        logger.error(`Failed to leave unauthorized guild ${guild.id}: ${err.message}`);
      }
    }
  },
};
