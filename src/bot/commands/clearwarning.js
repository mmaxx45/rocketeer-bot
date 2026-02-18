const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const { getWarnings, deleteWarning, clearUserWarnings } = require('../../database/warnings');
const { getSettings } = require('../../database/settings');
const { isModerator } = require('../utils/permissions');
const logger = require('../../logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('clearwarning')
    .setDescription('Remove a warning from a user (still logged). Use "all" to clear all warnings.')
    .addUserOption(opt =>
      opt.setName('user').setDescription('The user to remove a warning from').setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('number').setDescription('Warning number as shown in /warnings (1 = first warning received), or "all"').setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  async execute(interaction) {
    const settings = getSettings(interaction.guild.id);

    if (!isModerator(interaction.member, settings)) {
      return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
    }

    const targetUser = interaction.options.getUser('user');
    const input = interaction.options.getString('number').trim().toLowerCase();
    const guildId = interaction.guild.id;

    const warnings = getWarnings(guildId, targetUser.id);

    if (warnings.length === 0) {
      return interaction.reply({ content: `<@${targetUser.id}> has no warnings to remove.`, ephemeral: true });
    }

    // --- Clear all ---
    if (input === 'all') {
      clearUserWarnings(guildId, targetUser.id);

      await interaction.reply({
        content: `Cleared all **${warnings.length}** warning(s) from <@${targetUser.id}>.`,
        ephemeral: true,
      });

      if (settings.warn_log_channel_id) {
        try {
          const logChannel = await interaction.guild.channels.fetch(settings.warn_log_channel_id);
          if (logChannel) {
            const logEmbed = new EmbedBuilder()
              .setTitle('All Warnings Cleared')
              .setColor(0x00CC66)
              .addFields(
                { name: 'User', value: `<@${targetUser.id}> (${targetUser.id})`, inline: true },
                { name: 'Cleared by', value: `<@${interaction.user.id}>`, inline: true },
                { name: 'Warnings Removed', value: `${warnings.length}`, inline: true },
              )
              .setTimestamp();
            await logChannel.send({ embeds: [logEmbed] });
          }
        } catch (err) {
          logger.warn(`Failed to post warning clear to log channel: ${err.message}`);
        }
      }
      return;
    }

    // --- Clear specific ---
    const number = parseInt(input, 10);
    if (isNaN(number) || number < 1) {
      return interaction.reply({
        content: 'Please provide a valid warning number (e.g. `1`) or `all`.',
        ephemeral: true,
      });
    }

    if (number > warnings.length) {
      return interaction.reply({
        content: `<@${targetUser.id}> only has **${warnings.length}** warning(s). Please provide a number between 1 and ${warnings.length}, or \`all\`.`,
        ephemeral: true,
      });
    }

    const warning = warnings[number - 1]; // warnings are DESC by created_at, matching /warnings display
    deleteWarning(warning.id, guildId);

    await interaction.reply({
      content: `Removed warning #${number} from <@${targetUser.id}>.\n**Reason was:** ${warning.reason}`,
      ephemeral: true,
    });

    if (settings.warn_log_channel_id) {
      try {
        const logChannel = await interaction.guild.channels.fetch(settings.warn_log_channel_id);
        if (logChannel) {
          const originalDate = new Date(warning.created_at + 'Z').toLocaleDateString('en-US', {
            year: 'numeric', month: 'short', day: 'numeric',
          });
          const logEmbed = new EmbedBuilder()
            .setTitle('Warning Removed')
            .setColor(0x00CC66)
            .addFields(
              { name: 'User', value: `<@${targetUser.id}> (${targetUser.id})`, inline: true },
              { name: 'Removed by', value: `<@${interaction.user.id}>`, inline: true },
              { name: 'Warnings Remaining', value: `${warnings.length - 1}`, inline: true },
              { name: 'Removed Warning Reason', value: warning.reason },
              { name: 'Type', value: warning.type === 'crosspost' ? 'Crosspost' : 'Manual', inline: true },
              { name: 'Originally Issued', value: originalDate, inline: true },
            )
            .setTimestamp();
          await logChannel.send({ embeds: [logEmbed] });
        }
      } catch (err) {
        logger.warn(`Failed to post warning removal to log channel: ${err.message}`);
      }
    }
  },
};
