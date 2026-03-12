const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const logger = require('../../logger');
const { getSettings } = require('../../database/settings');
const { getOpenTicketByChannel, closeTicket } = require('../../database/tickets');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('close-ticket')
    .setDescription('Close the current ticket channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    const settings = getSettings(interaction.guild.id);

    // Permission check: admin or ticket admin role
    const hasPermission = interaction.member.permissions.has(PermissionFlagsBits.Administrator) ||
      (settings.ticket_admin_role_id && interaction.member.roles.cache.has(settings.ticket_admin_role_id));

    if (!hasPermission) {
      return interaction.reply({ content: 'You do not have permission to close tickets.', flags: MessageFlags.Ephemeral });
    }

    const ticket = getOpenTicketByChannel(interaction.channel.id);
    if (!ticket) {
      return interaction.reply({ content: 'This channel is not an open ticket.', flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply();

    // Log transcript to ticket log channel before closing
    if (settings.ticket_log_channel_id) {
      try {
        const logChannel = await interaction.guild.channels.fetch(settings.ticket_log_channel_id);
        if (logChannel) {
          const messages = await interaction.channel.messages.fetch({ limit: 100 });
          const transcript = messages
            .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
            .map(m => `[${m.createdAt.toISOString()}] ${m.author.tag}: ${m.content || '(embed/attachment)'}`)
            .join('\n');

          const logEmbed = new EmbedBuilder()
            .setTitle('Ticket Closed')
            .setColor(0xE74C3C)
            .addFields(
              { name: 'Ticket', value: `#${interaction.channel.name}`, inline: true },
              { name: 'Customer', value: `<@${ticket.user_id}>`, inline: true },
              { name: 'Closed by', value: `<@${interaction.user.id}>`, inline: true },
            )
            .setTimestamp();

          // Send transcript as a file attachment if it's long
          const files = [];
          if (transcript.length > 0) {
            files.push({
              attachment: Buffer.from(transcript, 'utf-8'),
              name: `transcript-${interaction.channel.name}.txt`,
            });
          }

          await logChannel.send({ embeds: [logEmbed], files });
        }
      } catch (err) {
        logger.warn(`Failed to log ticket transcript: ${err.message}`);
      }
    }

    closeTicket(ticket.id, interaction.user.id);

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle('Ticket Closed')
          .setDescription(`This ticket was closed by <@${interaction.user.id}>. This channel will be deleted in 5 seconds.`)
          .setColor(0xE74C3C)
          .setTimestamp(),
      ],
    });

    // Delete the channel after a short delay
    setTimeout(async () => {
      try {
        await interaction.channel.delete('Ticket closed');
      } catch (err) {
        logger.warn(`Failed to delete ticket channel: ${err.message}`);
      }
    }, 5000);

    logger.info(`Ticket closed: channel=${interaction.channel.name} closedBy=${interaction.user.tag}`);
  },
};
