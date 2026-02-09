const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { clearUserWarnings, getWarningCount } = require('../../database/warnings');
const { getSettings } = require('../../database/settings');
const { isModerator } = require('../utils/permissions');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('clearwarnings')
    .setDescription('Clear all warnings for a user')
    .addUserOption(opt =>
      opt.setName('user').setDescription('The user to clear warnings for').setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  async execute(interaction) {
    const settings = getSettings(interaction.guild.id);

    if (!isModerator(interaction.member, settings)) {
      return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
    }

    const targetUser = interaction.options.getUser('user');
    const count = getWarningCount(interaction.guild.id, targetUser.id);

    if (count === 0) {
      return interaction.reply({ content: `${targetUser} has no warnings to clear.`, ephemeral: true });
    }

    clearUserWarnings(interaction.guild.id, targetUser.id);

    return interaction.reply({
      content: `Cleared **${count}** warning(s) for <@${targetUser.id}>.`,
      ephemeral: true,
    });
  },
};
