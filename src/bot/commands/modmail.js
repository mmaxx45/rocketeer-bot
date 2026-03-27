const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ChannelType, MessageFlags } = require('discord.js');
const { getSettings, updateSetting } = require('../../database/settings');
const { getOpenThreadByChannel, closeThread, getAllOpenThreads } = require('../../database/modmail');
const { isModerator } = require('../utils/permissions');
const logger = require('../../logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('modmail')
    .setDescription('Manage modmail system')
    .addSubcommand(sub =>
      sub.setName('setup')
        .setDescription('Configure the modmail system')
        .addChannelOption(opt =>
          opt.setName('category')
            .setDescription('Category channel for modmail threads')
            .addChannelTypes(ChannelType.GuildCategory)
            .setRequired(true)
        )
        .addBooleanOption(opt =>
          opt.setName('enabled')
            .setDescription('Enable or disable modmail')
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('close')
        .setDescription('Close the current modmail thread')
    )
    .addSubcommand(sub =>
      sub.setName('threads')
        .setDescription('List all open modmail threads')
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  async execute(interaction) {
    const settings = getSettings(interaction.guild.id);

    if (!isModerator(interaction.member, settings)) {
      return interaction.reply({ content: 'You do not have permission to use this command.', flags: MessageFlags.Ephemeral });
    }

    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'setup') {
      const category = interaction.options.getChannel('category');
      const enabled = interaction.options.getBoolean('enabled');

      updateSetting(interaction.guild.id, 'modmail_category_id', category.id);
      updateSetting(interaction.guild.id, 'modmail_enabled', enabled ? 1 : 0);

      const embed = new EmbedBuilder()
        .setTitle('Modmail Configuration Updated')
        .setColor(0x2ECC71)
        .addFields(
          { name: 'Category', value: `<#${category.id}>`, inline: true },
          { name: 'Status', value: enabled ? 'Enabled' : 'Disabled', inline: true },
        )
        .setTimestamp();

      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    if (subcommand === 'close') {
      const thread = getOpenThreadByChannel(interaction.channel.id);

      if (!thread) {
        return interaction.reply({ content: 'This channel is not an active modmail thread.', flags: MessageFlags.Ephemeral });
      }

      try {
        // Notify the user
        try {
          const user = await interaction.client.users.fetch(thread.user_id);
          await user.send({
            embeds: [
              new EmbedBuilder()
                .setTitle('Modmail Thread Closed')
                .setDescription(`Your modmail thread in **${interaction.guild.name}** has been closed by a moderator. If you need further assistance, send another message.`)
                .setColor(0xE74C3C)
                .setTimestamp(),
            ],
          });
        } catch (err) {
          logger.warn(`Failed to notify user of modmail closure: ${err.message}`);
        }

        // Close in database
        closeThread(thread.id, interaction.user.id);

        await interaction.reply({
          embeds: [
            new EmbedBuilder()
              .setTitle('Thread Closed')
              .setDescription(`This modmail thread was closed by <@${interaction.user.id}>. This channel will be deleted in 5 seconds.`)
              .setColor(0xE74C3C)
              .setTimestamp(),
          ],
        });

        // Delete the channel after a brief delay
        setTimeout(async () => {
          try {
            await interaction.channel.delete('Modmail thread closed');
          } catch (err) {
            logger.warn(`Failed to delete modmail channel: ${err.message}`);
          }
        }, 5000);

        logger.info(`Modmail thread closed via command: channel=${interaction.channel.id} closedBy=${interaction.user.username}`);
      } catch (err) {
        logger.error(`Failed to close modmail thread: ${err.message}`);
        return interaction.reply({ content: `Failed to close thread: ${err.message}`, flags: MessageFlags.Ephemeral });
      }
      return;
    }

    if (subcommand === 'threads') {
      const threads = getAllOpenThreads(interaction.guild.id);

      if (threads.length === 0) {
        return interaction.reply({ content: 'No open modmail threads.', flags: MessageFlags.Ephemeral });
      }

      const lines = [];
      for (const t of threads) {
        let userName = `<@${t.user_id}>`;
        const createdAt = Math.floor(new Date(t.created_at + 'Z').getTime() / 1000);
        lines.push(`<#${t.channel_id}> - ${userName} - Opened <t:${createdAt}:R>`);
      }

      let description = lines.join('\n');
      if (description.length > 4096) {
        description = description.slice(0, 4093) + '...';
      }

      const embed = new EmbedBuilder()
        .setTitle(`Open Modmail Threads (${threads.length})`)
        .setColor(0x3498DB)
        .setDescription(description)
        .setTimestamp();

      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }
  },
};
