const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const logger = require('../../logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setup-hwid-panel')
    .setDescription('Post the HWID reset request button in this channel')
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
    const title = interaction.options.getString('title') || 'HWID Reset';
    const description = interaction.options.getString('description') || 'Need to reset your hardware ID? Click the button below and provide a reason. Your license will be looked up automatically.';
    const buttonLabel = interaction.options.getString('button-label') || 'Request HWID Reset';

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(description)
      .setColor(0xE67E22)
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('request_hwid_reset')
        .setLabel(buttonLabel)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('🔄')
    );

    await interaction.channel.send({ embeds: [embed], components: [row] });
    await interaction.reply({ content: 'HWID reset panel posted.', ephemeral: true });
    logger.info(`HWID reset panel set up in #${interaction.channel.name} by ${interaction.user.tag}`);
  },
};
