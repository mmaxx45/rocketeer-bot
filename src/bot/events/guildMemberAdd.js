const { EmbedBuilder } = require('discord.js');
const logger = require('../../logger');

module.exports = {
  name: 'guildMemberAdd',
  once: false,
  async execute(member) {
    const guildId = member.guild.id;

    try {
      const { db } = require('../../database/db');

      // Only send welcome-back for expired temp bans (not manual unbans or appeals)
      const expiredTempBan = db.prepare(
        `SELECT * FROM temp_bans WHERE guild_id = ? AND user_id = ? AND unbanned = 1 ORDER BY unbanned_at DESC LIMIT 1`
      ).get(guildId, member.id);

      if (!expiredTempBan) return;

      // Check if this user was unbanned via appeal (don't send welcome back for appeal unbans)
      const lastAppealAccept = db.prepare(
        `SELECT * FROM ban_appeals WHERE guild_id = ? AND user_id = ? AND status = 'accepted' ORDER BY resolved_at DESC LIMIT 1`
      ).get(guildId, member.id);

      if (lastAppealAccept) return;

      // Send a welcome back message in the system channel
      const systemChannel = member.guild.systemChannel;
      if (systemChannel) {
        const welcomeEmbed = new EmbedBuilder()
          .setTitle('Welcome Back')
          .setDescription(`Welcome back, <@${member.id}>! Your temporary ban has expired.`)
          .setColor(0x2ECC71)
          .setTimestamp();

        await systemChannel.send({ embeds: [welcomeEmbed] });
      }

      logger.info(`Temp-banned user rejoined: user=${member.user.username} guild=${member.guild.name}`);
    } catch (err) {
      logger.warn(`Failed to check returning banned user: ${err.message}`);
    }
  },
};
