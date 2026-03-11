const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getSettings } = require('../../database/settings');
const { getLastBanAction } = require('../../database/modactions');
const { getWarnings } = require('../../database/warnings');
const { canViewBanReason } = require('../utils/permissions');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('banreason')
    .setDescription('View why a user was banned and their warning history')
    .addStringOption(opt =>
      opt.setName('user').setDescription('The user ID to look up').setRequired(true)
    ),

  async execute(interaction) {
    const settings = getSettings(interaction.guild.id);

    if (!canViewBanReason(interaction.member, settings)) {
      return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
    }

    const targetId = interaction.options.getString('user').trim();

    if (!/^\d{17,20}$/.test(targetId)) {
      return interaction.reply({ content: 'Please provide a valid user ID (a numeric Discord snowflake).', ephemeral: true });
    }

    const banAction = getLastBanAction(interaction.guild.id, targetId);

    // Try to resolve the user for display
    let targetUser;
    try {
      targetUser = await interaction.client.users.fetch(targetId);
    } catch {
      targetUser = null;
    }

    const displayName = targetUser
      ? (targetUser.tag || targetUser.username)
      : `Unknown User`;
    const userMention = targetUser ? `<@${targetId}>` : `\`${targetId}\``;

    const embed = new EmbedBuilder()
      .setTitle(`Ban Info for ${displayName}`)
      .setColor(0xFF0000)
      .setTimestamp();

    if (targetUser && targetUser.displayAvatarURL) {
      embed.setThumbnail(targetUser.displayAvatarURL());
    }

    // Ban details section
    if (banAction) {
      const banDate = new Date(banAction.created_at + 'Z');
      const timestamp = Math.floor(banDate.getTime() / 1000);

      embed.addFields(
        { name: 'Banned User', value: `${userMention} (${targetId})`, inline: true },
        { name: 'Banned By', value: `<@${banAction.moderator_id}>`, inline: true },
        { name: 'Ban Date', value: `<t:${timestamp}:F>`, inline: true },
        { name: 'Reason', value: banAction.details || 'No reason recorded' },
      );
    } else {
      embed.setDescription(`No ban record found for ${userMention} (${targetId}) in this server's mod actions log.`);
    }

    // Warning history section
    const warnings = getWarnings(interaction.guild.id, targetId);

    if (warnings.length > 0) {
      const lines = warnings.map((w, i) => {
        const date = new Date(w.created_at + 'Z').toLocaleDateString('en-US', {
          year: 'numeric', month: 'short', day: 'numeric',
        });
        const type = w.type === 'crosspost' ? 'Crosspost' : 'Manual';
        return `**${i + 1}.** ${date} | ${type} | By <@${w.moderator_id}> | ${w.reason}`;
      });

      let warningText = lines.join('\n');
      if (warningText.length > 1024) {
        warningText = lines.slice(0, 15).join('\n') + `\n\n*...and ${lines.length - 15} more*`;
      }

      embed.addFields({ name: `Warning History (${warnings.length})`, value: warningText });
    } else {
      embed.addFields({ name: 'Warning History', value: 'No warnings on record.' });
    }

    return interaction.reply({ embeds: [embed], ephemeral: true });
  },
};
