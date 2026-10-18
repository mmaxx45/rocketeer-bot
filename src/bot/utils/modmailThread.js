const { ChannelType, PermissionFlagsBits } = require('discord.js');
const { createThread, getOpenThread, closeThread } = require('../../database/modmail');
const logger = require('../../logger');

const UNKNOWN_CHANNEL = 10003;

function modmailChannelName(username) {
  return `modmail-${username.toLowerCase().replace(/[^a-z0-9]/g, '-')}`.slice(0, 100);
}

async function openModmailThread(client, guild, user, settings, { topic } = {}) {
  if (!settings.modmail_enabled || !settings.modmail_category_id) {
    return null;
  }

  const existing = getOpenThread(guild.id, user.id);
  if (existing) {
    let channel = null;
    try {
      channel = await guild.channels.fetch(existing.channel_id);
    } catch (err) {
      if (err.code !== UNKNOWN_CHANNEL) throw err;
    }
    if (channel) return channel;
    // The channel was deleted by hand: close the stale row (as handleDM does)
    // so it cannot shadow the thread we are about to open.
    closeThread(existing.id, client.user.id);
    logger.warn(`Modmail channel ${existing.channel_id} not found, closed thread ${existing.id}`);
  }

  const category = await guild.channels.fetch(settings.modmail_category_id);
  if (!category) {
    logger.warn(`Modmail category ${settings.modmail_category_id} not found in guild ${guild.id}`);
    return null;
  }

  const displayName = user.globalName || user.username;
  const channel = await guild.channels.create({
    name: modmailChannelName(user.username),
    type: ChannelType.GuildText,
    parent: category.id,
    topic: topic || `Modmail thread for ${displayName} (${user.id})`,
    permissionOverwrites: [
      {
        id: guild.roles.everyone.id,
        deny: [PermissionFlagsBits.ViewChannel],
      },
      {
        id: client.user.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels],
      },
    ],
  });

  if (settings.moderator_role_id) {
    try {
      await channel.permissionOverwrites.create(settings.moderator_role_id, {
        ViewChannel: true,
        SendMessages: true,
      });
    } catch (err) {
      logger.warn(`Failed to set mod role permissions on modmail channel: ${err.message}`);
    }
  }

  createThread(guild.id, user.id, channel.id);
  logger.info(`Modmail thread created: user=${displayName} guild=${guild.name} channel=${channel.id}`);
  return channel;
}

module.exports = { openModmailThread };
