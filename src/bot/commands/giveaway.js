const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const { createGiveaway, setMessageId, getActiveInChannel, getRecentEndedInChannel, getGiveaway, getEntries, getEntryCount, markEnded, setClaimDeadline, clearClaimDeadline, setClaim, getClaims, clearClaims } = require('../../database/giveaways');
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
function beginClaimWindow(giveawayId, claimTime, { resetClaims = false } = {}) {
  if (resetClaims) clearClaims(giveawayId);
  const seconds = Number(claimTime) || 0;
  if (seconds <= 0) {
    clearClaimDeadline(giveawayId);
    return null;
  }
  const deadline = sqlDatetime(Date.now() + seconds * 1000);
  setClaimDeadline(giveawayId, deadline);
  return deadline;
}

// Ending, expiring and rerolling a giveaway all await Discord API calls
// (member checks, message edits) between reading and writing its winners. The
// 30s sweeper, the End button, the slash command and the dashboard can all hit
// the same giveaway, so serialise them per giveaway. A single bot process owns
// the database, so an in-memory set is enough.
const busyGiveaways = new Set();

async function withGiveawayLock(giveawayId, fn) {
  const key = Number(giveawayId);
  if (busyGiveaways.has(key)) return { busy: true };
  busyGiveaways.add(key);
  try {
    return { busy: false, value: await fn() };
  } finally {
    busyGiveaways.delete(key);
  }
}

// Returns the winners, or null when the giveaway is already ended or another
// caller is ending it right now.
async function endGiveaway(client, giveaway) {
  const result = await withGiveawayLock(giveaway.id, async () => {
    const fresh = getGiveaway(giveaway.id);
    if (!fresh || fresh.ended) return null;
    return endGiveawayUnlocked(client, fresh);
  });
  return result.busy ? null : result.value;
}

async function endGiveawayUnlocked(client, giveaway) {
  let winners = [];

  // Edit the original message
  try {
    const guild = client.guilds.cache.get(giveaway.guild_id);
    if (!guild) {
      logger.warn(`Giveaway ${giveaway.id} expired but guild ${giveaway.guild_id} not in cache yet, will retry`);
      return [];
    }

    const entries = getEntries(giveaway.id);
    winners = await pickEligibleWinners(guild, entries, giveaway.winner_count);
    const winnerMentions = winners.map(id => `<@${id}>`);

    // Mark ended only after confirming guild is available
    markEnded(giveaway.id, JSON.stringify(winners));

    // Open the claim window (null when the giveaway does not require claiming)
    const claimDeadline = winners.length > 0 ? beginClaimWindow(giveaway.id, giveaway.claim_time) : null;
    const endedView = { ...giveaway, claim_deadline: claimDeadline };

    {
      const channel = await guild.channels.fetch(giveaway.channel_id);
      if (channel) {
        const message = await channel.messages.fetch(giveaway.message_id);
        if (message) {
          await message.edit({
            embeds: [buildEndedEmbed(endedView, winnerMentions)],
            components: buildGiveawayButtons(giveaway.id, true),
          });
        }

        // Post winner announcement
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
      }

      // Log to giveaway log channel
      const settings = getSettings(giveaway.guild_id);
      if (settings.giveaway_log_channel_id) {
        try {
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
        } catch (err) {
          logger.warn(`Failed to post giveaway log: ${err.message}`);
        }
      }

      // DM winners: the claim button lives in the DM, like modmail
      if (claimDeadline) {
        await dmClaimButtons(client, endedView, winners, claimDeadline);
      } else {
        for (const winnerId of winners) {
          try {
            const user = await client.users.fetch(winnerId);
            await user.send(`🎉 You won **${giveaway.prize}** in **${guild.name}**! Congratulations!`);
          } catch {
            // DMs off or blocked
          }
        }
      }
    }
  } catch (err) {
    logger.error(`Failed to end giveaway ${giveaway.id}: ${err.message}`);
  }

  return winners;
}

// A claim window elapsed: invalidate every winner who never claimed, then
// reroll their slots among the remaining feasible entrants. Winners who did
// claim keep their prize. Returns null when the guild is unavailable so the
// sweeper retries on its next tick.
// Returns null when the guild is unavailable, the claim window is no longer
// pending, or another caller holds the giveaway.
async function expireUnclaimedWinners(client, giveaway) {
  const result = await withGiveawayLock(giveaway.id, async () => {
    const fresh = getGiveaway(giveaway.id);
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
  const claims = getClaims(giveaway.id);
  const claimed = claims.filter(c => c.status === 'claimed').map(c => c.user_id);
  const excluded = new Set(claims.map(c => c.user_id));
  const unclaimed = winners.filter(id => !claimed.includes(id));

  if (unclaimed.length === 0) {
    clearClaimDeadline(giveaway.id);
    return { winners, claimed, expired: [], rerolled: false };
  }

  for (const userId of unclaimed) {
    setClaim(giveaway.id, userId, 'expired');
    excluded.add(userId);
  }

  const slots = Math.max(0, giveaway.winner_count - claimed.length);
  const pool = getEntries(giveaway.id).filter(id => !excluded.has(id));
  const fresh = claimAction === 'reroll' && slots > 0 ? await pickEligibleWinners(guild, pool, slots) : [];
  const newWinners = [...claimed, ...fresh];

  markEnded(giveaway.id, JSON.stringify(newWinners));
  let claimDeadline = null;
  if (fresh.length > 0) {
    claimDeadline = beginClaimWindow(giveaway.id, giveaway.claim_time);
  } else {
    clearClaimDeadline(giveaway.id);
  }
  const endedView = { ...giveaway, claim_deadline: claimDeadline };

  try {
    const channel = await guild.channels.fetch(giveaway.channel_id);
    if (channel) {
      const message = await channel.messages.fetch(giveaway.message_id);
      if (message) {
        await message.edit({
          embeds: [buildEndedEmbed(endedView, newWinners.map(id => `<@${id}>`))],
          components: buildGiveawayButtons(giveaway.id, true),
        });
      }
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
    }
  } catch (err) {
    logger.warn(`Failed to update expired-claim giveaway ${giveaway.id}: ${err.message}`);
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
  dmClaimButtons,
  endGiveaway,
  expireUnclaimedWinners,
  withGiveawayLock,

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
    const settings = getSettings(interaction.guild.id);

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

      try {
        const giveaway = createGiveaway(
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

        setMessageId(giveaway.id, msg.id);

        await interaction.editReply(`Giveaway created in <#${channel.id}>! Prize: **${prize}** — ends in **${formatDuration(durationMs)}**.${claimSeconds ? ` Winners have **${formatDuration(claimSeconds * 1000)}** to claim.` : ''}`);
        logger.info(`Giveaway ${giveaway.id} created by ${interaction.user.username} in guild ${interaction.guild.name}`);
      } catch (err) {
        logger.error(`Failed to create giveaway: ${err.message}`);
        await interaction.editReply(`Failed to create giveaway: ${err.message}`);
      }
      return;
    }

    if (subcommand === 'end') {
      const active = getActiveInChannel(interaction.channel.id);

      if (active.length === 0) {
        return interaction.reply({ content: 'No active giveaways in this channel.', flags: MessageFlags.Ephemeral });
      }

      if (active.length === 1) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const winners = await endGiveaway(interaction.client, active[0]);
        if (!winners) {
          return interaction.editReply('That giveaway has already ended or is being ended right now.');
        }
        const winnerText = winners.length > 0 ? winners.map(id => `<@${id}>`).join(', ') : 'No entries';
        await interaction.editReply(`Giveaway for **${active[0].prize}** ended! Winners: ${winnerText}`);
        return;
      }

      // Multiple active — show select menu
      const options = active.slice(0, 25).map(g => ({
        label: g.prize.slice(0, 100),
        description: `${getEntryCount(g.id)} entries`,
        value: String(g.id),
      }));

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
      const recent = getRecentEndedInChannel(interaction.channel.id);
      if (!recent) {
        return interaction.reply({ content: 'No recently ended giveaways in this channel.', flags: MessageFlags.Ephemeral });
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const entries = getEntries(recent.id);
      if (entries.length === 0) {
        return interaction.editReply('No entries in the giveaway — cannot reroll.');
      }

      const rerolled = await withGiveawayLock(recent.id, async () => {
        const picked = await pickEligibleWinners(interaction.guild, entries, recent.winner_count);
        if (picked.length === 0) return { newWinners: picked, claimDeadline: null };
        markEnded(recent.id, JSON.stringify(picked));
        const deadline = beginClaimWindow(recent.id, recent.claim_time, { resetClaims: true });
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
        const channel = await interaction.guild.channels.fetch(recent.channel_id);
        if (channel) {
          const message = await channel.messages.fetch(recent.message_id);
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
