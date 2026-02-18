const { SlashCommandBuilder } = require('discord.js');
const { getWarnings } = require('../../database/warnings');
const { buildWarningsEmbed } = require('../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('mywarnings')
    .setDescription('View your own warnings'),

  async execute(interaction) {
    const warnings = getWarnings(interaction.guild.id, interaction.user.id);
    const embed = buildWarningsEmbed(warnings, interaction.user, interaction.guild, false);
    embed.setTitle('Your Warnings');

    return interaction.reply({ embeds: [embed], ephemeral: true });
  },
};
