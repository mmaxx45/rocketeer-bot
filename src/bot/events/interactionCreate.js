const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const logger = require('../../logger');
const { getWarnings, getWarningCount, addWarning } = require('../../database/warnings');
const { getSettings } = require('../../database/settings');
const { canWarn, isExempt, isModerator } = require('../utils/permissions');
const { storePendingAction, getPendingAction, deletePendingAction } = require('../utils/pendingActions');
const { buildWarningsEmbed } = require('../utils/embeds');

async function handleButton(interaction) {
  const [action, ...params] = interaction.customId.split(':');

  if (action === 'view_warnings') {
    const targetUserId = params[0];
    const settings = getSettings(interaction.guild.id);
    const modViewing = isModerator(interaction.member, settings);

    if (interaction.user.id !== targetUserId && !modViewing) {
      return interaction.reply({ content: 'This button is not for you.', ephemeral: true });
    }

    let targetUser;
    try {
      targetUser = await interaction.client.users.fetch(targetUserId);
    } catch {
      targetUser = { id: targetUserId, tag: `Unknown (${targetUserId})`, username: `Unknown (${targetUserId})` };
    }

    const warnings = getWarnings(interaction.guild.id, targetUserId);
    const embed = buildWarningsEmbed(warnings, targetUser, interaction.guild, modViewing);

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  if (action === 'ban_user') {
    const actionId = params[0];
    const pending = getPendingAction(actionId);

    if (!pending) {
      return interaction.reply({ content: 'This action has expired. Please run the command again.', ephemeral: true });
    }

    if (interaction.user.id !== pending.moderatorId) {
      return interaction.reply({ content: 'This action is not for you.', ephemeral: true });
    }

    try {
      const member = await interaction.guild.members.fetch(pending.targetId);
      await member.ban({ reason: `Banned by ${interaction.user.tag}: accumulated warnings` });

      deletePendingAction(actionId);

      await interaction.update({
        content: `<@${pending.targetId}> has been banned. All warnings have been preserved in the log.`,
        embeds: [],
        components: [],
      });

      const settings = getSettings(interaction.guild.id);
      if (settings.ban_log_channel_id) {
        try {
          const logChannel = await interaction.guild.channels.fetch(settings.ban_log_channel_id);
          if (logChannel) {
            const { getWarnings } = require('../../database/warnings');
            const warnings = getWarnings(interaction.guild.id, pending.targetId);
            const logEmbed = new EmbedBuilder()
              .setTitle('User Banned')
              .setColor(0xFF0000)
              .addFields(
                { name: 'User', value: `<@${pending.targetId}> (${pending.targetId})`, inline: true },
                { name: 'Banned by', value: `<@${interaction.user.id}>`, inline: true },
                { name: 'Total Warnings', value: `${warnings.length}`, inline: true },
                { name: 'Reason', value: pending.reason },
              )
              .setTimestamp();
            await logChannel.send({ embeds: [logEmbed] });
          }
        } catch (err) {
          logger.warn(`Failed to post to ban log channel: ${err.message}`);
        }
      }
    } catch (err) {
      logger.error(`Failed to ban user ${pending.targetId}:`, err);
      await interaction.reply({ content: `Failed to ban user: ${err.message}`, ephemeral: true });
    }
    return;
  }

  if (action === 'continue_warn') {
    const actionId = params[0];
    const pending = getPendingAction(actionId);

    if (!pending) {
      return interaction.reply({ content: 'This action has expired. Please run the command again.', ephemeral: true });
    }

    if (interaction.user.id !== pending.moderatorId) {
      return interaction.reply({ content: 'This action is not for you.', ephemeral: true });
    }

    addWarning(interaction.guild.id, pending.targetId, pending.moderatorId, pending.reason, 'manual');
    const newCount = getWarningCount(interaction.guild.id, pending.targetId);

    deletePendingAction(actionId);

    await interaction.update({
      content: `Warning issued to <@${pending.targetId}> (now has ${newCount} total warning(s)).\n**Reason:** ${pending.reason}`,
      embeds: [],
      components: [],
    });

    const btnRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`view_warnings:${pending.targetId}`)
        .setLabel('View reason')
        .setStyle(ButtonStyle.Secondary)
    );

    const settings = getSettings(interaction.guild.id);
    const publicMsg = settings.warn_public_message
      ? settings.warn_public_message.replace(/\{user\}/g, `<@${pending.targetId}>`)
      : `<@${pending.targetId}>, you have received an official warning.`;

    try {
      await interaction.channel.send({
        content: publicMsg,
        components: [btnRow],
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
              { name: 'User', value: `<@${pending.targetId}> (${pending.targetId})`, inline: true },
              { name: 'Moderator', value: `<@${pending.moderatorId}>`, inline: true },
              { name: 'Total Warnings', value: `${newCount}`, inline: true },
              { name: 'Reason', value: pending.reason },
            )
            .setTimestamp();

          // If this came from context menu warn, include the message
          if (pending.messageId && pending.channelId) {
            try {
              const srcChannel = await interaction.guild.channels.fetch(pending.channelId);
              const srcMessage = await srcChannel.messages.fetch(pending.messageId);
              if (srcMessage && srcMessage.content) {
                const content = srcMessage.content.length > 1024
                  ? srcMessage.content.slice(0, 1021) + '...'
                  : srcMessage.content;
                logEmbed.addFields({ name: 'Message Content', value: content });
              }
              logEmbed.addFields({ name: 'Message Link', value: `[Jump to message](https://discord.com/channels/${interaction.guild.id}/${pending.channelId}/${pending.messageId})` });
            } catch {
              // Message may have been deleted
            }
          }

          await logChannel.send({ embeds: [logEmbed] });
        }
      } catch (err) {
        logger.warn(`Failed to post to warn log channel: ${err.message}`);
      }
    }
    return;
  }

  if (action === 'cancel_action') {
    const actionId = params[0];
    deletePendingAction(actionId);
    await interaction.update({
      content: 'Action cancelled.',
      embeds: [],
      components: [],
    });
    return;
  }
}

async function handleCommand(interaction) {
  const command = interaction.client.commands.get(interaction.commandName);
  if (!command) {
    logger.warn(`Unknown command: ${interaction.commandName}`);
    return;
  }

  try {
    await command.execute(interaction);
  } catch (err) {
    logger.error(`Error executing command ${interaction.commandName}:`, err);
    const reply = { content: 'An error occurred while executing this command.', ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(reply);
    } else {
      await interaction.reply(reply);
    }
  }
}

async function handleModalSubmit(interaction) {
  if (!interaction.customId.startsWith('warn_modal:')) return;

  const [, targetUserId, messageId, channelId] = interaction.customId.split(':');
  const reason = interaction.fields.getTextInputValue('reason') || 'No reason provided';
  const settings = getSettings(interaction.guild.id);

  if (!canWarn(interaction.member, settings)) {
    return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
  }

  let targetUser;
  try {
    targetUser = await interaction.client.users.fetch(targetUserId);
  } catch {
    return interaction.reply({ content: 'Could not find that user.', ephemeral: true });
  }

  let targetMember;
  try {
    targetMember = await interaction.guild.members.fetch(targetUserId);
  } catch {
    return interaction.reply({ content: 'Could not find that user in this server.', ephemeral: true });
  }

  if (isExempt(targetMember, settings)) {
    return interaction.reply({ content: 'You cannot warn a moderator or someone with a higher role.', ephemeral: true });
  }

  const existingWarnings = getWarnings(interaction.guild.id, targetUserId);
  const warningThreshold = settings.warning_threshold || 3;

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
      targetId: targetUserId,
      moderatorId: interaction.user.id,
      reason,
      guildId: interaction.guild.id,
      messageId,
      channelId,
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
  addWarning(interaction.guild.id, targetUserId, interaction.user.id, reason, 'manual');
  const newCount = getWarningCount(interaction.guild.id, targetUserId);

  await interaction.reply({
    content: `Warning issued to <@${targetUserId}> (now has ${newCount} total warning(s)).\n**Reason:** ${reason}`,
    ephemeral: true,
  });

  // Send public notification
  const warnPublicMsg = settings.warn_public_message
    ? settings.warn_public_message.replace(/\{user\}/g, `<@${targetUserId}>`)
    : `<@${targetUserId}>, you have received an official warning.`;

  try {
    const channel = await interaction.guild.channels.fetch(channelId);
    if (channel) {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`view_warnings:${targetUserId}`)
          .setLabel('View reason')
          .setStyle(ButtonStyle.Secondary)
      );
      await channel.send({
        content: warnPublicMsg,
        components: [row],
      });
    }
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
            { name: 'User', value: `<@${targetUserId}> (${targetUserId})`, inline: true },
            { name: 'Moderator', value: `<@${interaction.user.id}>`, inline: true },
            { name: 'Total Warnings', value: `${newCount}`, inline: true },
            { name: 'Reason', value: reason },
          )
          .setTimestamp();

        // Fetch and include the original message content
        try {
          const srcChannel = await interaction.guild.channels.fetch(channelId);
          const srcMessage = await srcChannel.messages.fetch(messageId);
          if (srcMessage && srcMessage.content) {
            const content = srcMessage.content.length > 1024
              ? srcMessage.content.slice(0, 1021) + '...'
              : srcMessage.content;
            logEmbed.addFields({ name: 'Message Content', value: content });
          }
          logEmbed.addFields({ name: 'Message Link', value: `[Jump to message](https://discord.com/channels/${interaction.guild.id}/${channelId}/${messageId})` });
        } catch {
          // Message may have been deleted
        }

        await logChannel.send({ embeds: [logEmbed] });
      }
    } catch (err) {
      logger.warn(`Failed to post to warn log channel: ${err.message}`);
    }
  }
}

module.exports = {
  name: 'interactionCreate',
  async execute(interaction) {
    if (interaction.isChatInputCommand() || interaction.isContextMenuCommand()) {
      return handleCommand(interaction);
    }
    if (interaction.isButton()) {
      return handleButton(interaction);
    }
    if (interaction.isModalSubmit()) {
      return handleModalSubmit(interaction);
    }
  },
};
