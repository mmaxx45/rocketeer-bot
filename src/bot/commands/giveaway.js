const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const { createGiveaway, setMessageId, deleteGiveaway, getActiveInChannel, getRecentEndedInChannel, getGiveaway, getEntries, getEntryCount, setClaimDeadline, clearClaimDeadline, getClaims, clearClaims, recordWinners } = require('../../database/giveaways');
const { getSettings } = require('../../database/settings');
const { isModerator } = require('../utils/permissions');
const { parseDuration, formatDuration } = require('../utils/parseDuration');
const logger = require('../../logger');

const DEFAULT_COLOR = 0x5865F2;

function canHostGiveaway(member, settings) {
  if (isModerator(member, settings)) return true;
  if (settings.giveaway_host_role_id && member.roles.cache.has(settings.giveaway_host_role_id)) return true;
  try {
    const allowedUsers = JSON.parse(settings.giveaway_host_user_ids || '[]');
    if (allowedUsers.includes(member.id)) return true;
  } catch {}
  return false;
}

function parseColor(colorStr) {
  if (!colorStr) return DEFAULT_COLOR;
  const hex = colorStr.replace('#', '');
  const parsed = parseInt(hex, 16);
  return isNaN(parsed) ? DEFAULT_COLOR : parsed;
}

// Timestamps are stored the same way as ends_at: UTC 'YYYY-MM-DD HH:MM:SS'.
function sqlDatetime(ms) {
  return new Date(ms).toISOString().replace('T', ' ').replace('Z', '').split('.')[0];
}

function buildGiveawayEmbed(giveaway, entryCount) {
  const endsUnix = Math.floor(new Date(giveaway.ends_at + 'Z').getTime() / 1000);
  const embed = new EmbedBuilder()
    .setTitle(giveaway.title || '🎉 GIVEAWAY 🎉')
    .setColor(parseColor(giveaway.color))
    .addFields(
      { name: '🎁 Prize', value: giveaway.prize, inline: true },
      { name: '🏆 Winners', value: `${giveaway.winner_count}`, inline: true },
      { name: '🎟️ Entries', value: `${entryCount}`, inline: true },
      { name: '⏰ Ends', value: `<t:${endsUnix}:R> (<t:${endsUnix}:F>)`, inline: false },
      { name: '🎩 Hosted by', value: `<@${giveaway.host_id}>`, inline: true },
      ...(giveaway.claim_time
        ? [{ name: '⏳ Claim window', value: formatDuration(giveaway.claim_time * 1000), inline: true }]
        : []),
    )
    .setTimestamp();

  if (giveaway.description) {
    embed.setDescription(giveaway.description);
  }

  return embed;
}

function buildEndedEmbed(giveaway, winnerMentions) {
  const embed = new EmbedBuilder()
    .setTitle('🎉 GIVEAWAY ENDED 🎉')
    .setColor(0x2F3136)
    .addFields(
      { name: '🎁 Prize', value: giveaway.prize, inline: true },
      { name: '🎩 Hosted by', value: `<@${giveaway.host_id}>`, inline: true },
    )
    .setTimestamp();

  if (winnerMentions && winnerMentions.length > 0) {
    embed.addFields({ name: '🏆 Winners', value: winnerMentions.join(', '), inline: false });
  } else {
    embed.addFields({ name: '🏆 Winners', value: 'No valid entries — no winners.', inline: false });
  }

  if (giveaway.claim_time && winnerMentions && winnerMentions.length > 0) {
    if (giveaway.claim_deadline) {
      const claimUnix = Math.floor(new Date(giveaway.claim_deadline + 'Z').getTime() / 1000);
      embed.addFields({ name: '⏳ Claim', value: `Winners must claim within **${formatDuration(giveaway.claim_time * 1000)}** — <t:${claimUnix}:R>.`, inline: false });
    } else {
      embed.addFields({ name: '⏳ Claim', value: 'All remaining winners have claimed the prize.', inline: false });
    }
  }

  if (giveaway.description) {
    embed.setDescription(giveaway.description);
  }

  return embed;
}

function buildGiveawayButtons(giveawayId, ended = false) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`giveaway_enter:${giveawayId}`)
      .setLabel('Enter')
      .setEmoji('🎉')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(ended),
  );
  return [row];
}

function buildClaimComponents(giveawayId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`giveaway_claim:${giveawayId}`)
        .setLabel('Claim Prize')
        .setEmoji('🎁')
        .setStyle(ButtonStyle.Success),
    ),
  ];
}

function buildClaimDMEmbed(giveaway, claimDeadline) {
  const embed = new EmbedBuilder()
    .setTitle('🎉 You won a giveaway!')
    .setColor(0x2ECC71)
    .addFields(
      { name: '🎁 Prize', value: giveaway.prize, inline: true },
      { name: '🎩 Hosted by', value: `<@${giveaway.host_id}>`, inline: true },
      { name: '⏳ Claim within', value: formatDuration(giveaway.claim_time * 1000), inline: true },
    );
  if (claimDeadline) {
    const unix = Math.floor(new Date(claimDeadline + 'Z').getTime() / 1000);
    embed.addFields({ name: '⏰ Deadline', value: `<t:${unix}:R>`, inline: false });
  }
  return embed;
}

async function dmClaimButtons(client, giveaway, winnerIds, claimDeadline) {
  if (!claimDeadline || winnerIds.length === 0) return;
  for (const winnerId of winnerIds) {
    try {
      const user = await client.users.fetch(winnerId);
      await user.send({
        embeds: [buildClaimDMEmbed(giveaway, claimDeadline)],
        components: buildClaimComponents(giveaway.id),
      });
    } catch {
      // DMs off or blocked
    }
  }
}

function shuffle(entries) {
  const shuffled = [...entries];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

// Discord REST error codes meaning the entrant is definitely gone.
const UNKNOWN_MEMBER = 10007;
const UNKNOWN_USER = 10013;

// An entrant who left the server is not a feasible winner. Cached members are
// trusted; otherwise we ask the API. Only a definitive "unknown member/user"
// answer disqualifies someone - any other failure is inconclusive, so we keep
// the entrant rather than silently dropping a legitimate winner.
async function isStillInGuild(guild, userId) {
  if (guild.members.cache.has(userId)) return true;
  try {
    await guild.members.fetch(userId);
    return true;
  } catch (err) {
    if (err.code === UNKNOWN_MEMBER || err.code === UNKNOWN_USER) return false;
    logger.warn(`Could not verify membership of ${userId} in guild ${guild.id}: ${err.message}`);
    return true;
  }
}

// Draw winners from the shuffled entry pool, skipping anyone who has left the
// server, and keep drawing until `count` feasible winners are found or the
// pool is exhausted.
async function pickEligibleWinners(guild, entries, count) {
  const winners = [];
  for (const userId of shuffle(entries)) {
    if (winners.length >= count) break;
    if (await isStillInGuild(guild, userId)) winners.push(userId);
  }
  return winners;
}

// Open a claim window for the current winners. Returns the deadline, or null
// when the giveaway has no claim window or there is nobody to claim.
async function beginClaimWindow(giveawayId, claimTime, { resetClaims = false } = {}) {
  if (resetClaims) await clearClaims(giveawayId);
  const deadline = claimDeadlineFor(claimTime);
  if (deadline) {
    await setClaimDeadline(giveawayId, deadline);
  } else {
    await clearClaimDeadline(giveawayId);
  }
  return deadline;
}

// The claim deadline for a window starting now, or null without a window.
function claimDeadlineFor(claimTime) {
  const seconds = Number(claimTime) || 0;
  return seconds > 0 ? sqlDatetime(Date.now() + seconds * 1000) : null;
}

// Ending, expiring, rerolling and claiming a giveaway all await Discord or
// database calls between reading and writing its state. The 30s sweeper, the
// End button, the slash commands, the dashboard and the claim button can all
// hit the same giveaway, so serialise them per giveaway. A single bot process
// owns the database, so an in-process lock is enough.
//
// By default a caller that finds the giveaway busy gets { busy: true } back
// (ending twice is pointless); with { wait: true } it queues behind the
// current holder instead (a claim must not be dropped).
const giveawayLocks = new Map();

async function withGiveawayLock(giveawayId, fn, { wait = false } = {}) {
  const key = Number(giveawayId);
  const held = giveawayLocks.get(key);
  if (held && !wait) return { busy: true };
  let release;
  const mine = new Promise(resolve => { release = resolve; });
  const tail = (held || Promise.resolve()).then(() => mine);
  giveawayLocks.set(key, tail);
  try {
    if (held) await held;
    return { busy: false, value: await fn() };
  } finally {
    release();
    if (giveawayLocks.get(key) === tail) giveawayLocks.delete(key);
  }
}

// True while a caller holds the giveaway (e.g. it is being ended right now).
function isGiveawayBusy(giveawayId) {
  return giveawayLocks.has(Number(giveawayId));
}

// Ends a giveaway. Returns the winners (possibly empty) when this call ended
// it, or null when nothing was ended: it had already ended, another caller is
// ending it right now, or its guild is not available yet (the sweeper retries).
// Throws when writing the result to the database fails.
async function endGiveaway(client, giveaway) {
  const result = await withGiveawayLock(giveaway.id, async () => {
    const fresh = await getGiveaway(giveaway.id);
    if (!fresh || fresh.ended) return null;
    return endGiveawayUnlocked(client, fresh);
  });
  return result.busy ? null : result.value;
}

// Fetches the giveaway's message, or null when it is gone or was never posted.
async function fetchGiveawayMessage(channel, giveaway) {
  if (!channel || !giveaway.message_id) return null;
  try {
    return await channel.messages.fetch(giveaway.message_id);
  } catch (err) {
    logger.warn(`Giveaway ${giveaway.id} message ${giveaway.message_id} could not be fetched: ${err.message}`);
    return null;
  }
}

async function fetchGiveawayChannel(guild, giveaway) {
  try {
    return await guild.channels.fetch(giveaway.channel_id);
  } catch (err) {
    logger.warn(`Giveaway ${giveaway.id} channel ${giveaway.channel_id} could not be fetched: ${err.message}`);
    return null;
  }
}

async function dmPlainWinners(client, guild, giveaway, winnerIds) {
  for (const winnerId of winnerIds) {
    try {
      const user = await client.users.fetch(winnerId);
      await user.send(`🎉 You won **${giveaway.prize}** in **${guild.name}**! Congratulations!`);
    } catch {
      // DMs off or blocked
    }
  }
}

async function endGiveawayUnlocked(client, giveaway) {
  const guild = client.guilds.cache.get(giveaway.guild_id);
  if (!guild) {
    logger.warn(`Giveaway ${giveaway.id} expired but guild ${giveaway.guild_id} not in cache yet, will retry`);
    return null;
  }

  const entries = await getEntries(giveaway.id);
  const winners = await pickEligibleWinners(guild, entries, giveaway.winner_count);
  const winnerMentions = winners.map(id => `<@${id}>`);

  // Winners and the claim window are written together; a failure here throws
  // and leaves the giveaway running so it can be ended again.
  const claimDeadline = winners.length > 0 ? claimDeadlineFor(giveaway.claim_time) : null;
  await recordWinners(giveaway.id, winners, claimDeadline);
  const endedView = { ...giveaway, claim_deadline: claimDeadline };

  // From here on the giveaway has ended. Each Discord step is independent: a
  // deleted message or a missing permission must not stop the winners from
  // being told, or they would lose the prize without ever seeing a claim button.
  const channel = await fetchGiveawayChannel(guild, giveaway);
  const message = await fetchGiveawayMessage(channel, giveaway);
  if (message) {
    try {
      await message.edit({
        embeds: [buildEndedEmbed(endedView, winnerMentions)],
        components: buildGiveawayButtons(giveaway.id, true),
      });
    } catch (err) {
      logger.warn(`Failed to edit ended giveaway ${giveaway.id} message: ${err.message}`);
    }
  }

  if (channel) {
    try {
      if (winners.length > 0) {
        const claimNote = claimDeadline
          ? ` Check your DMs to claim within **${formatDuration(giveaway.claim_time * 1000)}**.`
          : '';
        await channel.send(`🎉 Congratulations ${winnerMentions.join(', ')}! You won **${giveaway.prize}**!${claimNote}`);
      } else if (entries.length > 0) {
        await channel.send(`Every entry for **${giveaway.prize}** has left the server — no eligible winners.`);
      } else {
        await channel.send(`No one entered the giveaway for **${giveaway.prize}**. No winners.`);
      }
    } catch (err) {
      logger.warn(`Failed to announce winners of giveaway ${giveaway.id}: ${err.message}`);
    }
  }

  try {
    const settings = await getSettings(giveaway.guild_id);
    if (settings.giveaway_log_channel_id) {
      const logChannel = await guild.channels.fetch(settings.giveaway_log_channel_id);
      if (logChannel) {
        const logEmbed = new EmbedBuilder()
          .setTitle('Giveaway Ended')
          .setColor(0x5865F2)
          .addFields(
            { name: 'Prize', value: giveaway.prize, inline: true },
            { name: 'Hosted by', value: `<@${giveaway.host_id}>`, inline: true },
            { name: 'Entries', value: `${entries.length}`, inline: true },
            { name: 'Winners', value: winners.length > 0 ? winnerMentions.join(', ') : 'None', inline: false },
          )
          .setTimestamp();
        await logChannel.send({ embeds: [logEmbed] });
      }
    }
  } catch (err) {
    logger.warn(`Failed to post giveaway log: ${err.message}`);
  }

  // DM winners: the claim button lives in the DM, like modmail
  if (claimDeadline) {
    await dmClaimButtons(client, endedView, winners, claimDeadline);
  } else {
    await dmPlainWinners(client, guild, giveaway, winners);
  }

  return winners;
}

// A claim window elapsed: invalidate every winner who never claimed, then
// reroll their slots among the remaining feasible entrants. Winners who did
// claim keep their prize.
// Returns null when the guild is unavailable (the sweeper retries), the claim
// window is no longer pending, or another caller holds the giveaway.
async function expireUnclaimedWinners(client, giveaway) {
  const result = await withGiveawayLock(giveaway.id, async () => {
    const fresh = await getGiveaway(giveaway.id);
    if (!fresh || !fresh.ended || !fresh.claim_deadline) return null;
    if (new Date(fresh.claim_deadline + 'Z').getTime() > Date.now()) return null;
    return expireUnclaimedWinnersUnlocked(client, fresh);
  });
  return result.busy ? null : result.value;
}

async function expireUnclaimedWinnersUnlocked(client, giveaway) {
  const guild = client.guilds.cache.get(giveaway.guild_id);
  if (!guild) {
    logger.warn(`Giveaway ${giveaway.id} claim window expired but guild ${giveaway.guild_id} not in cache yet, will retry`);
    return null;
  }

  const winners = JSON.parse(giveaway.winners || '[]');
  const claimAction = giveaway.claim_action === 'void' ? 'void' : 'reroll';
  const claims = await getClaims(giveaway.id);
  // Only current winners count as claimed: a stale row (from before a reroll)
  // must not keep someone in the winner list or eat a slot.
  const claimed = claims.filter(c => c.status === 'claimed' && winners.includes(c.user_id)).map(c => c.user_id);
  const excluded = new Set(claims.map(c => c.user_id));
  const unclaimed = winners.filter(id => !claimed.includes(id));

  if (unclaimed.length === 0) {
    await clearClaimDeadline(giveaway.id);
    return { winners, claimed, expired: [], rerolled: false };
  }

  unclaimed.forEach(userId => excluded.add(userId));
  const slots = Math.max(0, giveaway.winner_count - claimed.length);
  const pool = (await getEntries(giveaway.id)).filter(id => !excluded.has(id));
  const fresh = claimAction === 'reroll' && slots > 0 ? await pickEligibleWinners(guild, pool, slots) : [];
  const newWinners = [...claimed, ...fresh];
  const claimDeadline = fresh.length > 0 ? claimDeadlineFor(giveaway.claim_time) : null;

  await recordWinners(giveaway.id, newWinners, claimDeadline, { expiredIds: unclaimed });
  const endedView = { ...giveaway, claim_deadline: claimDeadline };

  const channel = await fetchGiveawayChannel(guild, giveaway);
  const message = await fetchGiveawayMessage(channel, giveaway);
  if (message) {
    try {
      await message.edit({
        embeds: [buildEndedEmbed(endedView, newWinners.map(id => `<@${id}>`))],
        components: buildGiveawayButtons(giveaway.id, true),
      });
    } catch (err) {
      logger.warn(`Failed to edit expired-claim giveaway ${giveaway.id} message: ${err.message}`);
    }
  }
  if (channel) {
    try {
      if (claimAction === 'void') {
        if (newWinners.length > 0) {
          await channel.send(`⌛ The unclaimed winner(s) for **${giveaway.prize}** ran out of time — their win is void.`);
        } else {
          await channel.send(`⌛ No one claimed **${giveaway.prize}** in time — the win is void.`);
        }
      } else if (fresh.length > 0) {
        await channel.send(`⌛ The previous winner(s) did not claim **${giveaway.prize}** in time. New winner(s): ${fresh.map(id => `<@${id}>`).join(', ')} — check your DMs to claim within **${formatDuration(giveaway.claim_time * 1000)}**!`);
      } else if (newWinners.length > 0) {
        await channel.send(`⌛ No eligible entrants remain to claim **${giveaway.prize}**.`);
      } else {
        await channel.send(`⌛ No one claimed **${giveaway.prize}** in time and no eligible entrants remain. No winners.`);
      }
    } catch (err) {
      logger.warn(`Failed to announce expired claims for giveaway ${giveaway.id}: ${err.message}`);
    }
  }

  logger.info(`Giveaway ${giveaway.id} claim window expired: ${unclaimed.length} winner(s) invalidated, ${fresh.length} rerolled`);
  await dmClaimButtons(client, endedView, fresh, claimDeadline);
  return { winners: newWinners, claimed, expired: unclaimed, rerolled: fresh.length > 0, voided: claimAction === 'void' };
}

module.exports = {
  buildGiveawayEmbed,
  buildEndedEmbed,
  buildGiveawayButtons,
  pickEligibleWinners,
  beginClaimWindow,
  claimDeadlineFor,
  dmClaimButtons,
  endGiveaway,
  expireUnclaimedWinners,
  withGiveawayLock,
  isGiveawayBusy,

  data: new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('Create and manage giveaways')
    .addSubcommand(sub =>
      sub.setName('create')
        .setDescription('Create a new giveaway')
        .addChannelOption(opt => opt.setName('channel').setDescription('Channel to post the giveaway in').setRequired(true))
        .addStringOption(opt => opt.setName('prize').setDescription('What the winner gets').setRequired(true))
        .addStringOption(opt => opt.setName('duration').setDescription('How long (e.g. 1h, 2d, 30m)').setRequired(true))
        .addStringOption(opt => opt.setName('claimtime').setDescription('How long winners have to claim, e.g. 24h (default: no claiming)').setRequired(false))
        .addStringOption(opt => opt.setName('claimaction').setDescription('If the winner does not claim: reroll or void (default: reroll)').addChoices(
          { name: 'Reroll winners', value: 'reroll' },
          { name: 'Void the win', value: 'void' },
        ).setRequired(false))
        .addStringOption(opt => opt.setName('title').setDescription('Custom title (default: 🎉 GIVEAWAY 🎉)').setRequired(false))
        .addStringOption(opt => opt.setName('description').setDescription('Additional description').setRequired(false))
        .addIntegerOption(opt => opt.setName('winners').setDescription('Number of winners (default: 1)').setMinValue(1).setMaxValue(25).setRequired(false))
        .addStringOption(opt => opt.setName('color').setDescription('Embed color hex (e.g. #FF5733)').setRequired(false))
    )
    .addSubcommand(sub =>
      sub.setName('end')
        .setDescription('End an active giveaway in this channel')
    )
    .addSubcommand(sub =>
      sub.setName('reroll')
        .setDescription('Reroll winners for the last ended giveaway in this channel')
    ),

  async execute(interaction) {
    const settings = await getSettings(interaction.guild.id);

    if (!canHostGiveaway(interaction.member, settings)) {
      return interaction.reply({ content: 'You do not have permission to manage giveaways.', flags: MessageFlags.Ephemeral });
    }

    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'create') {
      const channel = interaction.options.getChannel('channel');
      const prize = interaction.options.getString('prize');
      const durationStr = interaction.options.getString('duration');
      const title = interaction.options.getString('title') || '🎉 GIVEAWAY 🎉';
      const description = interaction.options.getString('description') || null;
      const winnerCount = interaction.options.getInteger('winners') || 1;
      const color = interaction.options.getString('color') || null;
      const claimTimeStr = interaction.options.getString('claimtime');

      let claimSeconds = null;
      if (claimTimeStr) {
        const claimMs = parseDuration(claimTimeStr);
        if (!claimMs) {
          return interaction.reply({ content: 'Invalid claim time. Examples: `5s`, `5m`, `24h`, `3d`', flags: MessageFlags.Ephemeral });
        }
        claimSeconds = Math.round(claimMs / 1000);
      }
      const claimAction = interaction.options.getString('claimaction') === 'void' ? 'void' : 'reroll';

      // Enforce locked giveaway channel
      if (settings.giveaway_channel_id && channel.id !== settings.giveaway_channel_id) {
        return interaction.reply({ content: `Giveaways can only be created in <#${settings.giveaway_channel_id}>.`, flags: MessageFlags.Ephemeral });
      }

      const durationMs = parseDuration(durationStr);
      if (!durationMs) {
        return interaction.reply({ content: 'Invalid duration. Examples: `30m`, `1h`, `2d`, `1w`', flags: MessageFlags.Ephemeral });
      }

      const endsAt = new Date(Date.now() + durationMs).toISOString().replace('T', ' ').replace('Z', '').split('.')[0];

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      let giveaway = null;
      try {
        giveaway = await createGiveaway(
          interaction.guild.id, channel.id, interaction.user.id,
          title, prize, description, color, winnerCount, claimSeconds, claimAction, endsAt
        );

        const embed = buildGiveawayEmbed(giveaway, 0);
        const components = buildGiveawayButtons(giveaway.id);

        // Ping role if configured
        let pingContent = null;
        if (settings.giveaway_ping_role_id) {
          pingContent = `<@&${settings.giveaway_ping_role_id}>`;
        }

        const msg = await channel.send({
          content: pingContent,
          embeds: [embed],
          components,
        });

        await setMessageId(giveaway.id, msg.id);
        giveaway.message_id = msg.id;

        await interaction.editReply(`Giveaway created in <#${channel.id}>! Prize: **${prize}** — ends in **${formatDuration(durationMs)}**.${claimSeconds ? ` Winners have **${formatDuration(claimSeconds * 1000)}** to claim.` : ''}`);
        logger.info(`Giveaway ${giveaway.id} created by ${interaction.user.username} in guild ${interaction.guild.name}`);
      } catch (err) {
        logger.error(`Failed to create giveaway: ${err.message}`);
        // Without its message the giveaway could never be entered; do not leave
        // it running (e.g. the bot cannot post in that channel).
        if (giveaway && !giveaway.message_id) {
          await deleteGiveaway(giveaway.id).catch(delErr => logger.warn(`Failed to remove unposted giveaway ${giveaway.id}: ${delErr.message}`));
        }
        await interaction.editReply(`Failed to create giveaway: ${err.message}`);
      }
      return;
    }

    if (subcommand === 'end') {
      const active = await getActiveInChannel(interaction.channel.id);

      if (active.length === 0) {
        return interaction.reply({ content: 'No active giveaways in this channel.', flags: MessageFlags.Ephemeral });
      }

      if (active.length === 1) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const winners = await endGiveaway(interaction.client, active[0]);
        if (!winners) {
          return interaction.editReply('That giveaway could not be ended right now: it already ended, is being ended, or its server is unavailable.');
        }
        const winnerText = winners.length > 0 ? winners.map(id => `<@${id}>`).join(', ') : 'No entries';
        await interaction.editReply(`Giveaway for **${active[0].prize}** ended! Winners: ${winnerText}`);
        return;
      }

      // Multiple active — show select menu
      const options = await Promise.all(active.slice(0, 25).map(async g => ({
        label: g.prize.slice(0, 100),
        description: `${await getEntryCount(g.id)} entries`,
        value: String(g.id),
      })));

      const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('giveaway_end_select')
          .setPlaceholder('Which giveaway to end?')
          .addOptions(options),
      );

      await interaction.reply({ content: 'Multiple active giveaways in this channel. Pick one:', components: [row], flags: MessageFlags.Ephemeral });
      return;
    }

    if (subcommand === 'reroll') {
      const recent = await getRecentEndedInChannel(interaction.channel.id);
      if (!recent) {
        return interaction.reply({ content: 'No recently ended giveaways in this channel.', flags: MessageFlags.Ephemeral });
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const entries = await getEntries(recent.id);
      if (entries.length === 0) {
        return interaction.editReply('No entries in the giveaway — cannot reroll.');
      }

      const rerolled = await withGiveawayLock(recent.id, async () => {
        const picked = await pickEligibleWinners(interaction.guild, entries, recent.winner_count);
        if (picked.length === 0) return { newWinners: picked, claimDeadline: null };
        const deadline = claimDeadlineFor(recent.claim_time);
        await recordWinners(recent.id, picked, deadline, { resetClaims: true });
        return { newWinners: picked, claimDeadline: deadline };
      });
      if (rerolled.busy) {
        return interaction.editReply('That giveaway is being processed right now — try again in a moment.');
      }

      const { newWinners, claimDeadline } = rerolled.value;
      if (newWinners.length === 0) {
        return interaction.editReply('No eligible entries — every entrant has left the server.');
      }

      const winnerMentions = newWinners.map(id => `<@${id}>`);
      const endedView = { ...recent, claim_deadline: claimDeadline };

      // Update embed
      try {
        const channel = await fetchGiveawayChannel(interaction.guild, recent);
        if (channel) {
          const message = await fetchGiveawayMessage(channel, recent);
          if (message) {
            await message.edit({
              embeds: [buildEndedEmbed(endedView, winnerMentions)],
              components: buildGiveawayButtons(recent.id, true),
            });
          }
          const claimNote = claimDeadline
            ? ` Check your DMs to claim within **${formatDuration(recent.claim_time * 1000)}**.`
            : '';
          await channel.send(`🎉 New winners rerolled for **${recent.prize}**: ${winnerMentions.join(', ')}! Congratulations!${claimNote}`);
        }
      } catch (err) {
        logger.warn(`Failed to update rerolled giveaway message: ${err.message}`);
      }

      await dmClaimButtons(interaction.client, endedView, newWinners, claimDeadline);

      await interaction.editReply(`Rerolled! New winners: ${winnerMentions.join(', ')}`);
      logger.info(`Giveaway ${recent.id} rerolled by ${interaction.user.username}`);
      return;
    }
  },
};
