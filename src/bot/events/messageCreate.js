const crypto = require('crypto');
const logger = require('../../logger');
const { getSettings, getExemptChannels, getImageOnlyChannels } = require('../../database/settings');
const { cacheMessage, getRecentMessages, deleteMessage } = require('../../database/messages');
const { addWarning, getWarningCount } = require('../../database/warnings');
const { addModAction } = require('../../database/modactions');
const { getSimilarity, normalizeMessage, MIN_MESSAGE_LENGTH } = require('../utils/similarity');
const { isExempt, isModerator } = require('../utils/permissions');
const { getBlockedExtensions, isBlockedFile, isBlockedByContentType, isImageAttachment, hasMediaAttachments, getMediaType } = require('../utils/fileFilter');
const { parseBannedDomains, checkForBannedLinks } = require('../utils/linkFilter');
const { checkMessage } = require('../utils/wordFilter');
const { getFilterWords, addFilterViolation, getRecentViolations, getWhitelist } = require('../../database/wordFilter');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ChannelType, PermissionFlagsBits } = require('discord.js');
const { db } = require('../../database/db');
const { createThread, getOpenThread, getOpenThreadByChannel, closeThread } = require('../../database/modmail');

let addIncidentStmt;
let countRecentIncidentsStmt;
let countRecentIncidentsMinutesStmt;

// Per-user lock to prevent race conditions when two identical messages arrive simultaneously
const processingLocks = new Set();

function getIncidentStmts() {
  if (!addIncidentStmt) {
    addIncidentStmt = db.prepare(
      `INSERT INTO crosspost_incidents (guild_id, user_id, original_channel_id, original_message_content, crosspost_channel_id, crosspost_message_content, similarity_score, action_taken) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    countRecentIncidentsStmt = db.prepare(
      `SELECT COUNT(*) as count FROM crosspost_incidents WHERE guild_id = ? AND user_id = ? AND created_at > datetime('now', '-' || ? || ' hours')`
    );
    countRecentIncidentsMinutesStmt = db.prepare(
      `SELECT COUNT(*) as count FROM crosspost_incidents WHERE guild_id = ? AND user_id = ? AND created_at > datetime('now', '-' || ? || ' minutes')`
    );
  }
  return { addIncidentStmt, countRecentIncidentsStmt, countRecentIncidentsMinutesStmt };
}

const MAX_ATTACHMENT_HASH_SIZE = 25 * 1024 * 1024; // 25 MB (Discord default upload limit)
const MAX_ATTACHMENTS_TO_HASH = 5;
const ATTACHMENT_FETCH_TIMEOUT_MS = 10000; // 10 seconds

async function hashAttachments(attachments) {
  const hashes = [];
  let count = 0;
  for (const [, attachment] of attachments) {
    if (count >= MAX_ATTACHMENTS_TO_HASH) break;
    if (attachment.size > MAX_ATTACHMENT_HASH_SIZE || attachment.size === 0) continue;

    const mediaType = getMediaType(attachment);

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), ATTACHMENT_FETCH_TIMEOUT_MS);
      const res = await fetch(attachment.url, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) continue;
      const buffer = Buffer.from(await res.arrayBuffer());
      const hash = crypto.createHash('sha256').update(buffer).digest('hex');
      hashes.push({ hash, mediaType, name: attachment.name || 'unknown' });
      count++;
    } catch {
      // Skip unhashable/timed-out attachments
    }
  }
  return hashes;
}

function truncate(text, maxLength) {
  if (!text) return '*[empty]*';
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}

function buildCrosspostEmbed(originalContent, originalChannelId, crosspostContent, crosspostChannelId, similarityScore, color) {
  return new EmbedBuilder()
    .setColor(color)
    .addFields(
      { name: 'Original Message', value: truncate(originalContent, 1024), inline: false },
      { name: 'Duplicate Message', value: truncate(crosspostContent, 1024), inline: false },
      { name: 'Original Channel', value: `<#${originalChannelId}>`, inline: true },
      { name: 'Duplicate Channel', value: `<#${crosspostChannelId}>`, inline: true },
      { name: 'Similarity', value: `${similarityScore.toFixed(1)}%`, inline: true },
    );
}

async function sendToWarnLogChannel(guild, settings, embed) {
  if (!settings.warn_log_channel_id) return;
  try {
    const logChannel = await guild.channels.fetch(settings.warn_log_channel_id);
    if (logChannel) {
      await logChannel.send({ embeds: [embed] });
    }
  } catch (err) {
    logger.warn(`Failed to post crosspost incident to warn log channel: ${err.message}`);
  }
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
            name: message.author.globalName || message.author.username,
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

    const displayName = message.author.globalName || message.author.username;
    const channelName = `modmail-${message.author.username.toLowerCase().replace(/[^a-z0-9]/g, '-')}`.slice(0, 100);

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

    const modmailOpenMsg = { embeds: [infoEmbed], components: [closeButton] };
    if (targetSettings.moderator_role_id) {
      modmailOpenMsg.content = `<@&${targetSettings.moderator_role_id}> New modmail received`;
    }
    await modmailChannel.send(modmailOpenMsg);

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

  // Only moderators should relay messages to the user
  const modSettings = getSettings(message.guild.id);
  if (!isModerator(message.member, modSettings)) return true; // Absorb but don't relay

  // This is a modmail channel - relay the mod's message to the user
  try {
    const user = await message.client.users.fetch(thread.user_id);
    const displayName = message.member?.displayName || message.author.globalName || message.author.username;

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
      const mmSettings = getSettings(message.guild.id);
      if (mmSettings.modmail_enabled && mmSettings.modmail_category_id) {
        if (message.channel.parentId === mmSettings.modmail_category_id) {
          const handled = await handleModmailReply(message);
          if (handled) return;
        }
      }
    }

    const guildId = message.guild.id;
    const settings = getSettings(guildId);
    const exemptChannels = getExemptChannels(guildId);

    const hasContent = message.content && message.content.length > 0;
    const hasAttachments = message.attachments && message.attachments.size > 0;

    // Nothing to process
    if (!hasContent && !hasAttachments) return;

    // Check exempt channel (still cache for crosspost if applicable)
    const isExemptChannel = exemptChannels.includes(message.channel.id);

    // Fetch member for exempt check
    let member = message.member;
    if (!member) {
      try {
        member = await message.guild.members.fetch(message.author.id);
      } catch {
        return;
      }
    }

    const memberIsExempt = isExempt(member, settings);

    // --- File upload blocking ---
    if (hasAttachments && !memberIsExempt && !isExemptChannel && settings.file_block_enabled) {
      const blockedExtensions = getBlockedExtensions(settings);
      let blockedExt = null;
      let blockedFilename = null;

      for (const [, attachment] of message.attachments) {
        // Check by file extension
        const ext = isBlockedFile(attachment.name, blockedExtensions);
        if (ext) {
          blockedExt = ext;
          blockedFilename = attachment.name;
          break;
        }
        // Also check by MIME contentType for files that might have misleading extensions
        const mimeExt = isBlockedByContentType(attachment.contentType, blockedExtensions);
        if (mimeExt) {
          blockedExt = mimeExt;
          blockedFilename = attachment.name || 'unknown';
          break;
        }
      }

      if (blockedExt) {
        logger.info(`Blocked file upload: user=${message.author.username} guild=${guildId} file=${blockedFilename} ext=${blockedExt}`);

        try {
          await message.delete();
        } catch (err) {
          logger.warn(`Failed to delete blocked file message: ${err.message}`);
        }

        try {
          await message.channel.send({
            content: `<@${message.author.id}>, your file was removed because \`.${blockedExt}\` files are not allowed here.`,
          });
        } catch (err) {
          logger.warn(`Failed to send file block notification: ${err.message}`);
        }

        // Log to warn_log_channel_id if configured
        if (settings.warn_log_channel_id) {
          try {
            const logChannel = await message.guild.channels.fetch(settings.warn_log_channel_id);
            if (logChannel) {
              const logEmbed = new EmbedBuilder()
                .setTitle('File Upload Blocked')
                .setColor(0xFF6600)
                .addFields(
                  { name: 'User', value: `<@${message.author.id}> (${message.author.id})`, inline: true },
                  { name: 'Channel', value: `<#${message.channel.id}>`, inline: true },
                  { name: 'Filename', value: blockedFilename, inline: true },
                  { name: 'Blocked Extension', value: `.${blockedExt}`, inline: true },
                )
                .setTimestamp();
              await logChannel.send({ embeds: [logEmbed] });
            }
          } catch (err) {
            logger.warn(`Failed to post file block to log channel: ${err.message}`);
          }
        }

        return; // Don't process for crosspost
      }
    }

    // --- Banned link filtering ---
    if (hasContent && !memberIsExempt && !isExemptChannel) {
      const bannedDomains = parseBannedDomains(settings.banned_domains);
      if (bannedDomains.length > 0) {
        const matchedDomain = checkForBannedLinks(message.content, bannedDomains);
        if (matchedDomain) {
          logger.info(`Banned link detected: user=${message.author.username} guild=${guildId} domain=${matchedDomain}`);

          try {
            await message.delete();
          } catch (err) {
            logger.warn(`Failed to delete banned link message: ${err.message}`);
          }

          // Log to warn log channel if configured (no public message)
          if (settings.warn_log_channel_id) {
            try {
              const logChannel = await message.guild.channels.fetch(settings.warn_log_channel_id);
              if (logChannel) {
                const logEmbed = new EmbedBuilder()
                  .setTitle('Banned Link Deleted')
                  .setColor(0xFF4444)
                  .addFields(
                    { name: 'User', value: `<@${message.author.id}> (${message.author.id})`, inline: true },
                    { name: 'Channel', value: `<#${message.channel.id}>`, inline: true },
                    { name: 'Matched Domain', value: matchedDomain, inline: true },
                    { name: 'Message Content', value: message.content.length > 1024 ? message.content.slice(0, 1021) + '...' : message.content, inline: false },
                  )
                  .setTimestamp();
                await logChannel.send({ embeds: [logEmbed] });
              }
            } catch (err) {
              logger.warn(`Failed to post banned link log: ${err.message}`);
            }
          }

          return; // Don't process further
        }
      }
    }

    // --- Word filter ---
    if (hasContent && !memberIsExempt && settings.filter_enabled) {
      const filterWords = getFilterWords(guildId);
      if (filterWords.length > 0) {
        const whitelist = getWhitelist(guildId);
        const matches = checkMessage(message.content, filterWords, whitelist);
        if (matches.length > 0) {
          // Use the highest severity match
          const match = matches[0];

          // Delete the message
          try {
            await message.delete();
          } catch (err) {
            logger.warn(`Failed to delete filtered message: ${err.message}`);
          }

          // Log violation
          addFilterViolation(guildId, message.author.id, match.word, match.tier, message.content, message.channel.id);

          logger.info(`Word filter triggered: user=${message.author.username} guild=${guildId} word=${match.word} tier=${match.tier}`);

          if (match.tier === 'hard') {
            // Hard slur: auto-warn + log + DM
            addWarning(guildId, message.author.id, message.client.user.id, `Automatic warning: used a prohibited word (hard filter)`, 'manual', message.content);
            const warningCount = getWarningCount(guildId, message.author.id);

            try {
              addModAction(guildId, message.client.user.id, 'filter_warn', message.author.id, `Hard filter triggered: "${match.word}"`);
            } catch (err) {
              logger.warn(`Failed to log filter mod action: ${err.message}`);
            }

            // DM the user
            try {
              await message.author.send({
                embeds: [
                  new EmbedBuilder()
                    .setTitle('Message Removed')
                    .setColor(0xFF0000)
                    .setDescription(`Your message in **${message.guild.name}** was removed because it contained a prohibited word. You have received an automatic warning (warning #${warningCount}).`)
                    .setTimestamp(),
                ],
              });
            } catch {
              // Can't DM user — that's fine
            }

            // Log to warn channel
            if (settings.warn_log_channel_id) {
              try {
                const logChannel = await message.guild.channels.fetch(settings.warn_log_channel_id);
                if (logChannel) {
                  const logEmbed = new EmbedBuilder()
                    .setTitle('Word Filter - Hard Slur Detected')
                    .setColor(0xFF0000)
                    .addFields(
                      { name: 'User', value: `<@${message.author.id}> (${message.author.id})`, inline: true },
                      { name: 'Channel', value: `<#${message.channel.id}>`, inline: true },
                      { name: 'Matched Word', value: `||${match.word}||`, inline: true },
                      { name: 'Action', value: `Message deleted + Warning #${warningCount} issued`, inline: false },
                      { name: 'Original Message', value: message.content.length > 1024 ? message.content.slice(0, 1021) + '...' : message.content, inline: false },
                    )
                    .setTimestamp();
                  const whitelistRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`filter_whitelist:${guildId}:${encodeURIComponent(match.word)}`).setLabel('Whitelist Word').setStyle(ButtonStyle.Secondary).setEmoji('✅'),
                  );
                  await logChannel.send({ embeds: [logEmbed], components: [whitelistRow] });
                }
              } catch (err) {
                logger.warn(`Failed to post filter log: ${err.message}`);
              }
            }
          } else if (match.tier === 'soft') {
            // Soft slur: check threshold
            const windowMinutes = settings.soft_slur_window_minutes || 60;
            const threshold = settings.soft_slur_threshold || 3;
            const recentCount = getRecentViolations(guildId, message.author.id, windowMinutes);

            // Log to warn channel
            if (settings.warn_log_channel_id) {
              try {
                const logChannel = await message.guild.channels.fetch(settings.warn_log_channel_id);
                if (logChannel) {
                  const logEmbed = new EmbedBuilder()
                    .setTitle('Word Filter - Soft Slur Detected')
                    .setColor(0xFFA500)
                    .addFields(
                      { name: 'User', value: `<@${message.author.id}> (${message.author.id})`, inline: true },
                      { name: 'Channel', value: `<#${message.channel.id}>`, inline: true },
                      { name: 'Matched Word', value: `||${match.word}||`, inline: true },
                      { name: 'Action', value: 'Message deleted silently', inline: false },
                      { name: 'Violations in Window', value: `${recentCount} / ${threshold} (last ${windowMinutes} min)`, inline: false },
                      { name: 'Original Message', value: message.content.length > 1024 ? message.content.slice(0, 1021) + '...' : message.content, inline: false },
                    )
                    .setTimestamp();

                  if (recentCount >= threshold) {
                    logEmbed.setColor(0xFF0000);
                    logEmbed.setTitle('Word Filter - Soft Slur Threshold Reached');
                    logEmbed.setDescription(`**Staff notification:** <@${message.author.id}> has reached ${recentCount} soft slur violations in the last ${windowMinutes} minutes.`);
                  }

                  const whitelistRow2 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`filter_whitelist:${guildId}:${encodeURIComponent(match.word)}`).setLabel('Whitelist Word').setStyle(ButtonStyle.Secondary).setEmoji('✅'),
                  );
                  await logChannel.send({ embeds: [logEmbed], components: [whitelistRow2] });
                }
              } catch (err) {
                logger.warn(`Failed to post filter log: ${err.message}`);
              }
            }
          } else if (match.tier === 'auto_delete') {
            // Auto-delete: just log silently
            if (settings.warn_log_channel_id) {
              try {
                const logChannel = await message.guild.channels.fetch(settings.warn_log_channel_id);
                if (logChannel) {
                  const logEmbed = new EmbedBuilder()
                    .setTitle('Word Filter - Auto-Delete')
                    .setColor(0x808080)
                    .addFields(
                      { name: 'User', value: `<@${message.author.id}> (${message.author.id})`, inline: true },
                      { name: 'Channel', value: `<#${message.channel.id}>`, inline: true },
                      { name: 'Matched Word', value: `||${match.word}||`, inline: true },
                      { name: 'Action', value: 'Message auto-deleted', inline: false },
                      { name: 'Original Message', value: message.content.length > 1024 ? message.content.slice(0, 1021) + '...' : message.content, inline: false },
                    )
                    .setTimestamp();
                  const whitelistRow3 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`filter_whitelist:${guildId}:${encodeURIComponent(match.word)}`).setLabel('Whitelist Word').setStyle(ButtonStyle.Secondary).setEmoji('✅'),
                  );
                  await logChannel.send({ embeds: [logEmbed], components: [whitelistRow3] });
                }
              } catch (err) {
                logger.warn(`Failed to post filter log: ${err.message}`);
              }
            }
          }

          return; // Don't process for crosspost
        }
      }
    }

    // --- Image-only channel enforcement ---
    if (!memberIsExempt && !isExemptChannel) {
      const imageOnlyChannels = getImageOnlyChannels(guildId);
      if (imageOnlyChannels.includes(message.channel.id)) {
        const messageHasMedia = hasMediaAttachments(message.attachments);
        // If the message has no image/video attachments, delete it
        if (!messageHasMedia) {
          logger.info(`Image-only channel violation: user=${message.author.username} guild=${guildId} channel=${message.channel.id}`);

          try {
            await message.delete();
          } catch (err) {
            logger.warn(`Failed to delete non-media message in image-only channel: ${err.message}`);
          }

          try {
            const notice = await message.channel.send({
              content: `<@${message.author.id}>, this channel only allows images and videos. Text-only messages are not permitted here.`,
            });
            // Auto-delete the notice after 5 seconds to keep the channel clean
            setTimeout(() => {
              notice.delete().catch(() => {});
            }, 5000);
          } catch (err) {
            logger.warn(`Failed to send image-only channel notification: ${err.message}`);
          }

          return;
        }
      }
    }

    // --- Crosspost detection ---
    const normalized = hasContent ? normalizeMessage(message.content) : '';
    const hasDetectableText = normalized.length >= MIN_MESSAGE_LENGTH;

    // Hash attachments for crosspost comparison
    let attachmentHashDetails = [];
    if (hasAttachments) {
      attachmentHashDetails = await hashAttachments(message.attachments);
    }
    // Extract plain hash strings for cache storage and comparison
    const attachmentHashes = attachmentHashDetails.map(d => d.hash);
    const hasDetectableAttachments = attachmentHashes.length > 0;

    // Nothing to detect crosspost on
    if (!hasDetectableText && !hasDetectableAttachments) return;

    // Acquire per-user lock to prevent race conditions with simultaneous messages
    const lockKey = `${guildId}:${message.author.id}`;
    if (processingLocks.has(lockKey)) {
      // Another message from this user is being processed — just cache and skip
      cacheMessage(guildId, message.channel.id, message.author.id, message.id, message.content, attachmentHashes);
      return;
    }
    processingLocks.add(lockKey);
    try {

    if (isExemptChannel) {
      cacheMessage(guildId, message.channel.id, message.author.id, message.id, message.content, attachmentHashes);
      return;
    }

    if (memberIsExempt) {
      cacheMessage(guildId, message.channel.id, message.author.id, message.id, message.content, attachmentHashes);
      return;
    }

    const detectionSeconds = settings.crosspost_detection_seconds || 30;
    const repeatOffenseHours = settings.crosspost_window_hours || 48;
    const threshold = settings.crosspost_threshold || 80;

    const recentMessages = getRecentMessages(guildId, message.author.id, message.channel.id, detectionSeconds);

    let bestMatch = null;
    let bestScore = 0;

    let matchType = null; // 'sha256-image', 'sha256-other', 'text-similarity', 'name-match'
    for (const cached of recentMessages) {
      // Attachment hash match — identical file is an exact match (SHA256)
      if (hasDetectableAttachments && cached.attachment_hashes && cached.attachment_hashes.length > 0) {
        const hasCommonHash = attachmentHashes.some(h => cached.attachment_hashes.includes(h));
        if (hasCommonHash) {
          // Determine if the match is image-specific
          const matchedDetail = attachmentHashDetails.find(d => cached.attachment_hashes.includes(d.hash));
          matchType = matchedDetail && matchedDetail.mediaType === 'image' ? 'sha256-image' : 'sha256-other';
          bestMatch = cached;
          bestScore = 100;
          break; // exact match, stop searching
        }
      }
      // Text similarity match
      if (hasDetectableText && cached.content) {
        const score = getSimilarity(message.content, cached.content);
        if (score >= threshold && score > bestScore) {
          bestMatch = cached;
          bestScore = score;
          matchType = 'text-similarity';
        }
      }
    }

    // Cache the message regardless
    cacheMessage(guildId, message.channel.id, message.author.id, message.id, message.content, attachmentHashes);

    if (!bestMatch) return;

    const matchInfo = matchType ? ` matchType=${matchType}` : '';
    logger.info(`Crosspost detected: user=${message.author.username} guild=${guildId} similarity=${bestScore.toFixed(1)}%${matchInfo} channel1=${bestMatch.channel_id} channel2=${message.channel.id}`);

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
    const { addIncidentStmt: addInc, countRecentIncidentsStmt: countInc, countRecentIncidentsMinutesStmt: countIncMinutes } = getIncidentStmts();

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

      addWarning(guildId, message.author.id, message.client.user.id, `Repeated crossposting between channels (similarity: ${bestScore.toFixed(1)}%)`, 'crosspost', message.content);
      const warningCount = getWarningCount(guildId, message.author.id);

      // Build crosspost detail embed for the warning message
      const detailEmbed = buildCrosspostEmbed(
        bestMatch.content, bestMatch.channel_id,
        message.content, message.channel.id,
        bestScore, 0xFF0000 // Red for repeat offense
      );
      detailEmbed.setTitle('Crosspost Detected - Repeat Offense');
      detailEmbed.setFooter({ text: `Warning #${warningCount}` });
      detailEmbed.setTimestamp();

      try {
        addModAction(guildId, message.client.user.id, 'crosspost_warn', message.author.id, `Repeated crossposting between channels (similarity: ${bestScore.toFixed(1)}%)`);
      } catch (err) {
        logger.warn(`Failed to log mod action: ${err.message}`);
      }

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
        const sentMsg = await message.channel.send({
          content: repeatMsg,
          components: [row],
        });
        // Auto-delete after 5 minutes
        setTimeout(() => { sentMsg.delete().catch(() => {}); }, 5 * 60 * 1000);
      } catch (err) {
        logger.warn(`Failed to send warning message: ${err.message}`);
      }

      // Send the same warning to the original channel so users there know why the message vanished
      try {
        if (bestMatch.channel_id !== message.channel.id) {
          const origChannel = await message.guild.channels.fetch(bestMatch.channel_id);
          if (origChannel) {
            const sentOrig = await origChannel.send({
              content: repeatMsg,
              components: [row],
            });
            // Auto-delete after 5 minutes
            setTimeout(() => { sentOrig.delete().catch(() => {}); }, 5 * 60 * 1000);
          }
        }
      } catch (err) {
        logger.warn(`Failed to send crosspost warning to original channel: ${err.message}`);
      }

      // Log to warn log channel
      const logEmbed = buildCrosspostEmbed(
        bestMatch.content, bestMatch.channel_id,
        message.content, message.channel.id,
        bestScore, 0xFF0000
      );
      logEmbed.setTitle('Crosspost Incident - Warning Issued');
      logEmbed.setDescription(`**User:** <@${message.author.id}> (${message.author.id})\n**Action:** Warning #${warningCount} issued`);
      logEmbed.setTimestamp();

      await sendToWarnLogChannel(message.guild, settings, logEmbed);

      // Feature 3: Auto-kick check
      const kickCount = settings.crosspost_kick_count || 3;
      const kickWindowMinutes = settings.crosspost_kick_window_minutes || 60;

      // Count incidents in the kick window (including the one we just recorded)
      const recentIncidentCount = countIncMinutes.get(guildId, message.author.id, kickWindowMinutes).count;

      if (recentIncidentCount >= kickCount) {
        try {
          const kickMember = await message.guild.members.fetch(message.author.id);
          if (kickMember.kickable) {
            await kickMember.kick(`Auto-kicked: ${recentIncidentCount} crosspost incidents in ${kickWindowMinutes} minutes`);
            logger.info(`Auto-kicked user ${message.author.username} from ${guildId}: ${recentIncidentCount} crosspost incidents in ${kickWindowMinutes} minutes`);

            try {
              addModAction(guildId, message.client.user.id, 'kick', message.author.id, `Auto-kicked: ${recentIncidentCount} crosspost incidents in ${kickWindowMinutes} minutes`);
            } catch (err) {
              logger.warn(`Failed to log kick mod action: ${err.message}`);
            }

            try {
              await message.channel.send({
                content: `<@${message.author.id}> has been auto kicked.`,
              });
            } catch (err) {
              logger.warn(`Failed to send kick notification: ${err.message}`);
            }

            // Log the kick to warn log channel
            const kickLogEmbed = new EmbedBuilder()
              .setTitle('User Auto-Kicked - Crosspost Violations')
              .setColor(0xDC143C)
              .setDescription(`**User:** <@${message.author.id}> (${message.author.id})`)
              .addFields(
                { name: 'Incidents in Window', value: `${recentIncidentCount}`, inline: true },
                { name: 'Kick Threshold', value: `${kickCount}`, inline: true },
                { name: 'Window', value: `${kickWindowMinutes} minutes`, inline: true },
                { name: 'Total Warnings', value: `${warningCount}`, inline: true },
              )
              .setTimestamp();

            await sendToWarnLogChannel(message.guild, settings, kickLogEmbed);
          } else {
            logger.warn(`Cannot kick user ${message.author.username} in ${guildId}: bot lacks permission or user has higher role`);
          }
        } catch (err) {
          logger.error(`Failed to auto-kick user ${message.author.id}:`, err);
        }
      }
    } else {
      // First offense in this window
      addInc.run(
        guildId, message.author.id,
        bestMatch.channel_id, bestMatch.content,
        message.channel.id, message.content,
        bestScore, 'deleted'
      );

      // Build crosspost detail embed for the first-offense notification
      const detailEmbed = buildCrosspostEmbed(
        bestMatch.content, bestMatch.channel_id,
        message.content, message.channel.id,
        bestScore, 0xFFA500 // Orange for first offense
      );
      detailEmbed.setTitle('Crosspost Detected');
      detailEmbed.setFooter({ text: 'First offense - messages deleted' });
      detailEmbed.setTimestamp();

      const firstMsg = settings.crosspost_first_message
        ? settings.crosspost_first_message.replace(/\{user\}/g, `<@${message.author.id}>`)
        : `<@${message.author.id}>, please do not crosspost the same message across multiple channels. Use the channel that best fits your topic. Duplicate messages have been removed.`;

      try {
        const sentFirst = await message.channel.send({
          content: firstMsg,
        });
        // Auto-delete after 5 minutes
        setTimeout(() => { sentFirst.delete().catch(() => {}); }, 5 * 60 * 1000);
      } catch (err) {
        logger.warn(`Failed to send notification message: ${err.message}`);
      }

      // Log to warn log channel
      const logEmbed = buildCrosspostEmbed(
        bestMatch.content, bestMatch.channel_id,
        message.content, message.channel.id,
        bestScore, 0xFFA500
      );
      logEmbed.setTitle('Crosspost Incident - Messages Deleted');
      logEmbed.setDescription(`**User:** <@${message.author.id}> (${message.author.id})\n**Action:** Duplicate messages deleted (first offense)`);
      logEmbed.setTimestamp();

      await sendToWarnLogChannel(message.guild, settings, logEmbed);
    }

    } finally {
      processingLocks.delete(lockKey);
    }
  },
};
