const { ChannelType, PermissionFlagsBits } = require('discord.js');
const { db } = require('../../database/db');
const { createThread, getOpenThread, closeThread } = require('../../database/modmail');
const logger = require('../../logger');

const UNKNOWN_CHANNEL = 10003;

function modmailChannelName(username) {
  return `modmail-${username.toLowerCase().replace(/[^a-z0-9]/g, '-')}`.slice(0, 100);
}

// Opens are serialised per guild+user: a DM and a prize claim (or a double
// click) arriving together must not each create a Discord channel. The
// database also allows only one open thread per guild+user as a backstop.
const openQueues = new Map();

async function withUserQueue(key, fn) {
  const previous = openQueues.get(key) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  const tail = previous.then(() => current);
  openQueues.set(key, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (openQueues.get(key) === tail) openQueues.delete(key);
  }
}

// The channel of the user's open thread, or null when there is none. A row
// whose channel was deleted by hand is closed (as handleDM does) so it cannot
// shadow a new thread.
async function existingThreadChannel(client, guild, userId) {
  const existing = await getOpenThread(guild.id, userId);
  if (!existing) return null;
  let channel = null;
  try {
    channel = await guild.channels.fetch(existing.channel_id);
  } catch (err) {
    if (err.code !== UNKNOWN_CHANNEL) throw err;
  }
  if (channel) return channel;
  await closeThread(existing.id, client.user.id);
  logger.warn(`Modmail channel ${existing.channel_id} not found, closed thread ${existing.id}`);
  return null;
}

// Returns the user's modmail channel in this guild, creating the thread when
// there is none, or null when modmail is not configured. With returnDetails
// it returns { channel, created } instead.
async function openModmailThread(client, guild, user, settings, { topic, returnDetails = false } = {}) {
  if (!settings.modmail_enabled || !settings.modmail_category_id) {
    return null;
  }

  const result = await withUserQueue(`${guild.id}:${user.id}`, async () => {
    const existing = await existingThreadChannel(client, guild, user.id);
    if (existing) return { channel: existing, created: false };

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

    try {
      await createThread(guild.id, user.id, channel.id);
    } catch (err) {
      if (!db.isUniqueViolation(err)) throw err;
      // Another thread was opened in the meantime (e.g. by another process):
      // drop the channel we just made and use that one.
      await channel.delete('Duplicate modmail thread').catch(delErr => logger.warn(`Failed to delete duplicate modmail channel ${channel.id}: ${delErr.message}`));
      const winner = await existingThreadChannel(client, guild, user.id);
      if (!winner) throw err;
      return { channel: winner, created: false };
    }
    logger.info(`Modmail thread created: user=${displayName} guild=${guild.name} channel=${channel.id}`);
    return { channel, created: true };
  });

  if (!result) return null;
  return returnDetails ? result : result.channel;
}

module.exports = { openModmailThread };
