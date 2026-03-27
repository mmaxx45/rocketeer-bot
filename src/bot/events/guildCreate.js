const logger = require('../../logger');

// Populated on first bot ready — all guilds present at startup are allowed
const allowedGuilds = new Set();

module.exports = {
  name: 'guildCreate',
  allowedGuilds, // exposed so ready.js can populate it
  async execute(guild) {
    logger.info(`Bot added to guild: ${guild.name} (${guild.id}) — ${guild.memberCount} members`);

    // If allowlist is populated (bot has started) and this guild isn't on it, auto-leave
    if (allowedGuilds.size > 0 && !allowedGuilds.has(guild.id)) {
      logger.warn(`Unauthorized guild ${guild.name} (${guild.id}) — auto-leaving`);

      try {
        const owner = await guild.fetchOwner();
        await owner.send(`This bot is private and not authorized to join **${guild.name}**. It has automatically left your server.`);
      } catch {
        // Can't DM owner
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
