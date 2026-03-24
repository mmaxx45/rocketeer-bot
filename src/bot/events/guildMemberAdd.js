const { EmbedBuilder } = require('discord.js');
const { getSettings } = require('../../database/settings');
const logger = require('../../logger');

module.exports = {
  name: 'guildMemberAdd',
  once: false,
  async execute(member) {
    const guildId = member.guild.id;
    const settings = getSettings(guildId);

    // Check if this user had a previous ban (temp ban that expired)
    // Discord automatically removes temp bans, so if they're joining and were
    // previously banned, it means the ban expired or was lifted
    try {
      const { db } = require('../../database/db');
      const lastBan = db.prepare(
        `SELECT * FROM mod_actions WHERE guild_id = ? AND target_id = ? AND action_type = 'ban' ORDER BY created_at DESC LIMIT 1`
      ).get(guildId, member.id);

      if (!lastBan) return;

      // Check if this user was unbanned via appeal (don't send welcome back for appeal unbans)
      const lastAppealAccept = db.prepare(
        `SELECT * FROM ban_appeals WHERE guild_id = ? AND user_id = ? AND status = 'accepted' ORDER BY resolved_at DESC LIMIT 1`
      ).get(guildId, member.id);

      if (lastAppealAccept) {
        // Already handled by the appeal acceptance flow
        return;
      }

      // Send a welcome back message in the system channel
      const systemChannel = member.guild.systemChannel;
      if (systemChannel) {
        const welcomeEmbed = new EmbedBuilder()
          .setTitle('Welcome Back')
          .setDescription(`Welcome back, <@${member.id}>! Your ban has expired and you have rejoined the server.`)
          .setColor(0x2ECC71)
          .setTimestamp();

        await systemChannel.send({ embeds: [welcomeEmbed] });
      }

      logger.info(`Previously banned user rejoined: user=${member.user.username} guild=${member.guild.name}`);
    } catch (err) {
      logger.warn(`Failed to check returning banned user: ${err.message}`);
    }
  },
};
