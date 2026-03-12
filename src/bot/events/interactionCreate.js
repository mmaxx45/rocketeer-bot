const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const logger = require('../../logger');
const { getWarnings, getWarningCount, addWarning } = require('../../database/warnings');
const { getSettings } = require('../../database/settings');
const { addModAction } = require('../../database/modactions');
const { canWarn, canBan, isExempt, isModerator, canViewModActions } = require('../utils/permissions');
const { storePendingAction, getPendingAction, deletePendingAction } = require('../utils/pendingActions');
const { buildWarningsEmbed } = require('../utils/embeds');
const { parseDuration, formatDuration } = require('../utils/parseDuration');
const { getOpenThreadByChannel, closeThread } = require('../../database/modmail');
const { createTicket, getOpenTicketByUser, getOpenTicketByChannel, closeTicket } = require('../../database/tickets');

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
      await member.ban({ reason: `Banned by ${interaction.user.tag}: ${pending.reason}` });

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

      try {
        addModAction(interaction.guild.id, interaction.user.id, 'ban', pending.targetId, pending.reason);
      } catch (err) {
        logger.warn(`Failed to log mod action: ${err.message}`);
      }

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
    const pending = getPendingAction(actionId);

    if (pending && interaction.user.id !== pending.moderatorId) {
      return interaction.reply({ content: 'This action is not for you.', ephemeral: true });
    }

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
          await channel.setName(channel.name.startsWith('closed-') ? channel.name : `closed-${channel.name}`);
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

  if (action === 'open_license_ticket') {
    const settings = getSettings(interaction.guild.id);

    if (!settings.ticket_category_id) {
      return interaction.reply({ content: 'Ticket system is not configured yet. An admin needs to set a ticket category in the dashboard.', ephemeral: true });
    }

    // Check for existing open ticket
    const existing = getOpenTicketByUser(interaction.guild.id, interaction.user.id);
    if (existing) {
      return interaction.reply({ content: `You already have an open ticket: <#${existing.channel_id}>`, ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const { ChannelType, PermissionFlagsBits: Perms } = require('discord.js');

      // Build permission overwrites
      const overwrites = [
        { id: interaction.guild.roles.everyone.id, deny: [Perms.ViewChannel] },
        { id: interaction.user.id, allow: [Perms.ViewChannel, Perms.SendMessages, Perms.ReadMessageHistory] },
        { id: interaction.client.user.id, allow: [Perms.ViewChannel, Perms.SendMessages, Perms.ManageChannels] },
      ];

      if (settings.ticket_admin_role_id) {
        overwrites.push({ id: settings.ticket_admin_role_id, allow: [Perms.ViewChannel, Perms.SendMessages, Perms.ReadMessageHistory] });
      }

      const channel = await interaction.guild.channels.create({
        name: `ticket-${interaction.user.username}`.slice(0, 100),
        type: ChannelType.GuildText,
        parent: settings.ticket_category_id,
        permissionOverwrites: overwrites,
      });

      createTicket(interaction.guild.id, interaction.user.id, channel.id);

      // Send welcome embed with close button
      const welcomeEmbed = new EmbedBuilder()
        .setTitle('Ticket Opened')
        .setDescription(`Hey <@${interaction.user.id}>, thanks for your interest! An admin will be with you shortly.\n\nPlease describe what you need and we'll get you sorted.`)
        .setColor(0x5865F2)
        .setTimestamp();

      const closeRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`close_ticket:${channel.id}`)
          .setLabel('Close Ticket')
          .setStyle(ButtonStyle.Danger)
      );

      await channel.send({ embeds: [welcomeEmbed], components: [closeRow] });

      // Ping admin role if configured
      if (settings.ticket_admin_role_id) {
        await channel.send({ content: `<@&${settings.ticket_admin_role_id}>`, allowedMentions: { roles: [settings.ticket_admin_role_id] } });
      }

      await interaction.editReply({ content: `Your ticket has been created: <#${channel.id}>` });
      logger.info(`License ticket created: channel=${channel.name} user=${interaction.user.tag}`);
    } catch (err) {
      logger.error(`Failed to create ticket channel: ${err.message}`);
      await interaction.editReply({ content: `Failed to create ticket: ${err.message}` });
    }
    return;
  }

  if (action === 'close_ticket') {
    const channelId = params[0];
    const settings = getSettings(interaction.guild.id);

    // Permission check: admin, ticket admin role, or the ticket owner
    const ticket = getOpenTicketByChannel(channelId);
    if (!ticket) {
      return interaction.reply({ content: 'This ticket is already closed or does not exist.', ephemeral: true });
    }

    const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.Administrator);
    const isTicketAdmin = settings.ticket_admin_role_id && interaction.member.roles.cache.has(settings.ticket_admin_role_id);

    if (!isAdmin && !isTicketAdmin) {
      return interaction.reply({ content: 'Only admins can close tickets.', ephemeral: true });
    }

    // Log transcript before closing
    if (settings.ticket_log_channel_id) {
      try {
        const logChannel = await interaction.guild.channels.fetch(settings.ticket_log_channel_id);
        if (logChannel) {
          const messages = await interaction.channel.messages.fetch({ limit: 100 });
          const transcript = messages
            .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
            .map(m => `[${m.createdAt.toISOString()}] ${m.author.tag}: ${m.content || '(embed/attachment)'}`)
            .join('\n');

          const logEmbed = new EmbedBuilder()
            .setTitle('Ticket Closed')
            .setColor(0xE74C3C)
            .addFields(
              { name: 'Ticket', value: `#${interaction.channel.name}`, inline: true },
              { name: 'Customer', value: `<@${ticket.user_id}>`, inline: true },
              { name: 'Closed by', value: `<@${interaction.user.id}>`, inline: true },
            )
            .setTimestamp();

          const files = [];
          if (transcript.length > 0) {
            files.push({
              attachment: Buffer.from(transcript, 'utf-8'),
              name: `transcript-${interaction.channel.name}.txt`,
            });
          }

          await logChannel.send({ embeds: [logEmbed], files });
        }
      } catch (err) {
        logger.warn(`Failed to log ticket transcript: ${err.message}`);
      }
    }

    closeTicket(ticket.id, interaction.user.id);

    await interaction.update({
      embeds: [
        new EmbedBuilder()
          .setTitle('Ticket Closed')
          .setDescription(`This ticket was closed by <@${interaction.user.id}>. This channel will be deleted in 5 seconds.`)
          .setColor(0xE74C3C)
          .setTimestamp(),
      ],
      components: [],
    });

    setTimeout(async () => {
      try {
        await interaction.channel.delete('Ticket closed');
      } catch (err) {
        logger.warn(`Failed to delete ticket channel: ${err.message}`);
      }
    }, 5000);

    logger.info(`Ticket closed via button: channel=${interaction.channel.name} closedBy=${interaction.user.tag}`);
    return;
  }

  if (action === 'request_hwid_reset') {
    const modal = new ModalBuilder()
      .setCustomId('hwid_reset_modal')
      .setTitle('Request HWID Reset');

    const reasonInput = new TextInputBuilder()
      .setCustomId('reason')
      .setLabel('Reason for HWID reset')
      .setPlaceholder('e.g. Got a new PC')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(200);

    modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
    await interaction.showModal(modal);
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

async function handleHwidResetModal(interaction) {
  const config = require('../../config');
  const reason = interaction.fields.getTextInputValue('reason');

  if (!config.licensing.apiUrl || !config.licensing.apiKey) {
    return interaction.reply({ content: 'HWID reset is not configured. Please contact an admin.', ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    // Look up the user's license
    const searchRes = await fetch(
      `${config.licensing.apiUrl}/api/v1/licenses?search=${encodeURIComponent(interaction.user.username)}`,
      { headers: { 'Authorization': `Bearer ${config.licensing.apiKey}` } }
    );

    if (!searchRes.ok) {
      logger.error(`License search API error: ${searchRes.status}`);
      return interaction.editReply({ content: 'Failed to look up your license. Please contact an admin.' });
    }

    const searchData = await searchRes.json();
    const licenses = searchData.licenses || searchData.data || searchData;
    const list = Array.isArray(licenses) ? licenses : [];

    // Find an active or suspended license
    const license = list.find(l => l.status === 'active' || l.status === 'suspended');
    if (!license) {
      return interaction.editReply({ content: 'You don\'t have an active license. If you believe this is an error, please contact an admin.' });
    }

    // Submit the HWID reset (public endpoint, no auth)
    const resetRes = await fetch(`${config.licensing.apiUrl}/api/v1/hwid-reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        license_key: license.license_key,
        reason,
      }),
    });

    const resetData = await resetRes.json();

    if (resetRes.ok) {
      await interaction.editReply({ content: `Your HWID has been reset successfully. You can now activate on your new device.\n**Reason:** ${reason}` });
      logger.info(`HWID reset for ${interaction.user.tag} (license: ${license.license_key.slice(0, 4)}...) reason: ${reason}`);

      // Log to ticket log channel if configured
      const settings = getSettings(interaction.guild.id);
      if (settings.ticket_log_channel_id) {
        try {
          const logChannel = await interaction.guild.channels.fetch(settings.ticket_log_channel_id);
          if (logChannel) {
            const logEmbed = new EmbedBuilder()
              .setTitle('HWID Reset')
              .setColor(0xE67E22)
              .addFields(
                { name: 'User', value: `<@${interaction.user.id}> (${interaction.user.username})`, inline: true },
                { name: 'Reason', value: reason, inline: true },
              )
              .setTimestamp();
            await logChannel.send({ embeds: [logEmbed] });
          }
        } catch (err) {
          logger.warn(`Failed to log HWID reset: ${err.message}`);
        }
      }
    } else {
      const errorMsg = resetData.error || resetData.message || 'Unknown error';
      await interaction.editReply({ content: `HWID reset failed: ${errorMsg}` });
      logger.warn(`HWID reset failed for ${interaction.user.tag}: ${errorMsg}`);
    }
  } catch (err) {
    logger.error(`HWID reset error: ${err.message}`);
    await interaction.editReply({ content: `Failed to process HWID reset: ${err.message}` });
  }
}

async function handleModalSubmit(interaction) {
  if (interaction.customId === 'hwid_reset_modal') {
    return handleHwidResetModal(interaction);
  }

  if (!interaction.customId.startsWith('warn_modal:')) return;

  const [, targetUserId, messageId, channelId] = interaction.customId.split(':');
  const reason = interaction.fields.getTextInputValue('reason') || 'No reason provided';
  const timeoutInput = interaction.fields.getTextInputValue('timeout') || null;
  const timeoutMs = timeoutInput ? parseDuration(timeoutInput) : null;
  const timeoutLabel = timeoutMs ? formatDuration(timeoutMs) : null;
  const settings = getSettings(interaction.guild.id);

  if (timeoutInput && !timeoutMs) {
    return interaction.reply({ content: 'Invalid timeout format. Use e.g. `30s`, `5m`, `1h`, `2d`, `1w`, `1mo`. Max 28 days.', ephemeral: true });
  }

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
      timeoutMs,
      timeoutLabel,
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

  // Apply timeout if specified
  let timeoutApplied = false;
  let timeoutError = null;
  if (timeoutMs) {
    try {
      const member = await interaction.guild.members.fetch(targetUserId);
      await member.timeout(timeoutMs, `Warning by ${interaction.user.tag}: ${reason}`);
      timeoutApplied = true;
      try {
        addModAction(interaction.guild.id, interaction.user.id, 'timeout', targetUserId, `${timeoutLabel} — ${reason}`);
      } catch (err) {
        logger.warn(`Failed to log timeout mod action: ${err.message}`);
      }
    } catch (err) {
      logger.warn(`Failed to timeout user ${targetUserId}: ${err.message}`);
      timeoutError = err.message;
    }
  }

  let replyContent = `Warning issued to <@${targetUserId}> (now has ${newCount} total warning(s)).\n**Reason:** ${reason}`;
  if (timeoutApplied) {
    replyContent += `\n**Timeout:** ${timeoutLabel}`;
  } else if (timeoutError) {
    replyContent += `\n**Timeout failed:** ${timeoutError}`;
  }

  await interaction.reply({
    content: replyContent,
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

        if (timeoutApplied) {
          logEmbed.addFields({ name: 'Timeout', value: timeoutLabel, inline: true });
        } else if (timeoutError) {
          logEmbed.addFields({ name: 'Timeout', value: `Failed: ${timeoutError}`, inline: true });
        }

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
