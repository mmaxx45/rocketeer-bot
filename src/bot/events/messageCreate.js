const logger = require('../../logger');
const { getSettings, getExemptChannels } = require('../../database/settings');
const { cacheMessage, getRecentMessages, deleteMessage } = require('../../database/messages');
const { addWarning, getWarningCount } = require('../../database/warnings');
const { getSimilarity, normalizeMessage, MIN_MESSAGE_LENGTH } = require('../utils/similarity');
const { isExempt } = require('../utils/permissions');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { db } = require('../../database/db');

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

module.exports = {
  name: 'messageCreate',
  async execute(message) {
    if (message.author.bot) return;
    if (!message.guild) return;
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
