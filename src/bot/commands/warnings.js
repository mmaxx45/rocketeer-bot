const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { getWarnings } = require('../../database/warnings');
const { getSettings } = require('../../database/settings');
const { isModerator } = require('../utils/permissions');
const { buildWarningsEmbed } = require('../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('warnings')
    .setDescription('View warnings for a user')
    .addUserOption(opt =>
      opt.setName('user').setDescription('The user to check').setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  async execute(interaction) {
    const settings = getSettings(interaction.guild.id);

    if (!isModerator(interaction.member, settings)) {
      return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
    }

    const targetUser = interaction.options.getUser('user');
    const warnings = getWarnings(interaction.guild.id, targetUser.id);
    const embed = buildWarningsEmbed(warnings, targetUser, interaction.guild);

    return interaction.reply({ embeds: [embed], ephemeral: true });
  },
};
