const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, ChannelType, MessageFlags } = require('discord.js');
const logger = require('../../logger');
const { getWarnings, getWarningCount, addWarning } = require('../../database/warnings');
const { getSettings } = require('../../database/settings');
const { addModAction } = require('../../database/modactions');
const { canWarn, canBan, isExempt, isModerator, canViewModActions } = require('../utils/permissions');
const { storePendingAction, consumePendingAction } = require('../utils/pendingActions');
const { buildWarningsEmbed } = require('../utils/embeds');
const { parseDuration, formatDuration } = require('../utils/parseDuration');
const { getOpenThreadByChannel, closeThread } = require('../../database/modmail');
const { getRoleOptions } = require('../../database/selfRoles');
const { addTempBan } = require('../../database/tempbans');
const { createAppeal, getOpenAppeal, getAppealById, getAppealByChannel, resolveAppeal } = require('../../database/appeals');

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

async function sendBanDM(client, guild, targetId, reason, duration, settings) {
  try {
    const targetUser = await client.users.fetch(targetId);
    const dmEmbed = new EmbedBuilder()
      .setTitle('You have been banned')
      .setColor(0xFF0000)
      .setDescription(`You have been banned from **${guild.name}**.`)
      .addFields(
        { name: 'Reason', value: reason || 'No reason provided' },
        { name: 'Expires', value: duration || 'Never' },
      )
      .setTimestamp();

    const dmComponents = [];
    if (settings.appeal_enabled && settings.appeal_category_id) {
      dmComponents.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`ban_appeal:${guild.id}`)
          .setLabel('Appeal Ban')
          .setStyle(ButtonStyle.Primary),
      ));
    }

    if (settings.server_invite_code) {
      dmEmbed.addFields({
        name: 'Rejoin After Ban',
        value: `If your ban is lifted, you can rejoin using: https://discord.gg/${settings.server_invite_code}`,
      });
    }

    await targetUser.send({ embeds: [dmEmbed], components: dmComponents });
  } catch (err) {
    logger.warn(`Failed to DM banned user: ${err.message}`);
  }
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
      // DM the banned user BEFORE banning (after ban, bot and user share no guilds)
      await sendBanDM(interaction.client, interaction.guild, pending.targetId, pending.reason, null, settings);

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
      // DM the banned user BEFORE banning (after ban, bot and user share no guilds)
      await sendBanDM(interaction.client, interaction.guild, pending.targetId, pending.reason, pending.duration ? `${pending.duration} day(s)` : null, banSettings);

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

      // Record temp ban if duration was specified
      if (pending.duration) {
        try {
          addTempBan(interaction.guild.id, pending.targetId, interaction.user.id, pending.reason, pending.duration);
        } catch (err) {
          logger.warn(`Failed to record temp ban: ${err.message}`);
        }
      }

      const durationText = pending.duration ? `${pending.duration} day(s)` : 'Permanent';
      await interaction.update({
        content: `<@${pending.targetId}> has been banned.\n**Reason:** ${pending.reason}\n**Duration:** ${durationText}`,
        embeds: [],
        components: [],
      });

      // Post public message in channel
      try {
        await interaction.channel.send({
          content: `<@${pending.targetId}> has been banned from the server.` + (pending.duration ? `\n**Duration:** ${durationText}` : ''),
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
            const logFields = [
              { name: 'User', value: `<@${pending.targetId}> (${pending.targetId})`, inline: true },
              { name: 'Banned by', value: `<@${interaction.user.id}>`, inline: true },
              { name: 'Total Warnings', value: `${warnings.length}`, inline: true },
              { name: 'Reason', value: pending.reason },
              { name: 'Duration', value: durationText, inline: true },
              { name: 'Messages Deleted', value: `${pending.deleteMessageDays || 0} day(s)`, inline: true },
            ];
            if (pending.duration) {
              const expiresAt = new Date(Date.now() + pending.duration * 24 * 60 * 60 * 1000);
              logFields.push({ name: 'Expires', value: `<t:${Math.floor(expiresAt.getTime() / 1000)}:F>`, inline: true });
            }
            const logEmbed = new EmbedBuilder()
              .setTitle(pending.duration ? 'User Temporarily Banned' : 'User Banned')
              .setColor(pending.duration ? 0xFF8C00 : 0xFF0000)
              .addFields(...logFields)
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

  if (action === 'selfrole') {
    const panelId = parseInt(params[0], 10);
    const roleId = params[1];

    if (!panelId || !roleId) {
      return interaction.reply({ content: 'Invalid self-role button.', flags: MessageFlags.Ephemeral });
    }

    try {
      const member = interaction.member;
      const role = interaction.guild.roles.cache.get(roleId);

      if (!role) {
        return interaction.reply({ content: 'This role no longer exists. An admin should refresh the panel.', flags: MessageFlags.Ephemeral });
      }

      // Check bot can manage this role
      const botMember = interaction.guild.members.me;
      if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
        return interaction.reply({ content: 'I don\'t have permission to manage roles.', flags: MessageFlags.Ephemeral });
      }

      if (role.position >= botMember.roles.highest.position) {
        return interaction.reply({ content: 'I can\'t assign this role because it\'s above my highest role.', flags: MessageFlags.Ephemeral });
      }

      if (member.roles.cache.has(roleId)) {
        await member.roles.remove(roleId);
        return interaction.reply({ content: `Removed **${role.name}**`, flags: MessageFlags.Ephemeral });
      } else {
        await member.roles.add(roleId);
        return interaction.reply({ content: `Added **${role.name}**`, flags: MessageFlags.Ephemeral });
      }
    } catch (err) {
      logger.error(`Failed to toggle self-role: ${err.message}`);
      return interaction.reply({ content: `Failed to toggle role: ${err.message}`, flags: MessageFlags.Ephemeral });
    }
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

  // ─── Ban Appeal Handlers ───

  if (action === 'ban_appeal') {
    const guildId = params[0];
    if (!guildId) {
      return interaction.reply({ content: 'Invalid appeal request.', flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const guild = await interaction.client.guilds.fetch(guildId);
      if (!guild) {
        return interaction.editReply({ content: 'Could not find that server.' });
      }

      const appealSettings = getSettings(guildId);
      if (!appealSettings.appeal_enabled || !appealSettings.appeal_category_id) {
        return interaction.editReply({ content: 'Ban appeals are not enabled on that server.' });
      }

      // Check if user is actually banned
      try {
        await guild.bans.fetch(interaction.user.id);
      } catch {
        return interaction.editReply({ content: 'You are not currently banned from that server.' });
      }

      // Check for existing open appeal
      const existingAppeal = getOpenAppeal(guildId, interaction.user.id);
      if (existingAppeal) {
        return interaction.editReply({ content: 'You already have a pending appeal for that server. Please wait for a moderator to review it.' });
      }

      // Get the ban reason from the guild
      let banReason = 'No reason provided';
      try {
        const banInfo = await guild.bans.fetch(interaction.user.id);
        if (banInfo.reason) banReason = banInfo.reason;
      } catch {
        // Could not fetch ban info
      }



      // Build permission overwrites for the appeal channel
      const overwrites = [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: interaction.client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages] },
      ];

      if (appealSettings.moderator_role_id) {
        overwrites.push({ id: appealSettings.moderator_role_id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
      }

      const channel = await guild.channels.create({
        name: `appeal-${interaction.user.username}`.slice(0, 100),
        type: ChannelType.GuildText,
        parent: appealSettings.appeal_category_id,
        permissionOverwrites: overwrites,
      });

      // Record appeal in database
      const appealId = createAppeal(guildId, interaction.user.id, channel.id, banReason);

      // Build the appeal info embed
      const accountCreated = interaction.user.createdAt;
      const appealEmbed = new EmbedBuilder()
        .setTitle('Ban Appeal')
        .setColor(0xFFA500)
        .setThumbnail(interaction.user.displayAvatarURL({ dynamic: true, size: 128 }))
        .addFields(
          { name: 'User', value: `${interaction.user.username} (${interaction.user.id})`, inline: true },
          { name: 'Account Created', value: `<t:${Math.floor(accountCreated.getTime() / 1000)}:R>`, inline: true },
          { name: 'Ban Reason', value: banReason },
        )
        .setTimestamp();

      const appealRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`appeal_accept:${appealId}`)
          .setLabel('Accept (Unban)')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`appeal_reject:${appealId}`)
          .setLabel('Reject')
          .setStyle(ButtonStyle.Danger),
      );

      await channel.send({ embeds: [appealEmbed], components: [appealRow] });

      // Ping the moderator role
      if (appealSettings.moderator_role_id) {
        await channel.send({
          content: `<@&${appealSettings.moderator_role_id}> — A new ban appeal has been submitted.`,
          allowedMentions: { roles: [appealSettings.moderator_role_id] },
        });
      }

      // Disable the appeal button in the DM message
      try {
        const disabledRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`ban_appeal:${guildId}`)
            .setLabel('Appeal Submitted')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(true),
        );
        await interaction.message.edit({ components: [disabledRow] });
      } catch {
        // May fail if message is too old
      }

      await interaction.editReply({ content: 'Your ban appeal has been submitted. A moderator will review it shortly.' });
      logger.info(`Ban appeal created: user=${interaction.user.username} guild=${guild.name} appealId=${appealId}`);
    } catch (err) {
      logger.error(`Failed to create ban appeal: ${err.message}`);
      await interaction.editReply({ content: `Failed to submit appeal: ${err.message}` });
    }
    return;
  }

  if (action === 'appeal_accept') {
    const appealId = parseInt(params[0], 10);
    if (isNaN(appealId)) {
      return interaction.reply({ content: 'Invalid appeal.', flags: MessageFlags.Ephemeral });
    }

    const appeal = getAppealById(appealId);
    if (!appeal) {
      return interaction.reply({ content: 'This appeal no longer exists.', flags: MessageFlags.Ephemeral });
    }

    if (appeal.status !== 'pending') {
      return interaction.reply({ content: `This appeal has already been ${appeal.status}.`, flags: MessageFlags.Ephemeral });
    }

    // Check moderator permissions
    const appealSettings = getSettings(appeal.guild_id);
    if (!isModerator(interaction.member, appealSettings)) {
      return interaction.reply({ content: 'Only moderators can handle appeals.', flags: MessageFlags.Ephemeral });
    }

    try {
      // Unban the user
      await interaction.guild.bans.remove(appeal.user_id, `Appeal accepted by ${interaction.user.username}`);

      // Update database
      resolveAppeal(appealId, interaction.user.id, 'accepted');

      try {
        addModAction(appeal.guild_id, interaction.user.id, 'appeal_accept', appeal.user_id, `Ban appeal accepted`);
      } catch (err) {
        logger.warn(`Failed to log appeal accept mod action: ${err.message}`);
      }

      // DM the user
      try {
        const user = await interaction.client.users.fetch(appeal.user_id);
        const dmEmbed = new EmbedBuilder()
          .setTitle('Ban Appeal Accepted')
          .setColor(0x2ECC71)
          .setDescription(`Your ban appeal for **${interaction.guild.name}** has been accepted. You have been unbanned.`)
          .setTimestamp();

        if (appealSettings.server_invite_code) {
          dmEmbed.addFields({
            name: 'Rejoin',
            value: `You can rejoin using: https://discord.gg/${appealSettings.server_invite_code}`,
          });
        }

        await user.send({ embeds: [dmEmbed] });
      } catch (err) {
        logger.warn(`Failed to DM user about appeal acceptance: ${err.message}`);
      }

      // Log to ban log channel
      if (appealSettings.ban_log_channel_id) {
        try {
          const logChannel = await interaction.guild.channels.fetch(appealSettings.ban_log_channel_id);
          if (logChannel) {
            const logEmbed = new EmbedBuilder()
              .setTitle('Ban Appeal Accepted')
              .setColor(0x2ECC71)
              .addFields(
                { name: 'User', value: `<@${appeal.user_id}> (${appeal.user_id})`, inline: true },
                { name: 'Accepted by', value: `<@${interaction.user.id}>`, inline: true },
                { name: 'Original Ban Reason', value: appeal.reason || 'No reason provided' },
              )
              .setTimestamp();
            await logChannel.send({ embeds: [logEmbed] });
          }
        } catch (err) {
          logger.warn(`Failed to log appeal acceptance: ${err.message}`);
        }
      }

      await interaction.update({
        embeds: [
          new EmbedBuilder()
            .setTitle('Appeal Accepted')
            .setDescription(`This appeal was accepted by <@${interaction.user.id}>. The user has been unbanned.\nThis channel will be deleted in 5 seconds.`)
            .setColor(0x2ECC71)
            .setTimestamp(),
        ],
        components: [],
      });

      // Delete channel after 5 seconds
      setTimeout(async () => {
        try {
          await interaction.channel.delete('Appeal accepted');
        } catch (err) {
          logger.warn(`Failed to delete appeal channel: ${err.message}`);
        }
      }, 5000);

      logger.info(`Appeal accepted: appealId=${appealId} user=${appeal.user_id} moderator=${interaction.user.username}`);
    } catch (err) {
      logger.error(`Failed to accept appeal: ${err.message}`);
      await interaction.reply({ content: `Failed to accept appeal: ${err.message}`, flags: MessageFlags.Ephemeral });
    }
    return;
  }

  if (action === 'appeal_reject') {
    const appealId = parseInt(params[0], 10);
    if (isNaN(appealId)) {
      return interaction.reply({ content: 'Invalid appeal.', flags: MessageFlags.Ephemeral });
    }

    const appeal = getAppealById(appealId);
    if (!appeal) {
      return interaction.reply({ content: 'This appeal no longer exists.', flags: MessageFlags.Ephemeral });
    }

    if (appeal.status !== 'pending') {
      return interaction.reply({ content: `This appeal has already been ${appeal.status}.`, flags: MessageFlags.Ephemeral });
    }

    // Check moderator permissions
    const appealSettings = getSettings(appeal.guild_id);
    if (!isModerator(interaction.member, appealSettings)) {
      return interaction.reply({ content: 'Only moderators can handle appeals.', flags: MessageFlags.Ephemeral });
    }

    try {
      // Update database
      resolveAppeal(appealId, interaction.user.id, 'rejected');

      try {
        addModAction(appeal.guild_id, interaction.user.id, 'appeal_reject', appeal.user_id, `Ban appeal rejected`);
      } catch (err) {
        logger.warn(`Failed to log appeal reject mod action: ${err.message}`);
      }

      // DM the user
      try {
        const user = await interaction.client.users.fetch(appeal.user_id);
        const dmEmbed = new EmbedBuilder()
          .setTitle('Ban Appeal Rejected')
          .setColor(0xE74C3C)
          .setDescription(`Your ban appeal for **${interaction.guild.name}** has been rejected.`)
          .setTimestamp();
        await user.send({ embeds: [dmEmbed] });
      } catch (err) {
        logger.warn(`Failed to DM user about appeal rejection: ${err.message}`);
      }

      // Log to ban log channel
      if (appealSettings.ban_log_channel_id) {
        try {
          const logChannel = await interaction.guild.channels.fetch(appealSettings.ban_log_channel_id);
          if (logChannel) {
            const logEmbed = new EmbedBuilder()
              .setTitle('Ban Appeal Rejected')
              .setColor(0xE74C3C)
              .addFields(
                { name: 'User', value: `<@${appeal.user_id}> (${appeal.user_id})`, inline: true },
                { name: 'Rejected by', value: `<@${interaction.user.id}>`, inline: true },
                { name: 'Original Ban Reason', value: appeal.reason || 'No reason provided' },
              )
              .setTimestamp();
            await logChannel.send({ embeds: [logEmbed] });
          }
        } catch (err) {
          logger.warn(`Failed to log appeal rejection: ${err.message}`);
        }
      }

      await interaction.update({
        embeds: [
          new EmbedBuilder()
            .setTitle('Appeal Rejected')
            .setDescription(`This appeal was rejected by <@${interaction.user.id}>.\nThis channel will be deleted in 5 seconds.`)
            .setColor(0xE74C3C)
            .setTimestamp(),
        ],
        components: [],
      });

      // Delete channel after 5 seconds
      setTimeout(async () => {
        try {
          await interaction.channel.delete('Appeal rejected');
        } catch (err) {
          logger.warn(`Failed to delete appeal channel: ${err.message}`);
        }
      }, 5000);

      logger.info(`Appeal rejected: appealId=${appealId} user=${appeal.user_id} moderator=${interaction.user.username}`);
    } catch (err) {
      logger.error(`Failed to reject appeal: ${err.message}`);
      await interaction.reply({ content: `Failed to reject appeal: ${err.message}`, flags: MessageFlags.Ephemeral });
    }
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

async function handleModalSubmit(interaction) {
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
