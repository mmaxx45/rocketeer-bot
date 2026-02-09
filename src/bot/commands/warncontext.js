const { ApplicationCommandType, ContextMenuCommandBuilder, PermissionFlagsBits, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');

module.exports = {
  data: new ContextMenuCommandBuilder()
    .setName('Warn User')
    .setType(ApplicationCommandType.Message)
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

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

    modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));

    await interaction.showModal(modal);
  },
};
