const { SlashCommandBuilder, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const { addWarning, getWarnings, getWarningCount } = require('../../database/warnings');
const { getSettings } = require('../../database/settings');
const { addModAction } = require('../../database/modactions');
const { canWarn, isExempt } = require('../utils/permissions');
const { storePendingAction } = require('../utils/pendingActions');
const { buildWarningsEmbed } = require('../utils/embeds');
const { parseDuration, formatDuration } = require('../utils/parseDuration');
const logger = require('../../logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('warn')
    .setDescription('Issue a warning to a user')
    .addUserOption(opt =>
      opt.setName('user').setDescription('The user to warn').setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('reason').setDescription('Reason for the warning').setRequired(true).setAutocomplete(true)
    )
    .addStringOption(opt =>
      opt.setName('timeout').setDescription('Optional timeout: e.g. 30s, 5m, 1h, 2d, 1w, 1mo')
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  async execute(interaction) {
    const settings = getSettings(interaction.guild.id);

    if (!canWarn(interaction.member, settings)) {
      return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
    }

    const targetUser = interaction.options.getUser('user');
    const reason = interaction.options.getString('reason');
    const timeoutInput = interaction.options.getString('timeout');
    const timeoutMs = timeoutInput ? parseDuration(timeoutInput) : null;

    if (timeoutInput && !timeoutMs) {
      return interaction.reply({ content: 'Invalid timeout format. Use e.g. `30s`, `5m`, `1h`, `2d`, `1w`, `1mo`. Max 28 days.', ephemeral: true });
    }

    if (targetUser.bot) {
      return interaction.reply({ content: 'You cannot warn a bot.', ephemeral: true });
    }

    let targetMember;
    try {
      targetMember = await interaction.guild.members.fetch(targetUser.id);
    } catch {
      return interaction.reply({ content: 'Could not find that user in this server.', ephemeral: true });
    }

    if (isExempt(targetMember, settings)) {
      return interaction.reply({ content: 'You cannot warn a moderator or someone with a higher role.', ephemeral: true });
    }

    const existingWarnings = getWarnings(interaction.guild.id, targetUser.id);
    const warningThreshold = settings.warning_threshold || 3;

    // Threshold reached - show table with ban/continue buttons
    if (existingWarnings.length >= warningThreshold) {
      const embed = buildWarningsEmbed(existingWarnings, targetUser, interaction.guild);
      const displayName = targetUser.tag || targetUser.username;
      embed.setTitle(`${displayName} already has ${existingWarnings.length} warning(s)`);
      embed.setColor(0xFF0000);
      embed.setDescription(
        `**This user has reached the warning threshold (${warningThreshold}).**\n\n` +
        (embed.data.description || '')
      );

      const actionId = storePendingAction({
        targetId: targetUser.id,
        moderatorId: interaction.user.id,
        reason,
        guildId: interaction.guild.id,
        timeoutMs,
        timeoutLabel: timeoutMs ? formatDuration(timeoutMs) : null,
      });

      const buttons = [];
      if (interaction.member.permissions.has(PermissionFlagsBits.BanMembers)) {
        buttons.push(
          new ButtonBuilder()
            .setCustomId(`ban_user:${actionId}`)
            .setLabel('Ban instead')
            .setStyle(ButtonStyle.Danger)
        );
      }
      buttons.push(
        new ButtonBuilder()
          .setCustomId(`continue_warn:${actionId}`)
          .setLabel('Continue with warning')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`cancel_action:${actionId}`)
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Secondary),
      );
      const row = new ActionRowBuilder().addComponents(buttons);

      return interaction.reply({
        content: `**New warning reason:** ${reason}`,
        embeds: [embed],
        components: [row],
        ephemeral: true,
      });
    }

    // Below threshold - issue directly
    addWarning(interaction.guild.id, targetUser.id, interaction.user.id, reason, 'manual');
    const newCount = getWarningCount(interaction.guild.id, targetUser.id);

    try {
      addModAction(interaction.guild.id, interaction.user.id, 'warn', targetUser.id, reason);
    } catch (err) {
      logger.warn(`Failed to log mod action: ${err.message}`);
    }

    // Apply timeout if specified
    let timeoutApplied = false;
    let timeoutError = null;
    const timeoutLabel = timeoutMs ? formatDuration(timeoutMs) : null;
    if (timeoutMs) {
      try {
        await targetMember.timeout(timeoutMs, `Warning by ${interaction.user.tag}: ${reason}`);
        timeoutApplied = true;
        try {
          addModAction(interaction.guild.id, interaction.user.id, 'timeout', targetUser.id, `${timeoutLabel} — ${reason}`);
        } catch (err) {
          logger.warn(`Failed to log timeout mod action: ${err.message}`);
        }
      } catch (err) {
        logger.warn(`Failed to timeout user ${targetUser.id}: ${err.message}`);
        timeoutError = err.message;
      }
    }

    let replyContent = `Warning issued to <@${targetUser.id}> (now has ${newCount} total warning(s)).\n**Reason:** ${reason}`;
    if (timeoutApplied) {
      replyContent += `\n**Timeout:** ${timeoutLabel}`;
    } else if (timeoutError) {
      replyContent += `\n**Timeout failed:** ${timeoutError}`;
    }

    await interaction.reply({
      content: replyContent,
      ephemeral: true,
    });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`view_warnings:${targetUser.id}`)
        .setLabel('View reason')
        .setStyle(ButtonStyle.Secondary)
    );

    const publicMsg = settings.warn_public_message
      ? settings.warn_public_message.replace(/\{user\}/g, `<@${targetUser.id}>`)
      : `<@${targetUser.id}>, you have received an official warning.`;

    try {
      await interaction.channel.send({
        content: publicMsg,
        components: [row],
      });
    } catch (err) {
      logger.warn(`Failed to send public warning notification: ${err.message}`);
    }

    // Post to warn log channel if configured
    if (settings.warn_log_channel_id) {
      try {
        const logChannel = await interaction.guild.channels.fetch(settings.warn_log_channel_id);
        if (logChannel) {
          const logEmbed = new EmbedBuilder()
            .setTitle('Warning Issued')
            .setColor(0xFFA500)
            .addFields(
              { name: 'User', value: `<@${targetUser.id}> (${targetUser.id})`, inline: true },
              { name: 'Moderator', value: `<@${interaction.user.id}>`, inline: true },
              { name: 'Total Warnings', value: `${newCount}`, inline: true },
              { name: 'Reason', value: reason },
            )
            .setTimestamp();
          if (timeoutApplied) {
            logEmbed.addFields({ name: 'Timeout', value: timeoutLabel, inline: true });
          } else if (timeoutError) {
            logEmbed.addFields({ name: 'Timeout', value: `Failed: ${timeoutError}`, inline: true });
          }
          await logChannel.send({ embeds: [logEmbed] });
        }
      } catch (err) {
        logger.warn(`Failed to post to warn log channel: ${err.message}`);
      }
    }
  },
};
