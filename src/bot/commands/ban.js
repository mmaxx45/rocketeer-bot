const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, PermissionFlagsBits } = require('discord.js');
const { getWarnings } = require('../../database/warnings');
const { getSettings } = require('../../database/settings');
const { canBan, isExempt } = require('../utils/permissions');
const { storePendingAction } = require('../utils/pendingActions');
const { buildWarningsEmbed } = require('../utils/embeds');
const logger = require('../../logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Ban a user from the server')
    .addUserOption(opt =>
      opt.setName('user').setDescription('The user to ban').setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('reason').setDescription('Reason for the ban').setRequired(true)
    )
    .addIntegerOption(opt =>
      opt.setName('delete_messages_days')
        .setDescription('Number of days of messages to delete (0-7)')
        .setMinValue(0)
        .setMaxValue(7)
        .setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),

  async execute(interaction) {
    const settings = getSettings(interaction.guild.id);

    if (!canBan(interaction.member, settings)) {
      return interaction.reply({ content: 'You do not have permission to use this command.', flags: MessageFlags.Ephemeral });
    }

    const targetUser = interaction.options.getUser('user');
    const reason = interaction.options.getString('reason');
    const deleteMessageDays = interaction.options.getInteger('delete_messages_days') || 0;

    if (targetUser.bot) {
      return interaction.reply({ content: 'You cannot ban a bot with this command.', flags: MessageFlags.Ephemeral });
    }

    if (targetUser.id === interaction.user.id) {
      return interaction.reply({ content: 'You cannot ban yourself.', flags: MessageFlags.Ephemeral });
    }

    let targetMember;
    try {
      targetMember = await interaction.guild.members.fetch(targetUser.id);
    } catch {
      targetMember = null; // User may have left — still bannable
    }

    if (targetMember && isExempt(targetMember, settings)) {
      return interaction.reply({ content: 'You cannot ban a moderator or admin.', flags: MessageFlags.Ephemeral });
    }

    // Build confirmation embed with current warnings
    const existingWarnings = getWarnings(interaction.guild.id, targetUser.id);
    const embed = buildWarningsEmbed(existingWarnings, targetUser, interaction.guild);
    const displayName = targetUser.username || `User ${targetUser.id}`;
    embed.setTitle(`Ban confirmation: ${displayName}`);
    embed.setColor(0xFF0000);

    const descParts = [];
    descParts.push(`**User:** <@${targetUser.id}> (${targetUser.id})`);
    descParts.push(`**Reason:** ${reason}`);
    descParts.push(`**Delete messages:** ${deleteMessageDays} day(s)`);
    descParts.push(`**Warnings on record:** ${existingWarnings.length}`);
    if (embed.data.description && embed.data.description !== 'No warnings on record.') {
      descParts.push('');
      descParts.push(embed.data.description);
    }
    embed.setDescription(descParts.join('\n'));

    const actionId = storePendingAction({
      targetId: targetUser.id,
      moderatorId: interaction.user.id,
      reason,
      deleteMessageDays,
      guildId: interaction.guild.id,
    });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`confirm_ban:${actionId}`)
        .setLabel('Confirm Ban')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`cancel_ban:${actionId}`)
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary),
    );

    return interaction.reply({
      embeds: [embed],
      components: [row],
      flags: MessageFlags.Ephemeral,
    });
  },
};
