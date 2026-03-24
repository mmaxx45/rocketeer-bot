const logger = require('../../logger');
const { getSettings } = require('../../database/settings');
const { addWarning, getWarningCount } = require('../../database/warnings');
const { addModAction } = require('../../database/modactions');
const { isExempt } = require('../utils/permissions');
const { getExemptChannels } = require('../../database/settings');
const { checkMessage } = require('../utils/wordFilter');
const { getFilterWords, addFilterViolation, getRecentViolations } = require('../../database/wordFilter');
const { parseBannedDomains, checkForBannedLinks } = require('../utils/linkFilter');
const { EmbedBuilder } = require('discord.js');

module.exports = {
  name: 'messageUpdate',
  async execute(oldMessage, newMessage) {
    // Fetch partial messages if needed
    if (oldMessage.partial) {
      try {
        oldMessage = await oldMessage.fetch();
      } catch {
        // Can't fetch old message — proceed and treat as changed
      }
    }
    if (newMessage.partial) {
      try {
        newMessage = await newMessage.fetch();
      } catch {
        return;
      }
    }

    // Ignore bot messages and DMs
    if (!newMessage.guild) return;
    if (newMessage.author?.bot) return;
    if (!newMessage.content) return;

    // If content hasn't changed, skip
    if (oldMessage.content === newMessage.content) return;

    const guildId = newMessage.guild.id;
    const settings = getSettings(guildId);

    // Fetch member for exempt check
    let member = newMessage.member;
    if (!member) {
      try {
        member = await newMessage.guild.members.fetch(newMessage.author.id);
      } catch {
        return;
      }
    }

    if (isExempt(member, settings)) return;

    // Check exempt channels
    const exemptChannels = getExemptChannels(guildId);
    if (exemptChannels.includes(newMessage.channel.id)) return;

    // Check for banned links in edited message
    const bannedDomains = parseBannedDomains(settings.banned_domains);
    if (bannedDomains.length > 0) {
      const matchedDomain = checkForBannedLinks(newMessage.content, bannedDomains);
      if (matchedDomain) {
        logger.info(`Banned link detected in edit: user=${newMessage.author.username} guild=${guildId} domain=${matchedDomain}`);
        try {
          await newMessage.delete();
        } catch (err) {
          logger.warn(`Failed to delete edited message with banned link: ${err.message}`);
        }
        if (settings.warn_log_channel_id) {
          try {
            const logChannel = await newMessage.guild.channels.fetch(settings.warn_log_channel_id);
            if (logChannel) {
              await logChannel.send({
                embeds: [
                  new EmbedBuilder()
                    .setTitle('Banned Link Deleted (Edit)')
                    .setColor(0xFF4444)
                    .addFields(
                      { name: 'User', value: `<@${newMessage.author.id}> (${newMessage.author.id})`, inline: true },
                      { name: 'Channel', value: `<#${newMessage.channel.id}>`, inline: true },
                      { name: 'Matched Domain', value: matchedDomain, inline: true },
                    )
                    .setTimestamp(),
                ],
              });
            }
          } catch (err) {
            logger.warn(`Failed to log banned link edit: ${err.message}`);
          }
        }
        return;
      }
    }

    // Word filter
    if (!settings.filter_enabled) return;

    const filterWords = getFilterWords(guildId);
    if (filterWords.length === 0) return;

    const matches = checkMessage(newMessage.content, filterWords);
    if (matches.length === 0) return;

    const match = matches[0];

    // Delete the edited message
    try {
      await newMessage.delete();
    } catch (err) {
      logger.warn(`Failed to delete filtered edited message: ${err.message}`);
    }

    // Log violation
    addFilterViolation(guildId, newMessage.author.id, match.word, match.tier, newMessage.content, newMessage.channel.id);

    logger.info(`Word filter triggered on edit: user=${newMessage.author.username} guild=${guildId} word=${match.word} tier=${match.tier}`);

    if (match.tier === 'hard') {
      // Hard slur: auto-warn + log + DM
      addWarning(guildId, newMessage.author.id, newMessage.client.user.id, `Automatic warning: used a prohibited word in edited message (hard filter)`, 'manual', newMessage.content);
      const warningCount = getWarningCount(guildId, newMessage.author.id);

      try {
        addModAction(guildId, newMessage.client.user.id, 'filter_warn', newMessage.author.id, `Hard filter triggered on edit: "${match.word}"`);
      } catch (err) {
        logger.warn(`Failed to log filter mod action: ${err.message}`);
      }

      // DM the user
      try {
        await newMessage.author.send({
          embeds: [
            new EmbedBuilder()
              .setTitle('Edited Message Removed')
              .setColor(0xFF0000)
              .setDescription(`Your edited message in **${newMessage.guild.name}** was removed because it contained a prohibited word. You have received an automatic warning (warning #${warningCount}).`)
              .setTimestamp(),
          ],
        });
      } catch {
        // Can't DM user
      }

      // Log to warn channel
      if (settings.warn_log_channel_id) {
        try {
          const logChannel = await newMessage.guild.channels.fetch(settings.warn_log_channel_id);
          if (logChannel) {
            const logEmbed = new EmbedBuilder()
              .setTitle('Word Filter - Hard Slur in Edited Message')
              .setColor(0xFF0000)
              .addFields(
                { name: 'User', value: `<@${newMessage.author.id}> (${newMessage.author.id})`, inline: true },
                { name: 'Channel', value: `<#${newMessage.channel.id}>`, inline: true },
                { name: 'Matched Word', value: `||${match.word}||`, inline: true },
                { name: 'Action', value: `Message deleted + Warning #${warningCount} issued`, inline: false },
                { name: 'Note', value: 'Detected in a message edit', inline: false },
              )
              .setTimestamp();
            await logChannel.send({ embeds: [logEmbed] });
          }
        } catch (err) {
          logger.warn(`Failed to post filter log: ${err.message}`);
        }
      }
    } else if (match.tier === 'soft') {
      const windowMinutes = settings.soft_slur_window_minutes || 60;
      const threshold = settings.soft_slur_threshold || 3;
      const recentCount = getRecentViolations(guildId, newMessage.author.id, windowMinutes);

      if (settings.warn_log_channel_id) {
        try {
          const logChannel = await newMessage.guild.channels.fetch(settings.warn_log_channel_id);
          if (logChannel) {
            const logEmbed = new EmbedBuilder()
              .setTitle('Word Filter - Soft Slur in Edited Message')
              .setColor(0xFFA500)
              .addFields(
                { name: 'User', value: `<@${newMessage.author.id}> (${newMessage.author.id})`, inline: true },
                { name: 'Channel', value: `<#${newMessage.channel.id}>`, inline: true },
                { name: 'Matched Word', value: `||${match.word}||`, inline: true },
                { name: 'Action', value: 'Message deleted silently', inline: false },
                { name: 'Violations in Window', value: `${recentCount} / ${threshold} (last ${windowMinutes} min)`, inline: false },
                { name: 'Note', value: 'Detected in a message edit', inline: false },
              )
              .setTimestamp();

            if (recentCount >= threshold) {
              logEmbed.setColor(0xFF0000);
              logEmbed.setTitle('Word Filter - Soft Slur Threshold Reached (Edit)');
              logEmbed.setDescription(`**Staff notification:** <@${newMessage.author.id}> has reached ${recentCount} soft slur violations in the last ${windowMinutes} minutes.`);
            }

            await logChannel.send({ embeds: [logEmbed] });
          }
        } catch (err) {
          logger.warn(`Failed to post filter log: ${err.message}`);
        }
      }
    } else if (match.tier === 'auto_delete') {
      if (settings.warn_log_channel_id) {
        try {
          const logChannel = await newMessage.guild.channels.fetch(settings.warn_log_channel_id);
          if (logChannel) {
            const logEmbed = new EmbedBuilder()
              .setTitle('Word Filter - Auto-Delete (Edit)')
              .setColor(0x808080)
              .addFields(
                { name: 'User', value: `<@${newMessage.author.id}> (${newMessage.author.id})`, inline: true },
                { name: 'Channel', value: `<#${newMessage.channel.id}>`, inline: true },
                { name: 'Matched Word', value: `||${match.word}||`, inline: true },
                { name: 'Action', value: 'Message auto-deleted', inline: false },
                { name: 'Note', value: 'Detected in a message edit', inline: false },
              )
              .setTimestamp();
            await logChannel.send({ embeds: [logEmbed] });
          }
        } catch (err) {
          logger.warn(`Failed to post filter log: ${err.message}`);
        }
      }
    }
  },
};
