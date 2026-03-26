const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const { createGiveaway, setMessageId, getActiveInChannel, getRecentEndedInChannel, getGiveaway, getEntries, getEntryCount, markEnded } = require('../../database/giveaways');
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

function pickWinners(entries, count) {
  const shuffled = [...entries];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, Math.min(count, shuffled.length));
}

async function endGiveaway(client, giveaway) {
  const entries = getEntries(giveaway.id);
  const winners = pickWinners(entries, giveaway.winner_count);
  const winnerMentions = winners.map(id => `<@${id}>`);

  // Edit the original message
  try {
    const guild = client.guilds.cache.get(giveaway.guild_id);
    if (!guild) {
      logger.warn(`Giveaway ${giveaway.id} expired but guild ${giveaway.guild_id} not in cache yet, will retry`);
      return [];
    }

    // Mark ended only after confirming guild is available
    markEnded(giveaway.id, JSON.stringify(winners));

    {
      const channel = await guild.channels.fetch(giveaway.channel_id);
      if (channel) {
        const message = await channel.messages.fetch(giveaway.message_id);
        if (message) {
          await message.edit({
            embeds: [buildEndedEmbed(giveaway, winnerMentions)],
            components: buildGiveawayButtons(giveaway.id, true),
          });
        }

        // Post winner announcement
        if (winners.length > 0) {
          await channel.send(`🎉 Congratulations ${winnerMentions.join(', ')}! You won **${giveaway.prize}**!`);
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

      // DM winners
      for (const winnerId of winners) {
        try {
          const user = await client.users.fetch(winnerId);
          await user.send(`🎉 You won **${giveaway.prize}** in **${guild.name}**! Congratulations!`);
        } catch {
          // DMs off or blocked
        }
      }
    }
  } catch (err) {
    logger.error(`Failed to end giveaway ${giveaway.id}: ${err.message}`);
  }

  return winners;
}

module.exports = {
  buildGiveawayEmbed,
  buildEndedEmbed,
  buildGiveawayButtons,
  pickWinners,
  endGiveaway,

  data: new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('Create and manage giveaways')
    .addSubcommand(sub =>
      sub.setName('create')
        .setDescription('Create a new giveaway')
        .addChannelOption(opt => opt.setName('channel').setDescription('Channel to post the giveaway in').setRequired(true))
        .addStringOption(opt => opt.setName('prize').setDescription('What the winner gets').setRequired(true))
        .addStringOption(opt => opt.setName('duration').setDescription('How long (e.g. 1h, 2d, 30m)').setRequired(true))
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
          title, prize, description, color, winnerCount, endsAt
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

        await interaction.editReply(`Giveaway created in <#${channel.id}>! Prize: **${prize}** — ends in **${formatDuration(durationMs)}**.`);
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

      const newWinners = pickWinners(entries, recent.winner_count);
      const winnerMentions = newWinners.map(id => `<@${id}>`);

      markEnded(recent.id, JSON.stringify(newWinners));

      // Update embed
      try {
        const channel = await interaction.guild.channels.fetch(recent.channel_id);
        if (channel) {
          const message = await channel.messages.fetch(recent.message_id);
          if (message) {
            await message.edit({
              embeds: [buildEndedEmbed(recent, winnerMentions)],
              components: buildGiveawayButtons(recent.id, true),
            });
          }
          await channel.send(`🎉 New winners rerolled for **${recent.prize}**: ${winnerMentions.join(', ')}! Congratulations!`);
        }
      } catch (err) {
        logger.warn(`Failed to update rerolled giveaway message: ${err.message}`);
      }

      await interaction.editReply(`Rerolled! New winners: ${winnerMentions.join(', ')}`);
      logger.info(`Giveaway ${recent.id} rerolled by ${interaction.user.username}`);
      return;
    }
  },
};
