const logger = require('../../logger');
const { getSettings, getExemptChannels } = require('../../database/settings');
const { cacheMessage, getRecentMessages, deleteMessage } = require('../../database/messages');
const { addWarning, getWarningCount } = require('../../database/warnings');
const { getSimilarity, normalizeMessage, MIN_MESSAGE_LENGTH } = require('../utils/similarity');
const { isExempt } = require('../utils/permissions');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ChannelType, PermissionFlagsBits } = require('discord.js');
const { db } = require('../../database/db');
const { createThread, getOpenThread, getOpenThreadByChannel, closeThread } = require('../../database/modmail');

let addIncidentStmt;
let countRecentIncidentsStmt;

function getIncidentStmts() {
  if (!addIncidentStmt) {
    addIncidentStmt = db.prepare(
      `INSERT INTO crosspost_incidents (guild_id, user_id, original_channel_id, original_message_content, crosspost_channel_id, crosspost_message_content, similarity_score, action_taken) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    countRecentIncidentsStmt = db.prepare(
      `SELECT COUNT(*) as count FROM crosspost_incidents WHERE guild_id = ? AND user_id = ? AND created_at > datetime('now', '-' || ? || ' hours')`
    );
  }
  return { addIncidentStmt, countRecentIncidentsStmt };
}

async function handleDM(message) {
  const client = message.client;

  // Find a guild where the user is a member and modmail is enabled
  let targetGuild = null;
  let targetSettings = null;

  for (const [, guild] of client.guilds.cache) {
    const settings = getSettings(guild.id);
    if (!settings.modmail_enabled || !settings.modmail_category_id) continue;

    try {
      await guild.members.fetch(message.author.id);
      targetGuild = guild;
      targetSettings = settings;
      break;
    } catch {
      // User not in this guild, try next
      continue;
    }
  }

  if (!targetGuild) return;

  // Check if user already has an open thread
  const existingThread = getOpenThread(targetGuild.id, message.author.id);

  if (existingThread) {
    // Relay message to existing modmail channel
    try {
      const channel = await targetGuild.channels.fetch(existingThread.channel_id);
      if (channel) {
        const embed = new EmbedBuilder()
          .setAuthor({
            name: message.author.tag || message.author.username,
            iconURL: message.author.displayAvatarURL(),
          })
          .setDescription(message.content || '*No text content*')
          .setColor(0x3498DB)
          .setTimestamp();

        // Include attachments if any
        if (message.attachments.size > 0) {
          const attachmentList = message.attachments.map(a => `[${a.name}](${a.url})`).join('\n');
          embed.addFields({ name: 'Attachments', value: attachmentList });
        }

        await channel.send({ embeds: [embed] });
        await message.react('\u2709\uFE0F');
      } else {
        // Channel was deleted, close the thread
        closeThread(existingThread.id, client.user.id);
        logger.warn(`Modmail channel ${existingThread.channel_id} not found, closed thread ${existingThread.id}`);
      }
    } catch (err) {
      logger.error(`Failed to relay DM to modmail channel: ${err.message}`);
    }
    return;
  }

  // Create a new modmail thread
  try {
    const category = await targetGuild.channels.fetch(targetSettings.modmail_category_id);
    if (!category) {
      logger.warn(`Modmail category ${targetSettings.modmail_category_id} not found in guild ${targetGuild.id}`);
      return;
    }

    const displayName = message.author.tag || message.author.username;
    const channelName = `modmail-${message.author.username.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;

    const modmailChannel = await targetGuild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: category.id,
      topic: `Modmail thread for ${displayName} (${message.author.id})`,
      permissionOverwrites: [
        {
          id: targetGuild.roles.everyone.id,
          deny: [PermissionFlagsBits.ViewChannel],
        },
        {
          id: client.user.id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels],
        },
      ],
    });

    // If a moderator role is set, give it access
    if (targetSettings.moderator_role_id) {
      try {
        await modmailChannel.permissionOverwrites.create(targetSettings.moderator_role_id, {
          ViewChannel: true,
          SendMessages: true,
        });
      } catch (err) {
        logger.warn(`Failed to set mod role permissions on modmail channel: ${err.message}`);
      }
    }

    // Save to database
    createThread(targetGuild.id, message.author.id, modmailChannel.id);

    // Send initial message with user info and close button
    let member;
    try {
      member = await targetGuild.members.fetch(message.author.id);
    } catch {
      member = null;
    }

    const infoEmbed = new EmbedBuilder()
      .setTitle('New Modmail Thread')
      .setColor(0x2ECC71)
      .setThumbnail(message.author.displayAvatarURL())
      .addFields(
        { name: 'User', value: `<@${message.author.id}> (${displayName})`, inline: true },
        { name: 'User ID', value: message.author.id, inline: true },
        { name: 'Account Created', value: `<t:${Math.floor(message.author.createdTimestamp / 1000)}:R>`, inline: true },
      )
      .setTimestamp();

    if (member) {
      infoEmbed.addFields(
        { name: 'Joined Server', value: `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>`, inline: true },
        { name: 'Roles', value: member.roles.cache.filter(r => r.id !== targetGuild.id).map(r => `<@&${r.id}>`).join(', ') || 'None', inline: false },
      );
    }

    const closeButton = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`modmail_close:${modmailChannel.id}`)
        .setLabel('Close Thread')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('\uD83D\uDD12'),
    );

    await modmailChannel.send({ embeds: [infoEmbed], components: [closeButton] });

    // Send the user's message
    const msgEmbed = new EmbedBuilder()
      .setAuthor({
        name: displayName,
        iconURL: message.author.displayAvatarURL(),
      })
      .setDescription(message.content || '*No text content*')
      .setColor(0x3498DB)
      .setTimestamp();

    if (message.attachments.size > 0) {
      const attachmentList = message.attachments.map(a => `[${a.name}](${a.url})`).join('\n');
      msgEmbed.addFields({ name: 'Attachments', value: attachmentList });
    }

    await modmailChannel.send({ embeds: [msgEmbed] });

    // Confirm to user
    await message.author.send({
      embeds: [
        new EmbedBuilder()
          .setTitle('Modmail Received')
          .setDescription(`Your message has been sent to the moderators of **${targetGuild.name}**. They will respond here shortly.`)
          .setColor(0x2ECC71)
          .setTimestamp(),
      ],
    });

    await message.react('\u2709\uFE0F');
    logger.info(`New modmail thread created: user=${displayName} guild=${targetGuild.name} channel=${modmailChannel.id}`);
  } catch (err) {
    logger.error(`Failed to create modmail thread: ${err.message}`);
    try {
      await message.author.send('Sorry, I was unable to create a modmail thread. Please try again later or contact a moderator directly.');
    } catch {
      // Can't DM user
    }
  }
}

async function handleModmailReply(message) {
  const thread = getOpenThreadByChannel(message.channel.id);
  if (!thread) return false;

  // This is a modmail channel - relay the mod's message to the user
  try {
    const user = await message.client.users.fetch(thread.user_id);
    const displayName = message.member?.displayName || message.author.tag || message.author.username;

    const embed = new EmbedBuilder()
      .setAuthor({
        name: displayName,
        iconURL: message.author.displayAvatarURL(),
      })
      .setDescription(message.content || '*No text content*')
      .setColor(0xE67E22)
      .setFooter({ text: message.guild.name, iconURL: message.guild.iconURL() })
      .setTimestamp();

    if (message.attachments.size > 0) {
      const attachmentList = message.attachments.map(a => `[${a.name}](${a.url})`).join('\n');
      embed.addFields({ name: 'Attachments', value: attachmentList });
    }

    await user.send({ embeds: [embed] });
    await message.react('\u2705');
  } catch (err) {
    logger.warn(`Failed to relay mod reply to user: ${err.message}`);
    await message.react('\u274C');
    try {
      await message.channel.send({
        content: `Failed to send message to user: ${err.message}. They may have DMs disabled or have left the server.`,
      });
    } catch {
      // Can't send in channel either
    }
  }

  return true;
}

module.exports = {
  name: 'messageCreate',
  async execute(message) {
    if (message.author.bot) return;

    // Handle DMs for modmail
    if (!message.guild) {
      await handleDM(message);
      return;
    }

    // Check if this is a message in a modmail channel (mod replying)
    if (message.guild) {
      const settings = getSettings(message.guild.id);
      if (settings.modmail_enabled && settings.modmail_category_id) {
        if (message.channel.parentId === settings.modmail_category_id) {
          const handled = await handleModmailReply(message);
          if (handled) return;
        }
      }
    }

    if (!message.content) return;

    const normalized = normalizeMessage(message.content);
    if (normalized.length < MIN_MESSAGE_LENGTH) return;

    const guildId = message.guild.id;
    const settings = getSettings(guildId);
    const exemptChannels = getExemptChannels(guildId);

    if (exemptChannels.includes(message.channel.id)) {
      cacheMessage(guildId, message.channel.id, message.author.id, message.id, message.content);
      return;
    }

    let member = message.member;
    if (!member) {
      try {
        member = await message.guild.members.fetch(message.author.id);
      } catch {
        return;
      }
    }

    if (isExempt(member, settings)) {
      cacheMessage(guildId, message.channel.id, message.author.id, message.id, message.content);
      return;
    }

    const detectionSeconds = settings.crosspost_detection_seconds || 30;
    const repeatOffenseHours = settings.crosspost_window_hours || 48;
    const threshold = settings.crosspost_threshold || 80;

    const recentMessages = getRecentMessages(guildId, message.author.id, message.channel.id, detectionSeconds);

    let bestMatch = null;
    let bestScore = 0;

    for (const cached of recentMessages) {
      const score = getSimilarity(message.content, cached.content);
      if (score >= threshold && score > bestScore) {
        bestMatch = cached;
        bestScore = score;
      }
    }

    // Cache the message regardless
    cacheMessage(guildId, message.channel.id, message.author.id, message.id, message.content);

    if (!bestMatch) return;

    logger.info(`Crosspost detected: user=${message.author.tag} guild=${guildId} similarity=${bestScore.toFixed(1)}% channel1=${bestMatch.channel_id} channel2=${message.channel.id}`);

    // Delete both messages
    try {
      await message.delete();
    } catch (err) {
      logger.warn(`Failed to delete crosspost message: ${err.message}`);
    }

    try {
      const originalChannel = await message.guild.channels.fetch(bestMatch.channel_id);
      if (originalChannel) {
        const originalMessage = await originalChannel.messages.fetch(bestMatch.message_id);
        if (originalMessage) {
          await originalMessage.delete();
        }
      }
    } catch (err) {
      logger.warn(`Failed to delete original message: ${err.message}`);
    }

    // Remove both from cache
    deleteMessage(message.id);
    deleteMessage(bestMatch.message_id);

    // Record this incident first
    const { addIncidentStmt: addInc, countRecentIncidentsStmt: countInc } = getIncidentStmts();

    // Check how many PREVIOUS incidents this user had in the window (before recording this one)
    const previousIncidentCount = countInc.get(guildId, message.author.id, repeatOffenseHours).count;

    if (previousIncidentCount > 0) {
      // This is a repeat offense (they already crossposted before within the window)
      addInc.run(
        guildId, message.author.id,
        bestMatch.channel_id, bestMatch.content,
        message.channel.id, message.content,
        bestScore, 'warned'
      );

      addWarning(guildId, message.author.id, message.client.user.id, `Repeated crossposting between channels (similarity: ${bestScore.toFixed(1)}%)`, 'crosspost');
      const warningCount = getWarningCount(guildId, message.author.id);

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`view_warnings:${message.author.id}`)
          .setLabel('View reason')
          .setStyle(ButtonStyle.Secondary)
      );

      const repeatMsg = settings.crosspost_repeat_message
        ? settings.crosspost_repeat_message.replace(/\{user\}/g, `<@${message.author.id}>`).replace(/\{count\}/g, warningCount)
        : `<@${message.author.id}>, you have repeatedly crossposted the same message across multiple channels. This is an **official warning** (warning #${warningCount}). Continued violations may result in a ban.\nPlease review the channel list and post in the most appropriate channel moving forward.`;

      try {
        await message.channel.send({
          content: repeatMsg,
          components: [row],
        });
      } catch (err) {
        logger.warn(`Failed to send warning message: ${err.message}`);
      }
    } else {
      // First offense in this window
      addInc.run(
        guildId, message.author.id,
        bestMatch.channel_id, bestMatch.content,
        message.channel.id, message.content,
        bestScore, 'deleted'
      );

      const firstMsg = settings.crosspost_first_message
        ? settings.crosspost_first_message.replace(/\{user\}/g, `<@${message.author.id}>`)
        : `<@${message.author.id}>, please do not crosspost the same message across multiple channels. Use the channel that best fits your topic. Duplicate messages have been removed.`;

      try {
        await message.channel.send({
          content: firstMsg,
        });
      } catch (err) {
        logger.warn(`Failed to send notification message: ${err.message}`);
      }
    }
  },
};
