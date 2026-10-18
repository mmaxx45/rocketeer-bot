const { REST, Routes, ActivityType, EmbedBuilder } = require('discord.js');
const config = require('../../config');
const logger = require('../../logger');
const { db } = require('../../database/db');
const { getDueTempBans, markUnbanned } = require('../../database/tempbans');
const { getExpiredGiveaways, getPendingClaimGiveaways } = require('../../database/giveaways');
const { endGiveaway, expireUnclaimedWinners } = require('../commands/giveaway');
const { getSettings } = require('../../database/settings');
const { addModAction } = require('../../database/modactions');

// Discord error code: the user is not banned (already unbanned by hand).
const UNKNOWN_BAN = 10026;

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
        ? await db.get(`SELECT bot_status_message FROM guild_settings WHERE guild_id IN (${placeholders}) AND bot_status_message IS NOT NULL LIMIT 1`, guildIds)
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
    const tempBanSweep = sweeper('temp ban', () => checkExpiredTempBans(client));
    module.exports._tempBanInterval = setInterval(tempBanSweep, 60 * 1000);
    tempBanSweep();

    // Start periodic giveaway expiry checker (every 30 seconds)
    const giveawaySweep = sweeper('giveaway', () => checkExpiredGiveaways(client));
    module.exports._giveawayInterval = setInterval(giveawaySweep, 30 * 1000);
    giveawaySweep();

  },
  cleanup() {
    if (module.exports._tempBanInterval) clearInterval(module.exports._tempBanInterval);
    if (module.exports._giveawayInterval) clearInterval(module.exports._giveawayInterval);
  },
};

// Wraps an async sweep for setInterval: a run that is still going (slow
// database or Discord API) is not started again, and a rejection is logged
// instead of becoming an unhandled rejection.
function sweeper(name, fn) {
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } catch (err) {
      logger.error(`Error in ${name} sweep: ${err.message}`);
    } finally {
      running = false;
    }
  };
}

async function checkExpiredTempBans(client) {
  let dueBans;
  try {
    dueBans = await getDueTempBans();
  } catch (err) {
    logger.error(`Failed to fetch due temp bans: ${err.message}`);
    return;
  }

  for (const ban of dueBans) {
    try {
      const guild = client.guilds.cache.get(ban.guild_id);
      if (!guild) {
        logger.warn(`Temp ban expired but guild ${ban.guild_id} not found, marking as unbanned`);
        await markUnbanned(ban.id);
        continue;
      }
      if (guild.available === false) {
        // Discord outage: keep the ban and retry on the next sweep.
        continue;
      }

      try {
        await guild.bans.remove(ban.user_id, 'Temporary ban expired');
      } catch (err) {
        if (err.code !== UNKNOWN_BAN) {
          // Missing permission, rate limit, 5xx...: leave it due so the next
          // sweep retries, instead of keeping the user banned for good.
          logger.warn(`Failed to unban user ${ban.user_id} in guild ${ban.guild_id}, will retry: ${err.message}`);
          continue;
        }
        // Already unbanned by hand
      }

      await markUnbanned(ban.id);

      try {
        await addModAction(ban.guild_id, client.user.id, 'unban', ban.user_id, 'Temporary ban expired');
      } catch (err) {
        logger.warn(`Failed to log temp unban mod action: ${err.message}`);
      }

      // Log to ban log channel
      const settings = await getSettings(ban.guild_id);
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
    expired = await getExpiredGiveaways();
  } catch (err) {
    logger.error(`Failed to fetch expired giveaways: ${err.message}`);
    return;
  }

  for (const giveaway of expired) {
    try {
      const winners = await endGiveaway(client, giveaway);
      if (winners) {
        logger.info(`Giveaway ${giveaway.id} auto-ended: prize=${giveaway.prize} guild=${giveaway.guild_id} winners=${winners.length}`);
      }
    } catch (err) {
      logger.error(`Error processing expired giveaway ${giveaway.id}: ${err.message}`);
    }
  }

  // Invalidate winners who did not claim inside their claim window and reroll
  let pendingClaims;
  try {
    pendingClaims = await getPendingClaimGiveaways();
  } catch (err) {
    logger.error(`Failed to fetch expired giveaway claims: ${err.message}`);
    return;
  }

  for (const giveaway of pendingClaims) {
    try {
      const result = await expireUnclaimedWinners(client, giveaway);
      if (result) {
        logger.info(`Giveaway ${giveaway.id} claim window processed: ${result.expired.length} expired, ${result.winners.length} winner(s) now`);
      }
    } catch (err) {
      logger.error(`Error processing expired claims for giveaway ${giveaway.id}: ${err.message}`);
    }
  }
}
