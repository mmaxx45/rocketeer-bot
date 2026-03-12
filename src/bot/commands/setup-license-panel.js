const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, MessageFlags } = require('discord.js');
const logger = require('../../logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setup-license-panel')
    .setDescription('Post the license purchase button in this channel')
    .addStringOption(opt =>
      opt.setName('title').setDescription('Embed title').setRequired(false)
    )
    .addStringOption(opt =>
      opt.setName('description').setDescription('Embed description').setRequired(false)
    )
    .addStringOption(opt =>
      opt.setName('button-label').setDescription('Button text').setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    const title = interaction.options.getString('title') || 'Get a License';
    const description = interaction.options.getString('description') || 'Click the button below to open a ticket and purchase a license. An admin will assist you shortly.';
    const buttonLabel = interaction.options.getString('button-label') || 'Purchase License';

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(description)
      .setColor(0x5865F2)
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('open_license_ticket')
        .setLabel(buttonLabel)
        .setStyle(ButtonStyle.Primary)
        .setEmoji('🎟️')
    );

    await interaction.channel.send({ embeds: [embed], components: [row] });
    await interaction.reply({ content: 'License panel posted.', flags: MessageFlags.Ephemeral });
    logger.info(`License panel set up in #${interaction.channel.name} by ${interaction.user.tag}`);
  },
};
