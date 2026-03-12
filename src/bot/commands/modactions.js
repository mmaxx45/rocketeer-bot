const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { getSettings } = require('../../database/settings');
const { getModActions } = require('../../database/modactions');
const { canViewModActions } = require('../utils/permissions');
const logger = require('../../logger');

const PAGE_SIZE = 10;

function buildModActionsEmbed(rows, total, targetUser, page, totalPages) {
  const displayName = targetUser.tag || targetUser.username || `User ${targetUser.id}`;
  const embed = new EmbedBuilder()
    .setTitle(`Mod Actions by ${displayName}`)
    .setColor(0x5865F2)
    .setTimestamp();

  if (rows.length === 0) {
    embed.setDescription('No mod actions on record.');
    return embed;
  }

  const actionLabels = {
    warn: '\u26A0\uFE0F Warn',
    ban: '\uD83D\uDD28 Ban',
    timeout: '\u23F1\uFE0F Timeout',
    kick: '\uD83D\uDEAA Kick',
    crosspost_warn: '\uD83D\uDCCB Crosspost Warn',
    clear_warning: '\uD83D\uDDD1\uFE0F Clear Warning',
    clear_all_warnings: '\uD83D\uDDD1\uFE0F Clear All Warnings',
  };

  const lines = rows.map((a, i) => {
    const num = (page - 1) * PAGE_SIZE + i + 1;
    const date = new Date(a.created_at + 'Z').toLocaleDateString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric',
    });
    const label = actionLabels[a.action_type] || `\u2699\uFE0F ${a.action_type}`;
    const details = a.details
      ? (a.details.length > 80 ? a.details.slice(0, 77) + '...' : a.details)
      : 'N/A';
    return `**${num}.** ${date} | ${label} | Target: <@${a.target_id}>\n> ${details}`;
  });

  const chunk = lines.join('\n');
  if (chunk.length <= 4096) {
    embed.setDescription(chunk);
  } else {
    embed.setDescription(lines.slice(0, 8).join('\n') + `\n\n*...truncated*`);
  }

  embed.setFooter({ text: `Page ${page}/${totalPages} | Total: ${total} action(s)` });
  return embed;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('modactions')
    .setDescription('View a moderator\'s action history')
    .addUserOption(opt =>
      opt.setName('user').setDescription('The moderator to view actions for').setRequired(true)
    )
    .addIntegerOption(opt =>
      opt.setName('page').setDescription('Page number').setRequired(false)
    )
    .setDefaultMemberPermissions(null),

  async execute(interaction) {
    const settings = getSettings(interaction.guild.id);

    if (!canViewModActions(interaction.member, settings)) {
      return interaction.reply({ content: 'You do not have permission to use this command.', flags: MessageFlags.Ephemeral });
    }

    const targetUser = interaction.options.getUser('user');
    const page = Math.max(1, interaction.options.getInteger('page') || 1);
    const offset = (page - 1) * PAGE_SIZE;

    const { rows, total } = getModActions(interaction.guild.id, targetUser.id, PAGE_SIZE, offset);
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

    const embed = buildModActionsEmbed(rows, total, targetUser, page, totalPages);

    const buttons = [];
    if (page > 1) {
      buttons.push(
        new ButtonBuilder()
          .setCustomId(`modactions_page:${targetUser.id}:${page - 1}`)
          .setLabel('Previous')
          .setStyle(ButtonStyle.Secondary)
      );
    }
    if (page < totalPages) {
      buttons.push(
        new ButtonBuilder()
          .setCustomId(`modactions_page:${targetUser.id}:${page + 1}`)
          .setLabel('Next')
          .setStyle(ButtonStyle.Secondary)
      );
    }

    const components = buttons.length > 0
      ? [new ActionRowBuilder().addComponents(buttons)]
      : [];

    return interaction.reply({
      embeds: [embed],
      components,
      flags: MessageFlags.Ephemeral,
    });
  },
};
