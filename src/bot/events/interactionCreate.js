const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags, AttachmentBuilder } = require('discord.js');
const path = require('path');
const fs = require('fs');
const logger = require('../../logger');
const { getWarnings, getWarningCount, addWarning } = require('../../database/warnings');
const { getSettings } = require('../../database/settings');
const { addModAction } = require('../../database/modactions');
const { canWarn, canBan, isExempt, isModerator, canViewModActions } = require('../utils/permissions');
const { storePendingAction, consumePendingAction } = require('../utils/pendingActions');
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

// Per-user cooldown for rate-limited operations (tickets, HWID resets)
const cooldowns = new Map();
const COOLDOWN_MS = 30 * 1000; // 30 seconds

function checkCooldown(userId, action) {
  const key = `${userId}:${action}`;
  const last = cooldowns.get(key);
  if (last && Date.now() - last < COOLDOWN_MS) return false;
  cooldowns.set(key, Date.now());
  // Clean up old entries periodically
  if (cooldowns.size > 1000) {
    const now = Date.now();
    for (const [k, v] of cooldowns) {
      if (now - v > COOLDOWN_MS) cooldowns.delete(k);
    }
  }
  return true;
}

async function handleButton(interaction) {
  const [action, ...params] = interaction.customId.split(':');

  if (action === 'view_warnings') {
    const targetUserId = params[0];
    const settings = getSettings(interaction.guild.id);
    const modViewing = isModerator(interaction.member, settings);

    if (interaction.user.id !== targetUserId && !modViewing) {
      return interaction.reply({ content: 'This button is not for you.', flags: MessageFlags.Ephemeral });
    }

    let targetUser;
    try {
      targetUser = await interaction.client.users.fetch(targetUserId);
    } catch {
      targetUser = { id: targetUserId, tag: `Unknown (${targetUserId})`, username: `Unknown (${targetUserId})` };
    }

    const warnings = getWarnings(interaction.guild.id, targetUserId);
    const embed = buildWarningsEmbed(warnings, targetUser, interaction.guild, modViewing);

    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  if (action === 'ban_user') {
    const actionId = params[0];
    const pending = consumePendingAction(actionId);

    if (!pending) {
      return interaction.reply({ content: 'This action has expired. Please run the command again.', flags: MessageFlags.Ephemeral });
    }

    if (interaction.user.id !== pending.moderatorId) {
      return interaction.reply({ content: 'This action is not for you.', flags: MessageFlags.Ephemeral });
    }

    // Re-verify ban permission in case it was revoked since the button was created
    const settings = getSettings(interaction.guild.id);
    if (!canBan(interaction.member, settings)) {
      return interaction.reply({ content: 'You no longer have permission to ban.', flags: MessageFlags.Ephemeral });
    }

    // Re-check target is not now exempt (e.g. promoted to mod)
    try {
      const targetMember = await interaction.guild.members.fetch(pending.targetId);
      if (isExempt(targetMember, settings)) {
        return interaction.reply({ content: 'This user is now a moderator or admin and cannot be banned.', flags: MessageFlags.Ephemeral });
      }
    } catch {
      // User left the server — still bannable via guild.bans.create below
    }

    try {
      try {
        const member = await interaction.guild.members.fetch(pending.targetId);
        await member.ban({ reason: `Banned by ${interaction.user.username}: ${pending.reason}` });
      } catch {
        // User may have left — fall back to ID-based ban
        await interaction.guild.bans.create(pending.targetId, { reason: `Banned by ${interaction.user.username}: ${pending.reason}` });
      }

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
      await interaction.reply({ content: `Failed to ban user: ${err.message}`, flags: MessageFlags.Ephemeral });
    }
    return;
  }

  if (action === 'continue_warn') {
    const actionId = params[0];
    const pending = consumePendingAction(actionId);

    if (!pending) {
      return interaction.reply({ content: 'This action has expired. Please run the command again.', flags: MessageFlags.Ephemeral });
    }

    if (interaction.user.id !== pending.moderatorId) {
      return interaction.reply({ content: 'This action is not for you.', flags: MessageFlags.Ephemeral });
    }

    addWarning(interaction.guild.id, pending.targetId, pending.moderatorId, pending.reason, 'manual', pending.messageContent || null);
    const newCount = getWarningCount(interaction.guild.id, pending.targetId);

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
        await member.timeout(pending.timeoutMs, `Warning by ${interaction.user.username}: ${pending.reason}`);
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
    const pending = consumePendingAction(actionId);

    if (!pending) {
      return interaction.reply({ content: 'This action has expired. Please run the command again.', flags: MessageFlags.Ephemeral });
    }

    if (interaction.user.id !== pending.moderatorId) {
      return interaction.reply({ content: 'This action is not for you.', flags: MessageFlags.Ephemeral });
    }

    // Re-verify ban permission in case it was revoked
    const banSettings = getSettings(interaction.guild.id);
    if (!canBan(interaction.member, banSettings)) {
      return interaction.reply({ content: 'You no longer have permission to ban.', flags: MessageFlags.Ephemeral });
    }

    try {
      const deleteMessageSeconds = (pending.deleteMessageDays || 0) * 86400;
      try {
        const member = await interaction.guild.members.fetch(pending.targetId);
        await member.ban({
          reason: `Banned by ${interaction.user.username}: ${pending.reason}`,
          deleteMessageSeconds,
        });
      } catch {
        // User may have left — fall back to ID-based ban
        await interaction.guild.bans.create(pending.targetId, {
          reason: `Banned by ${interaction.user.username}: ${pending.reason}`,
          deleteMessageSeconds,
        });
      }

      try {
        addModAction(interaction.guild.id, interaction.user.id, 'ban', pending.targetId, pending.reason);
      } catch (err) {
        logger.warn(`Failed to log mod action: ${err.message}`);
      }

      await interaction.update({
        content: `<@${pending.targetId}> has been banned.\n**Reason:** ${pending.reason}`,
        embeds: [],
        components: [],
      });

      // Post public message in channel
      try {
        await interaction.channel.send({
          content: `<@${pending.targetId}> has been banned from the server.`,
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
      await interaction.reply({ content: `Failed to ban user: ${err.message}`, flags: MessageFlags.Ephemeral });
    }
    return;
  }

  if (action === 'cancel_ban') {
    const actionId = params[0];
    const pending = consumePendingAction(actionId);

    if (!pending) {
      return interaction.reply({ content: 'This action has already expired or been completed.', flags: MessageFlags.Ephemeral });
    }

    if (interaction.user.id !== pending.moderatorId) {
      return interaction.reply({ content: 'This action is not for you.', flags: MessageFlags.Ephemeral });
    }

    await interaction.update({
      content: 'Ban cancelled.',
      embeds: [],
      components: [],
    });
    return;
  }

  if (action === 'cancel_action') {
    const actionId = params[0];
    const pending = consumePendingAction(actionId);

    if (!pending) {
      return interaction.reply({ content: 'This action has already expired or been completed.', flags: MessageFlags.Ephemeral });
    }

    if (interaction.user.id !== pending.moderatorId) {
      return interaction.reply({ content: 'This action is not for you.', flags: MessageFlags.Ephemeral });
    }

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
      return interaction.reply({ content: 'This modmail thread is already closed or does not exist.', flags: MessageFlags.Ephemeral });
    }

    // Check if user is a moderator
    const settings = getSettings(interaction.guild.id);
    if (!isModerator(interaction.member, settings)) {
      return interaction.reply({ content: 'Only moderators can close modmail threads.', flags: MessageFlags.Ephemeral });
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

      // Delete the channel after a brief delay
      try {
        const channel = await interaction.guild.channels.fetch(channelId);
        if (channel) {
          // Send a final message so mods see it before deletion
          await channel.send({
            embeds: [
              new EmbedBuilder()
                .setTitle('Thread Closed')
                .setDescription(`This modmail thread was closed by <@${interaction.user.id}>. This channel will be deleted in 5 seconds.`)
                .setColor(0xE74C3C)
                .setTimestamp(),
            ],
          });
          // Brief delay so the message is visible
          await new Promise(r => setTimeout(r, 5000));
          await channel.delete('Modmail thread closed');
        }
      } catch (err) {
        logger.warn(`Failed to delete modmail channel: ${err.message}`);
      }

      logger.info(`Modmail thread closed: channel=${channelId} closedBy=${interaction.user.username}`);
    } catch (err) {
      logger.error(`Failed to close modmail thread: ${err.message}`);
      await interaction.reply({ content: `Failed to close thread: ${err.message}`, flags: MessageFlags.Ephemeral });
    }
    return;
  }

  if (action === 'open_license_ticket') {
    if (!checkCooldown(interaction.user.id, 'ticket')) {
      return interaction.reply({ content: 'Please wait before trying again.', flags: MessageFlags.Ephemeral });
    }

    const config = require('../../config');
    const settings = getSettings(interaction.guild.id);

    if (!settings.ticket_category_id) {
      return interaction.reply({ content: 'Ticket system is not configured yet. An admin needs to set a ticket category in the dashboard.', flags: MessageFlags.Ephemeral });
    }

    if (!config.licensing.apiUrl || !config.licensing.apiKey) {
      return interaction.reply({ content: 'Licensing system is not configured. Please contact an admin.', flags: MessageFlags.Ephemeral });
    }

    // Check for existing open ticket
    const existing = getOpenTicketByUser(interaction.guild.id, interaction.user.id);
    if (existing) {
      return interaction.reply({ content: `You already have an open ticket: <#${existing.channel_id}>`, flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      // Check if user already has an active license
      const searchRes = await fetch(
        `${config.licensing.apiUrl}/api/v1/licenses?search=${encodeURIComponent(interaction.user.username)}`,
        { headers: { 'Authorization': `Bearer ${config.licensing.apiKey}` } }
      );

      let hasExistingLicense = false;
      if (searchRes.ok) {
        const searchData = await searchRes.json();
        const licenses = searchData.licenses || searchData.data || searchData;
        const list = Array.isArray(licenses) ? licenses : [];
        hasExistingLicense = !!list.find(l => l.status === 'active' || l.status === 'suspended');
      }

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

      const closeRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`close_ticket:${channel.id}`)
          .setLabel('Close Ticket')
          .setStyle(ButtonStyle.Danger)
      );

      if (hasExistingLicense) {
        // User already has a license — just open a help ticket
        const helpEmbed = new EmbedBuilder()
          .setTitle('You Already Have a License')
          .setDescription(`Hey <@${interaction.user.id}>, you already have an active license.\n\nIf you need help, an admin will be with you shortly.`)
          .setColor(0xE67E22)
          .setTimestamp();

        await channel.send({ embeds: [helpEmbed], components: [closeRow] });

        if (settings.ticket_admin_role_id) {
          await channel.send({ content: `<@&${settings.ticket_admin_role_id}>`, allowedMentions: { roles: [settings.ticket_admin_role_id] } });
        }

        await interaction.editReply({ content: `Your ticket has been created: <#${channel.id}>` });
        logger.info(`License help ticket created (existing license): channel=${channel.name} user=${interaction.user.username}`);

        if (settings.ticket_log_channel_id) {
          try {
            const logChannel = await interaction.guild.channels.fetch(settings.ticket_log_channel_id);
            if (logChannel) {
              const logEmbed = new EmbedBuilder()
                .setTitle('Help Ticket Opened (Existing License)')
                .setColor(0xE67E22)
                .addFields(
                  { name: 'User', value: `<@${interaction.user.id}> (${interaction.user.username})`, inline: true },
                  { name: 'Channel', value: `<#${channel.id}>`, inline: true },
                )
                .setTimestamp();
              await logChannel.send({ embeds: [logEmbed] });
            }
          } catch (err) {
            logger.warn(`Failed to log help ticket: ${err.message}`);
          }
        }
      } else {
        // Auto-provision a license
        const licenseRes = await fetch(`${config.licensing.apiUrl}/api/v1/licenses`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.licensing.apiKey}`,
          },
          body: JSON.stringify({
            discord_user: interaction.user.username,
            expires_in_days: null,
          }),
        });

        const licenseData = await licenseRes.json();

        if (!licenseRes.ok) {
          logger.error(`License API error during auto-provision: ${licenseRes.status} ${JSON.stringify(licenseData)}`);
          const errorEmbed = new EmbedBuilder()
            .setTitle('License Creation Failed')
            .setDescription(`Hey <@${interaction.user.id}>, there was an error creating your license. An admin will assist you shortly.`)
            .setColor(0xE74C3C)
            .setTimestamp();
          await channel.send({ embeds: [errorEmbed], components: [closeRow] });

          if (settings.ticket_admin_role_id) {
            await channel.send({ content: `<@&${settings.ticket_admin_role_id}>`, allowedMentions: { roles: [settings.ticket_admin_role_id] } });
          }

          await interaction.editReply({ content: `Your ticket has been created: <#${channel.id}>` });
          return;
        }

        // Send license embed
        const licenseEmbed = new EmbedBuilder()
          .setTitle('Your License')
          .setColor(0x2ECC71)
          .addFields(
            { name: 'User', value: `<@${interaction.user.id}> (${interaction.user.username})`, inline: true },
            { name: 'Duration', value: 'Lifetime', inline: true },
            { name: 'License Key', value: `\`\`\`\n${licenseData.license_key}\n\`\`\`` },
          )
          .setTimestamp();

        if (licenseData.expires_at) {
          licenseEmbed.spliceFields(1, 1, { name: 'Duration', value: `Expires ${new Date(licenseData.expires_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`, inline: true });
        }

        const welcomeEmbed = new EmbedBuilder()
          .setTitle('License Created')
          .setDescription(`Hey <@${interaction.user.id}>, your license has been automatically created!\n\n**Make sure to save your license key somewhere safe — this ticket will be closed shortly.**\n\nIf you still need help, press the button below.`)
          .setColor(0x2ECC71)
          .setTimestamp();

        const actionRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`need_help_ticket:${channel.id}`)
            .setLabel('I Need Help')
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId(`close_ticket:${channel.id}`)
            .setLabel('Close Ticket')
            .setStyle(ButtonStyle.Danger),
        );

        await channel.send({ embeds: [welcomeEmbed], components: [actionRow] });

        // Send license key and loader as a separate message
        const channelMsg = { embeds: [licenseEmbed] };

        if (settings.loader_file_name) {
          const loaderPath = path.join(__dirname, '..', '..', '..', 'data', 'loaders', interaction.guild.id, settings.loader_file_name);
          if (fs.existsSync(loaderPath)) {
            channelMsg.files = [new AttachmentBuilder(loaderPath, { name: settings.loader_file_name })];
          } else {
            logger.warn(`Loader file not found at ${loaderPath}`);
          }
        }

        await channel.send(channelMsg);

        await interaction.editReply({ content: `Your license has been created: <#${channel.id}>` });
        logger.info(`License auto-provisioned: channel=${channel.name} user=${interaction.user.username}`);

        // Log to ticket log channel if configured
        if (settings.ticket_log_channel_id) {
          try {
            const logChannel = await interaction.guild.channels.fetch(settings.ticket_log_channel_id);
            if (logChannel) {
              const logEmbed = new EmbedBuilder()
                .setTitle('License Auto-Provisioned')
                .setColor(0x2ECC71)
                .addFields(
                  { name: 'User', value: `<@${interaction.user.id}> (${interaction.user.username})`, inline: true },
                  { name: 'Channel', value: `<#${channel.id}>`, inline: true },
                )
                .setTimestamp();
              await logChannel.send({ embeds: [logEmbed] });
            }
          } catch (err) {
            logger.warn(`Failed to log license provisioning: ${err.message}`);
          }
        }
      }
    } catch (err) {
      logger.error(`Failed to create license ticket: ${err.message}`);
      await interaction.editReply({ content: `Failed to create ticket: ${err.message}` });
    }
    return;
  }

  if (action === 'need_help_ticket') {
    const channelId = params[0];
    const settings = getSettings(interaction.guild.id);

    // Notify the user and ping admins
    await interaction.reply({ content: 'An admin has been notified and will be with you shortly.', flags: MessageFlags.Ephemeral });

    if (settings.ticket_admin_role_id) {
      await interaction.channel.send({ content: `<@&${settings.ticket_admin_role_id}> — <@${interaction.user.id}> needs help in this ticket.`, allowedMentions: { roles: [settings.ticket_admin_role_id], users: [interaction.user.id] } });
    } else {
      await interaction.channel.send({ content: `<@${interaction.user.id}> needs help in this ticket. An admin will assist shortly.` });
    }

    // Disable the help button so it can't be spammed
    try {
      const actionRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`need_help_ticket:${channelId}`)
          .setLabel('I Need Help')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(true),
        new ButtonBuilder()
          .setCustomId(`close_ticket:${channelId}`)
          .setLabel('Close Ticket')
          .setStyle(ButtonStyle.Danger),
      );
      await interaction.message.edit({ components: [actionRow] });
    } catch (err) {
      logger.warn(`Failed to disable help button: ${err.message}`);
    }

    return;
  }

  if (action === 'close_ticket') {
    const channelId = params[0];
    const settings = getSettings(interaction.guild.id);

    // Permission check: admin, ticket admin role, or the ticket owner
    const ticket = getOpenTicketByChannel(channelId);
    if (!ticket) {
      return interaction.reply({ content: 'This ticket is already closed or does not exist.', flags: MessageFlags.Ephemeral });
    }

    const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.Administrator);
    const isTicketAdmin = settings.ticket_admin_role_id && interaction.member.roles.cache.has(settings.ticket_admin_role_id);

    if (!isAdmin && !isTicketAdmin) {
      return interaction.reply({ content: 'Only admins can close tickets.', flags: MessageFlags.Ephemeral });
    }

    // Log transcript before closing
    if (settings.ticket_log_channel_id) {
      try {
        const logChannel = await interaction.guild.channels.fetch(settings.ticket_log_channel_id);
        if (logChannel) {
          // Fetch up to 500 messages in batches of 100
          let allMessages = [];
          let lastId;
          for (let i = 0; i < 5; i++) {
            const opts = { limit: 100 };
            if (lastId) opts.before = lastId;
            const batch = await interaction.channel.messages.fetch(opts);
            if (batch.size === 0) break;
            allMessages.push(...batch.values());
            lastId = batch.last().id;
            if (batch.size < 100) break;
          }
          const transcript = allMessages
            .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
            .map(m => `[${m.createdAt.toISOString()}] ${m.author.username}: ${m.content || '(embed/attachment)'}`)
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

    logger.info(`Ticket closed via button: channel=${interaction.channel.name} closedBy=${interaction.user.username}`);
    return;
  }

  if (action === 'request_hwid_reset') {
    if (!checkCooldown(interaction.user.id, 'hwid_reset')) {
      return interaction.reply({ content: 'Please wait before trying again.', flags: MessageFlags.Ephemeral });
    }

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

  if (action === 'retrieve_license') {
    if (!checkCooldown(interaction.user.id, 'retrieve_license')) {
      return interaction.reply({ content: 'Please wait before trying again.', flags: MessageFlags.Ephemeral });
    }

    const config = require('../../config');
    const settings = getSettings(interaction.guild.id);

    if (!config.licensing.apiUrl || !config.licensing.apiKey) {
      return interaction.reply({ content: 'Licensing system is not configured. Please contact an admin.', flags: MessageFlags.Ephemeral });
    }

    if (!settings.ticket_category_id) {
      return interaction.reply({ content: 'Ticket system is not configured yet. An admin needs to set a ticket category in the dashboard.', flags: MessageFlags.Ephemeral });
    }

    // Check for existing open ticket
    const existing = getOpenTicketByUser(interaction.guild.id, interaction.user.id);
    if (existing) {
      return interaction.reply({ content: `You already have an open ticket: <#${existing.channel_id}>`, flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

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

      const license = list.find(l => l.status === 'active' || l.status === 'suspended');
      if (!license) {
        return interaction.editReply({ content: 'You don\'t have an active license. If you believe this is an error, please contact an admin.' });
      }

      // Create a private ticket channel
      const { ChannelType, PermissionFlagsBits: Perms } = require('discord.js');

      const overwrites = [
        { id: interaction.guild.roles.everyone.id, deny: [Perms.ViewChannel] },
        { id: interaction.user.id, allow: [Perms.ViewChannel, Perms.SendMessages, Perms.ReadMessageHistory] },
        { id: interaction.client.user.id, allow: [Perms.ViewChannel, Perms.SendMessages, Perms.ManageChannels] },
      ];

      if (settings.ticket_admin_role_id) {
        overwrites.push({ id: settings.ticket_admin_role_id, allow: [Perms.ViewChannel, Perms.SendMessages, Perms.ReadMessageHistory] });
      }

      const channel = await interaction.guild.channels.create({
        name: `license-${interaction.user.username}`.slice(0, 100),
        type: ChannelType.GuildText,
        parent: settings.ticket_category_id,
        permissionOverwrites: overwrites,
      });

      createTicket(interaction.guild.id, interaction.user.id, channel.id);

      // Build the license embed
      const licenseEmbed = new EmbedBuilder()
        .setTitle('Your License')
        .setColor(0x2ECC71)
        .addFields(
          { name: 'User', value: `<@${interaction.user.id}> (${interaction.user.username})`, inline: true },
          { name: 'Status', value: license.status.charAt(0).toUpperCase() + license.status.slice(1), inline: true },
          { name: 'License Key', value: `\`\`\`\n${license.license_key}\n\`\`\`` },
        )
        .setTimestamp();

      if (license.expires_at) {
        licenseEmbed.addFields({ name: 'Expires', value: new Date(license.expires_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }), inline: true });
      }

      const closeRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`close_ticket:${channel.id}`)
          .setLabel('Close Ticket')
          .setStyle(ButtonStyle.Danger)
      );

      // Send welcome message
      await channel.send({
        embeds: [
          new EmbedBuilder()
            .setTitle('License Retrieved')
            .setDescription(`Hey <@${interaction.user.id}>, here is your license information. If you need further help, an admin will assist you.`)
            .setColor(0x3498DB)
            .setTimestamp(),
        ],
        components: [closeRow],
      });

      // Send the license key and loader
      const channelMsg = { embeds: [licenseEmbed] };

      if (settings.loader_file_name) {
        const loaderPath = path.join(__dirname, '..', '..', '..', 'data', 'loaders', interaction.guild.id, settings.loader_file_name);
        if (fs.existsSync(loaderPath)) {
          channelMsg.files = [new AttachmentBuilder(loaderPath, { name: settings.loader_file_name })];
        } else {
          logger.warn(`Loader file not found at ${loaderPath}`);
        }
      }

      await channel.send(channelMsg);

      await interaction.editReply({ content: `Your license has been sent in a private channel: <#${channel.id}>` });
      logger.info(`License retrieval ticket created: channel=${channel.name} user=${interaction.user.username}`);

      // Log to ticket log channel if configured
      if (settings.ticket_log_channel_id) {
        try {
          const logChannel = await interaction.guild.channels.fetch(settings.ticket_log_channel_id);
          if (logChannel) {
            const logEmbed = new EmbedBuilder()
              .setTitle('License Retrieved')
              .setColor(0x3498DB)
              .addFields(
                { name: 'User', value: `<@${interaction.user.id}> (${interaction.user.username})`, inline: true },
                { name: 'Channel', value: `<#${channel.id}>`, inline: true },
              )
              .setTimestamp();
            await logChannel.send({ embeds: [logEmbed] });
          }
        } catch (err) {
          logger.warn(`Failed to log license retrieval: ${err.message}`);
        }
      }
    } catch (err) {
      logger.error(`Failed to create license retrieval ticket: ${err.message}`);
      await interaction.editReply({ content: `Failed to retrieve license: ${err.message}` });
    }
    return;
  }

  if (action === 'modactions_page') {
    const targetUserId = params[0];
    let page = parseInt(params[1], 10);
    if (isNaN(page) || page < 1) page = 1;
    const settings = getSettings(interaction.guild.id);

    if (!canViewModActions(interaction.member, settings)) {
      return interaction.reply({ content: 'You do not have permission to view mod actions.', flags: MessageFlags.Ephemeral });
    }

    const { getModActions } = require('../../database/modactions');
    const PAGE_SIZE = 10;
    const offset = (page - 1) * PAGE_SIZE;

    const { rows, total } = getModActions(interaction.guild.id, targetUserId, PAGE_SIZE, offset);
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (page > totalPages) page = totalPages;

    let targetUser;
    try {
      targetUser = await interaction.client.users.fetch(targetUserId);
    } catch {
      targetUser = { id: targetUserId, tag: `Unknown (${targetUserId})`, username: `Unknown (${targetUserId})` };
    }

    const displayName = targetUser.username || `User ${targetUser.id}`;
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
    const reply = { content: 'An error occurred while executing this command.', flags: MessageFlags.Ephemeral };
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
    return interaction.reply({ content: 'HWID reset is not configured. Please contact an admin.', flags: MessageFlags.Ephemeral });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

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

    // Submit the HWID reset
    const resetRes = await fetch(`${config.licensing.apiUrl}/api/v1/hwid-reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.licensing.apiKey}` },
      body: JSON.stringify({
        license_key: license.license_key,
        reason,
      }),
    });

    const resetData = await resetRes.json();

    if (resetRes.ok) {
      await interaction.editReply({ content: `HWID Reset Request received. Please wait until it gets approved by an admin.\n**Reason:** ${reason}` });
      logger.info(`HWID reset for ${interaction.user.username} (license: ${license.license_key.slice(0, 4)}...) reason: ${reason}`);

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
      logger.warn(`HWID reset failed for ${interaction.user.username}: ${errorMsg}`);
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
    return interaction.reply({ content: 'Invalid timeout format. Use e.g. `30s`, `5m`, `1h`, `2d`, `1w`, `1mo`. Max 28 days.', flags: MessageFlags.Ephemeral });
  }

  if (!canWarn(interaction.member, settings)) {
    return interaction.reply({ content: 'You do not have permission to use this command.', flags: MessageFlags.Ephemeral });
  }

  let targetUser;
  try {
    targetUser = await interaction.client.users.fetch(targetUserId);
  } catch {
    return interaction.reply({ content: 'Could not find that user.', flags: MessageFlags.Ephemeral });
  }

  let targetMember;
  try {
    targetMember = await interaction.guild.members.fetch(targetUserId);
  } catch {
    return interaction.reply({ content: 'Could not find that user in this server.', flags: MessageFlags.Ephemeral });
  }

  if (isExempt(targetMember, settings)) {
    return interaction.reply({ content: 'You cannot warn a moderator or someone with a higher role.', flags: MessageFlags.Ephemeral });
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
    const displayName = targetUser.username || `User ${targetUser.id}`;
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
      flags: MessageFlags.Ephemeral,
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
      await member.timeout(timeoutMs, `Warning by ${interaction.user.username}: ${reason}`);
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
    flags: MessageFlags.Ephemeral,
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
    try {
      if (interaction.isAutocomplete()) {
        return await handleAutocomplete(interaction);
      }
      if (interaction.isChatInputCommand() || interaction.isContextMenuCommand()) {
        return await handleCommand(interaction);
      }
      if (interaction.isButton()) {
        return await handleButton(interaction);
      }
      if (interaction.isModalSubmit()) {
        return await handleModalSubmit(interaction);
      }
    } catch (err) {
      logger.error(`Unhandled interaction error (${interaction.type}):`, err);
      try {
        if (!interaction.isAutocomplete() && !interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: 'An unexpected error occurred.', flags: MessageFlags.Ephemeral });
        }
      } catch {
        // Interaction expired or already responded
      }
    }
  },
};
