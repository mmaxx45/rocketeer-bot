const { ApplicationCommandType, ContextMenuCommandBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');

module.exports = {
  data: new ContextMenuCommandBuilder()
    .setName('Warn User')
    .setType(ApplicationCommandType.Message),

  async execute(interaction) {
    const targetMessage = interaction.targetMessage;
    const targetUser = targetMessage.author;

    if (targetUser.bot) {
      return interaction.reply({ content: 'You cannot warn a bot.', ephemeral: true });
    }

    // Store the target message ID in the modal custom ID so we can retrieve it on submit
    const modal = new ModalBuilder()
      .setCustomId(`warn_modal:${targetUser.id}:${targetMessage.id}:${targetMessage.channelId}`)
      .setTitle(`Warn ${targetUser.username}`);

    const reasonInput = new TextInputBuilder()
      .setCustomId('reason')
      .setLabel('Reason for warning')
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder('Enter the reason for this warning...')
      .setRequired(false)
      .setMaxLength(1024);

    const timeoutInput = new TextInputBuilder()
      .setCustomId('timeout')
      .setLabel('Timeout (optional)')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('e.g. 30s, 5m, 1h, 2d, 1w')
      .setRequired(false)
      .setMaxLength(20);

    modal.addComponents(
      new ActionRowBuilder().addComponents(reasonInput),
      new ActionRowBuilder().addComponents(timeoutInput),
    );

    await interaction.showModal(modal);
  },
};
