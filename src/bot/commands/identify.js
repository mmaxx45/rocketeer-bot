const { SlashCommandBuilder, EmbedBuilder, MessageFlags, PermissionFlagsBits } = require('discord.js');
const { getWarnings, getWarningCount } = require('../../database/warnings');
const { getSettings } = require('../../database/settings');
const { isModerator } = require('../utils/permissions');
const { db } = require('../../database/db');
const logger = require('../../logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('identify')
    .setDescription('Look up detailed information about a user')
    .addStringOption(opt =>
      opt.setName('userid').setDescription('The user ID to look up').setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  async execute(interaction) {
    const settings = getSettings(interaction.guild.id);
    if (!isModerator(interaction.member, settings)) {
      return interaction.reply({ content: 'You do not have permission to use this command.', flags: MessageFlags.Ephemeral });
    }

    const userId = interaction.options.getString('userid').trim();

    // Validate it looks like a Discord ID
    if (!/^\d{17,20}$/.test(userId)) {
      return interaction.reply({ content: 'Please provide a valid user ID (numeric, 17-20 digits).', flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTimestamp();

    // Try to fetch the user from Discord
    let user;
    try {
      user = await interaction.client.users.fetch(userId);
    } catch {
      user = null;
    }

    if (user) {
      embed.setTitle(`User Identification: ${user.username}`);
      embed.setThumbnail(user.displayAvatarURL({ size: 256 }));
      embed.addFields(
        { name: 'Username', value: user.username, inline: true },
        { name: 'User ID', value: user.id, inline: true },
        { name: 'Account Created', value: `<t:${Math.floor(user.createdTimestamp / 1000)}:F> (<t:${Math.floor(user.createdTimestamp / 1000)}:R>)`, inline: false },
      );
    } else {
      embed.setTitle(`User Identification: ${userId}`);
      embed.setDescription('Could not fetch user details from Discord. The user may have deleted their account.');
    }

    // Check if they're a member of this server
    let member;
    try {
      member = await interaction.guild.members.fetch(userId);
    } catch {
      member = null;
    }

    if (member) {
      embed.addFields(
        { name: 'Status', value: '\u2705 Currently in server', inline: true },
        { name: 'Joined Server', value: `<t:${Math.floor(member.joinedTimestamp / 1000)}:F> (<t:${Math.floor(member.joinedTimestamp / 1000)}:R>)`, inline: false },
      );

      const roles = member.roles.cache
        .filter(r => r.id !== interaction.guild.id)
        .sort((a, b) => b.position - a.position)
        .map(r => `<@&${r.id}>`)
        .join(', ');
      embed.addFields({ name: 'Roles', value: roles || 'None', inline: false });

      if (member.nickname) {
        embed.addFields({ name: 'Server Nickname', value: member.nickname, inline: true });
      }
    } else {
      // Check if they're banned
      let banned = false;
      try {
        const ban = await interaction.guild.bans.fetch(userId);
        if (ban) {
          banned = true;
          embed.addFields(
            { name: 'Status', value: '\uD83D\uDD28 Banned from server', inline: true },
            { name: 'Ban Reason', value: ban.reason || 'No reason provided', inline: true },
          );
        }
      } catch {
        embed.addFields({ name: 'Status', value: '\u274C Not in server', inline: true });
      }
    }

    // Warning history
    const warnings = getWarnings(interaction.guild.id, userId);
    embed.addFields({ name: 'Total Warnings', value: `${warnings.length}`, inline: true });

    if (warnings.length > 0) {
      const warningLines = warnings.slice(-5).map((w, i) => {
        const date = new Date(w.created_at + 'Z').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
        const type = w.type === 'crosspost' ? '\uD83D\uDD04' : '\u26A0\uFE0F';
        return `${type} ${date} \u2014 ${w.reason.length > 80 ? w.reason.slice(0, 80) + '...' : w.reason}`;
      });
      if (warnings.length > 5) {
        warningLines.unshift(`*Showing last 5 of ${warnings.length} warnings:*`);
      }
      embed.addFields({ name: 'Warning History', value: warningLines.join('\n'), inline: false });
    }

    // Mod actions targeting this user
    const modActions = db.prepare(
      `SELECT action_type, COUNT(*) as count FROM mod_actions WHERE guild_id = ? AND target_id = ? GROUP BY action_type`
    ).all(interaction.guild.id, userId);

    if (modActions.length > 0) {
      const actionSummary = modActions.map(a => `**${a.action_type}:** ${a.count}`).join(' | ');
      embed.addFields({ name: 'Mod Action History', value: actionSummary, inline: false });
    }

    return interaction.editReply({ embeds: [embed] });
  },
};
