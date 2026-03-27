const { REST, Routes, ActivityType, EmbedBuilder } = require('discord.js');
const config = require('../../config');
const logger = require('../../logger');
const { db } = require('../../database/db');
const { getDueTempBans, markUnbanned } = require('../../database/tempbans');
const { getExpiredGiveaways, getGiveaway } = require('../../database/giveaways');
const { endGiveaway } = require('../commands/giveaway');
const { getSettings } = require('../../database/settings');
const { addModAction } = require('../../database/modactions');

async function registerCommands(client) {
  const commands = [...client.commands.values()].map(c => c.data.toJSON());
  const rest = new REST({ version: '10' }).setToken(config.discord.token);

  // Clear guild-specific commands from all guilds to prevent duplicates
  for (const [guildId] of client.guilds.cache) {
    try {
      await rest.put(Routes.applicationGuildCommands(config.discord.clientId, guildId), { body: [] });
    } catch (err) {
      logger.warn(`Failed to clear guild commands for ${guildId}: ${err.message}`);
    }
  }

  // Register all commands globally
  logger.info(`Registering ${commands.length} command(s) globally...`);
  await rest.put(Routes.applicationCommands(config.discord.clientId), { body: commands });
  logger.info('Global commands registered.');
}

module.exports = {
  name: 'clientReady',
  once: true,
  async execute(client) {
    logger.info(`Bot ready as ${client.user.username}, serving ${client.guilds.cache.size} guild(s)`);

    // Snapshot current guilds as the allowlist
    const { allowedGuilds } = require('./guildCreate');
    for (const [guildId] of client.guilds.cache) {
      allowedGuilds.add(guildId);
    }
    logger.info(`Guild allowlist locked: ${[...allowedGuilds].join(', ')}`);

    // Load status message from the bot's first guild
    let statusMessage = 'DM for help!';
    try {
      const guildIds = [...client.guilds.cache.keys()];
      const placeholders = guildIds.map(() => '?').join(',');
      const row = guildIds.length > 0
        ? db.prepare(`SELECT bot_status_message FROM guild_settings WHERE guild_id IN (${placeholders}) AND bot_status_message IS NOT NULL LIMIT 1`).get(...guildIds)
        : null;
      if (row && row.bot_status_message) {
        statusMessage = row.bot_status_message;
      }
    } catch (err) {
      logger.warn(`Failed to load bot status from database: ${err.message}`);
    }

    client.user.setPresence({
      activities: [{ name: statusMessage, type: ActivityType.Custom }],
      status: 'online',
    });

    try {
      await registerCommands(client);
    } catch (err) {
      logger.error('Failed to register commands on startup:', err);
    }

    // Start periodic temp ban expiry checker (every 60 seconds)
    module.exports._tempBanInterval = setInterval(() => checkExpiredTempBans(client), 60 * 1000);
    checkExpiredTempBans(client);

    // Start periodic giveaway expiry checker (every 30 seconds)
    module.exports._giveawayInterval = setInterval(() => checkExpiredGiveaways(client), 30 * 1000);
    checkExpiredGiveaways(client);

  },
  cleanup() {
    if (module.exports._tempBanInterval) clearInterval(module.exports._tempBanInterval);
    if (module.exports._giveawayInterval) clearInterval(module.exports._giveawayInterval);
  },
};

async function checkExpiredTempBans(client) {
  let dueBans;
  try {
    dueBans = getDueTempBans();
  } catch (err) {
    logger.error(`Failed to fetch due temp bans: ${err.message}`);
    return;
  }

  for (const ban of dueBans) {
    try {
      const guild = client.guilds.cache.get(ban.guild_id);
      if (!guild) {
        logger.warn(`Temp ban expired but guild ${ban.guild_id} not found, marking as unbanned`);
        markUnbanned(ban.id);
        continue;
      }

      try {
        await guild.bans.remove(ban.user_id, 'Temporary ban expired');
      } catch (err) {
        // User may already be unbanned manually
        logger.warn(`Failed to unban user ${ban.user_id} in guild ${ban.guild_id}: ${err.message}`);
      }

      markUnbanned(ban.id);

      try {
        addModAction(ban.guild_id, client.user.id, 'unban', ban.user_id, 'Temporary ban expired');
      } catch (err) {
        logger.warn(`Failed to log temp unban mod action: ${err.message}`);
      }

      // Log to ban log channel
      const settings = getSettings(ban.guild_id);
      if (settings && settings.ban_log_channel_id) {
        try {
          const logChannel = await guild.channels.fetch(settings.ban_log_channel_id);
          if (logChannel) {
            const logEmbed = new EmbedBuilder()
              .setTitle('Temporary Ban Expired')
              .setColor(0x00FF00)
              .addFields(
                { name: 'User', value: `<@${ban.user_id}> (${ban.user_id})`, inline: true },
                { name: 'Originally banned by', value: `<@${ban.moderator_id}>`, inline: true },
                { name: 'Duration', value: `${ban.duration_days} day(s)`, inline: true },
                { name: 'Original Reason', value: ban.reason || 'No reason provided' },
              )
              .setTimestamp();
            await logChannel.send({ embeds: [logEmbed] });
          }
        } catch (err) {
          logger.warn(`Failed to post temp unban log: ${err.message}`);
        }
      }

      logger.info(`Temp ban expired: unbanned user ${ban.user_id} in guild ${ban.guild_id}`);
    } catch (err) {
      logger.error(`Error processing expired temp ban ${ban.id}: ${err.message}`);
    }
  }
}

async function checkExpiredGiveaways(client) {
  let expired;
  try {
    expired = getExpiredGiveaways();
  } catch (err) {
    logger.error(`Failed to fetch expired giveaways: ${err.message}`);
    return;
  }

  for (const giveaway of expired) {
    try {
      await endGiveaway(client, giveaway);
      logger.info(`Giveaway ${giveaway.id} auto-ended: prize=${giveaway.prize} guild=${giveaway.guild_id}`);
    } catch (err) {
      logger.error(`Error processing expired giveaway ${giveaway.id}: ${err.message}`);
    }
  }
}
