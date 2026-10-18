const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, MessageFlags } = require('discord.js');
const { getWarnings, deleteWarning, clearUserWarnings } = require('../../database/warnings');
const { getSettings } = require('../../database/settings');
const { addModAction } = require('../../database/modactions');
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
    const settings = await getSettings(interaction.guild.id);

    if (!isModerator(interaction.member, settings)) {
      return interaction.reply({ content: 'You do not have permission to use this command.', flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const targetUser = interaction.options.getUser('user');
    const input = interaction.options.getString('number').trim().toLowerCase();
    const guildId = interaction.guild.id;

    const warnings = await getWarnings(guildId, targetUser.id);

    if (warnings.length === 0) {
      return interaction.editReply({ content: `<@${targetUser.id}> has no warnings to remove.` });
    }

    // --- Clear all ---
    if (input === 'all') {
      await clearUserWarnings(guildId, targetUser.id);

      try {
        await addModAction(guildId, interaction.user.id, 'clear_all_warnings', targetUser.id, `Cleared ${warnings.length} warning(s)`);
      } catch (err) {
        logger.warn(`Failed to log mod action: ${err.message}`);
      }

      await interaction.editReply({
        content: `Cleared all **${warnings.length}** warning(s) from <@${targetUser.id}>.`,
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
      return interaction.editReply({
        content: 'Please provide a valid warning number (e.g. `1`) or `all`.',
      });
    }

    if (number > warnings.length) {
      return interaction.editReply({
        content: `<@${targetUser.id}> only has **${warnings.length}** warning(s). Please provide a number between 1 and ${warnings.length}, or \`all\`.`,
      });
    }

    const warning = warnings[number - 1]; // warnings are ASC by created_at, so #1 = oldest
    await deleteWarning(warning.id, guildId);

    try {
      await addModAction(guildId, interaction.user.id, 'clear_warning', targetUser.id, `Removed warning #${number}: ${warning.reason}`);
    } catch (err) {
      logger.warn(`Failed to log mod action: ${err.message}`);
    }

    await interaction.editReply({
      content: `Removed warning #${number} from <@${targetUser.id}>.\n**Reason was:** ${warning.reason}`,
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
