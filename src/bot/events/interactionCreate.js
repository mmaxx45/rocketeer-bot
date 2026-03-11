const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const logger = require('../../logger');
const { getWarnings, getWarningCount, addWarning } = require('../../database/warnings');
const { getSettings } = require('../../database/settings');
const { addModAction } = require('../../database/modactions');
const { canWarn, canBan, isExempt, isModerator, canViewModActions } = require('../utils/permissions');
const { storePendingAction, getPendingAction, deletePendingAction } = require('../utils/pendingActions');
const { buildWarningsEmbed } = require('../utils/embeds');
const { getOpenThreadByChannel, closeThread } = require('../../database/modmail');

const DEFAULT_WARN_REASONS = [
  'Spam or flooding',
  'Inappropriate language',
  'Harassment or bullying',
  'NSFW content',
  'Advertising or self-promotion',
  'Crossposting',
  'Off-topic',
  'Impersonation',
  'Sharing personal information',
  'Trolling or disruptive behavior',
];

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

      try {
        addModAction(interaction.guild.id, interaction.user.id, 'ban', pending.targetId, `Banned due to accumulated warnings: ${pending.reason}`);
      } catch (err) {
        logger.warn(`Failed to log mod action: ${err.message}`);
      }

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

    addWarning(interaction.guild.id, pending.targetId, pending.moderatorId, pending.reason, 'manual', pending.messageContent || null);
    const newCount = getWarningCount(interaction.guild.id, pending.targetId);

    deletePendingAction(actionId);

    try {
      addModAction(interaction.guild.id, pending.moderatorId, 'warn', pending.targetId, pending.reason);
    } catch (err) {
      logger.warn(`Failed to log mod action: ${err.message}`);
    }

    // Apply timeout if specified
    let timeoutApplied = false;
    let timeoutError = null;
    if (pending.timeoutMs) {
      try {
        const member = await interaction.guild.members.fetch(pending.targetId);
        await member.timeout(pending.timeoutMs, `Warning by ${interaction.user.tag}: ${pending.reason}`);
        timeoutApplied = true;
        try {
          addModAction(interaction.guild.id, pending.moderatorId, 'timeout', pending.targetId, `${pending.timeoutLabel} — ${pending.reason}`);
        } catch (err) {
          logger.warn(`Failed to log timeout mod action: ${err.message}`);
        }
      } catch (err) {
        logger.warn(`Failed to timeout user ${pending.targetId}: ${err.message}`);
        timeoutError = err.message;
      }
    }

    let updateContent = `Warning issued to <@${pending.targetId}> (now has ${newCount} total warning(s)).\n**Reason:** ${pending.reason}`;
    if (timeoutApplied) {
      updateContent += `\n**Timeout:** ${pending.timeoutLabel}`;
    } else if (timeoutError) {
      updateContent += `\n**Timeout failed:** ${timeoutError}`;
    }

    await interaction.update({
      content: updateContent,
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

          if (timeoutApplied) {
            logEmbed.addFields({ name: 'Timeout', value: pending.timeoutLabel, inline: true });
          } else if (timeoutError) {
            logEmbed.addFields({ name: 'Timeout', value: `Failed: ${timeoutError}`, inline: true });
          }

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

  if (action === 'confirm_ban') {
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
      const deleteMessageSeconds = (pending.deleteMessageDays || 0) * 86400;
      await member.ban({
        reason: `Banned by ${interaction.user.tag}: ${pending.reason}`,
        deleteMessageSeconds,
      });

      deletePendingAction(actionId);

      await interaction.update({
        content: `<@${pending.targetId}> has been banned.\n**Reason:** ${pending.reason}`,
        embeds: [],
        components: [],
      });

      // Post public message in channel
      try {
        await interaction.channel.send({
          content: `<@${pending.targetId}> has been banned from the server.\n**Reason:** ${pending.reason}`,
        });
      } catch (err) {
        logger.warn(`Failed to send public ban notification: ${err.message}`);
      }

      // Log to ban log channel
      const settings = getSettings(interaction.guild.id);
      if (settings.ban_log_channel_id) {
        try {
          const logChannel = await interaction.guild.channels.fetch(settings.ban_log_channel_id);
          if (logChannel) {
            const warnings = getWarnings(interaction.guild.id, pending.targetId);
            const logEmbed = new EmbedBuilder()
              .setTitle('User Banned')
              .setColor(0xFF0000)
              .addFields(
                { name: 'User', value: `<@${pending.targetId}> (${pending.targetId})`, inline: true },
                { name: 'Banned by', value: `<@${interaction.user.id}>`, inline: true },
                { name: 'Total Warnings', value: `${warnings.length}`, inline: true },
                { name: 'Reason', value: pending.reason },
                { name: 'Messages Deleted', value: `${pending.deleteMessageDays || 0} day(s)`, inline: true },
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

  if (action === 'cancel_ban') {
    const actionId = params[0];
    const pending = getPendingAction(actionId);

    if (pending && interaction.user.id !== pending.moderatorId) {
      return interaction.reply({ content: 'This action is not for you.', ephemeral: true });
    }

    deletePendingAction(actionId);
    await interaction.update({
      content: 'Ban cancelled.',
      embeds: [],
      components: [],
    });
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

  if (action === 'modmail_close') {
    const channelId = params[0];
    const thread = getOpenThreadByChannel(channelId);

    if (!thread) {
      return interaction.reply({ content: 'This modmail thread is already closed or does not exist.', ephemeral: true });
    }

    // Check if user is a moderator
    const settings = getSettings(interaction.guild.id);
    if (!isModerator(interaction.member, settings)) {
      return interaction.reply({ content: 'Only moderators can close modmail threads.', ephemeral: true });
    }

    try {
      // Notify the user
      try {
        const user = await interaction.client.users.fetch(thread.user_id);
        await user.send({
          embeds: [
            new EmbedBuilder()
              .setTitle('Modmail Thread Closed')
              .setDescription(`Your modmail thread in **${interaction.guild.name}** has been closed by a moderator. If you need further assistance, send another message.`)
              .setColor(0xE74C3C)
              .setTimestamp(),
          ],
        });
      } catch (err) {
        logger.warn(`Failed to notify user of modmail closure: ${err.message}`);
      }

      // Close in database
      closeThread(thread.id, interaction.user.id);

      // Update the message
      await interaction.update({
        content: `Thread closed by <@${interaction.user.id}>.`,
        components: [],
      });

      // Archive and lock the channel
      try {
        const channel = await interaction.guild.channels.fetch(channelId);
        if (channel) {
          await channel.setName(`closed-${channel.name}`);
          // Send a final message
          await channel.send({
            embeds: [
              new EmbedBuilder()
                .setTitle('Thread Closed')
                .setDescription(`This modmail thread was closed by <@${interaction.user.id}>.`)
                .setColor(0xE74C3C)
                .setTimestamp(),
            ],
          });
          // Lock the channel by denying SendMessages for everyone
          await channel.permissionOverwrites.edit(interaction.guild.roles.everyone.id, {
            SendMessages: false,
          });
        }
      } catch (err) {
        logger.warn(`Failed to archive modmail channel: ${err.message}`);
      }

      logger.info(`Modmail thread closed: channel=${channelId} closedBy=${interaction.user.tag}`);
    } catch (err) {
      logger.error(`Failed to close modmail thread: ${err.message}`);
      await interaction.reply({ content: `Failed to close thread: ${err.message}`, ephemeral: true });
    }
    return;
  }

  if (action === 'modactions_page') {
    const targetUserId = params[0];
    const page = parseInt(params[1], 10);
    const settings = getSettings(interaction.guild.id);

    if (!canViewModActions(interaction.member, settings)) {
      return interaction.reply({ content: 'You do not have permission to view mod actions.', ephemeral: true });
    }

    const { getModActions } = require('../../database/modactions');
    const PAGE_SIZE = 10;
    const offset = (page - 1) * PAGE_SIZE;

    const { rows, total } = getModActions(interaction.guild.id, targetUserId, PAGE_SIZE, offset);
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

    let targetUser;
    try {
      targetUser = await interaction.client.users.fetch(targetUserId);
    } catch {
      targetUser = { id: targetUserId, tag: `Unknown (${targetUserId})`, username: `Unknown (${targetUserId})` };
    }

    const displayName = targetUser.tag || targetUser.username || `User ${targetUser.id}`;
    const embed = new EmbedBuilder()
      .setTitle(`Mod Actions by ${displayName}`)
      .setColor(0x5865F2)
      .setTimestamp();

    if (rows.length === 0) {
      embed.setDescription('No mod actions on record.');
    } else {
      const actionLabels = {
        warn: '\u26A0\uFE0F Warn',
        ban: '\uD83D\uDD28 Ban',
        timeout: '\u23F1\uFE0F Timeout',
        kick: '\uD83D\uDEAA Kick',
        crosspost_warn: '\uD83D\uDCCB Crosspost Warn',
        clear_warning: '\uD83D\uDDD1\uFE0F Clear Warning',
        clear_all_warnings: '\uD83D\uDDD1\uFE0F Clear All Warnings',
      };

      const lines = rows.map((a, i) => {
        const num = (page - 1) * PAGE_SIZE + i + 1;
        const date = new Date(a.created_at + 'Z').toLocaleDateString('en-US', {
          year: 'numeric', month: 'short', day: 'numeric',
        });
        const label = actionLabels[a.action_type] || `\u2699\uFE0F ${a.action_type}`;
        const details = a.details
          ? (a.details.length > 80 ? a.details.slice(0, 77) + '...' : a.details)
          : 'N/A';
        return `**${num}.** ${date} | ${label} | Target: <@${a.target_id}>\n> ${details}`;
      });

      const chunk = lines.join('\n');
      if (chunk.length <= 4096) {
        embed.setDescription(chunk);
      } else {
        embed.setDescription(lines.slice(0, 8).join('\n') + `\n\n*...truncated*`);
      }
    }

    embed.setFooter({ text: `Page ${page}/${totalPages} | Total: ${total} action(s)` });

    const buttons = [];
    if (page > 1) {
      buttons.push(
        new ButtonBuilder()
          .setCustomId(`modactions_page:${targetUserId}:${page - 1}`)
          .setLabel('Previous')
          .setStyle(ButtonStyle.Secondary)
      );
    }
    if (page < totalPages) {
      buttons.push(
        new ButtonBuilder()
          .setCustomId(`modactions_page:${targetUserId}:${page + 1}`)
          .setLabel('Next')
          .setStyle(ButtonStyle.Secondary)
      );
    }

    const components = buttons.length > 0
      ? [new ActionRowBuilder().addComponents(buttons)]
      : [];

    await interaction.update({
      embeds: [embed],
      components,
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

  // Fetch the target message content for storage
  let messageContent = null;
  try {
    const srcChannel = await interaction.guild.channels.fetch(channelId);
    const srcMessage = await srcChannel.messages.fetch(messageId);
    if (srcMessage && srcMessage.content) {
      messageContent = srcMessage.content;
    }
  } catch {
    // Message may have been deleted
  }

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
      messageContent,
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
  addWarning(interaction.guild.id, targetUserId, interaction.user.id, reason, 'manual', messageContent);
  const newCount = getWarningCount(interaction.guild.id, targetUserId);

  try {
    addModAction(interaction.guild.id, interaction.user.id, 'warn', targetUserId, reason);
  } catch (err) {
    logger.warn(`Failed to log mod action: ${err.message}`);
  }

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

async function handleAutocomplete(interaction) {
  if (interaction.commandName !== 'warn') return;

  const focused = interaction.options.getFocused();
  const guildId = interaction.guild.id;

  let reasons = DEFAULT_WARN_REASONS;
  try {
    const settings = getSettings(guildId);
    if (settings.custom_warn_reasons) {
      const parsed = JSON.parse(settings.custom_warn_reasons);
      if (Array.isArray(parsed) && parsed.length > 0) {
        reasons = parsed;
      }
    }
  } catch (err) {
    logger.warn(`Failed to load custom warn reasons for guild ${guildId}: ${err.message}`);
  }

  const filtered = reasons
    .filter(r => r.toLowerCase().includes(focused.toLowerCase()))
    .slice(0, 25);

  await interaction.respond(
    filtered.map(r => ({ name: r, value: r }))
  );
}

module.exports = {
  name: 'interactionCreate',
  async execute(interaction) {
    if (interaction.isAutocomplete()) {
      return handleAutocomplete(interaction);
    }
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
