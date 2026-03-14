const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, MessageFlags } = require('discord.js');
const logger = require('../../logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setup-license-retrieval-panel')
    .setDescription('Post a button panel where users can retrieve their license key and loader')
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
    const title = interaction.options.getString('title') || 'Retrieve Your License';
    const description = interaction.options.getString('description') || 'Lost your license key or loader? Click the button below and a private ticket will be created with your license details.';
    const buttonLabel = interaction.options.getString('button-label') || 'Retrieve License';

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(description)
      .setColor(0x3498DB)
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('retrieve_license')
        .setLabel(buttonLabel)
        .setStyle(ButtonStyle.Primary)
        .setEmoji('🔑')
    );

    await interaction.channel.send({ embeds: [embed], components: [row] });
    await interaction.reply({ content: 'License retrieval panel posted.', flags: MessageFlags.Ephemeral });
    logger.info(`License retrieval panel set up in #${interaction.channel.name} by ${interaction.user.username}`);
  },
};
