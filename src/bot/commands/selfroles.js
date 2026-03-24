const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, MessageFlags } = require('discord.js');
const logger = require('../../logger');
const { createPanel, getPanels, getPanel, addRoleOption, removeRoleOption, getRoleOptions, deletePanel } = require('../../database/selfRoles');

function buildPanelEmbed(title, description, roleOptions, guild) {
  const embed = new EmbedBuilder()
    .setTitle(title || 'Self Roles')
    .setColor(0x5865F2);

  if (description) {
    embed.setDescription(description);
  } else if (roleOptions.length === 0) {
    embed.setDescription('No roles have been added yet. An admin can add roles with `/selfroles add`.');
  } else {
    embed.setDescription('Click a button below to toggle a role.');
  }

  return embed;
}

function buildPanelButtons(panelId, roleOptions, guild) {
  const rows = [];
  let currentRow = new ActionRowBuilder();
  let buttonCount = 0;

  for (const option of roleOptions) {
    if (buttonCount === 5) {
      rows.push(currentRow);
      if (rows.length >= 5) break; // Max 5 rows (25 buttons)
      currentRow = new ActionRowBuilder();
      buttonCount = 0;
    }

    const role = guild.roles.cache.get(option.role_id);
    const label = option.label || (role ? role.name : 'Unknown Role');

    const button = new ButtonBuilder()
      .setCustomId(`selfrole:${panelId}:${option.role_id}`)
      .setLabel(label.slice(0, 80))
      .setStyle(ButtonStyle.Secondary);

    if (option.emoji) {
      try {
        button.setEmoji(option.emoji);
      } catch {
        // Invalid emoji, skip it
      }
    }

    currentRow.addComponents(button);
    buttonCount++;
  }

  if (buttonCount > 0) {
    rows.push(currentRow);
  }

  return rows;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('selfroles')
    .setDescription('Manage self-assignable role panels')
    .addSubcommand(sub =>
      sub.setName('setup')
        .setDescription('Create a new self-roles panel in a channel')
        .addChannelOption(opt =>
          opt.setName('channel')
            .setDescription('Channel to post the panel in')
            .setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('title')
            .setDescription('Panel embed title')
            .setRequired(false)
        )
        .addStringOption(opt =>
          opt.setName('description')
            .setDescription('Panel embed description')
            .setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub.setName('add')
        .setDescription('Add a role to a self-roles panel')
        .addRoleOption(opt =>
          opt.setName('role')
            .setDescription('Role to add')
            .setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('label')
            .setDescription('Custom button label (defaults to role name)')
            .setRequired(false)
        )
        .addStringOption(opt =>
          opt.setName('emoji')
            .setDescription('Button emoji')
            .setRequired(false)
        )
        .addIntegerOption(opt =>
          opt.setName('panel')
            .setDescription('Panel ID (defaults to most recent)')
            .setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub.setName('remove')
        .setDescription('Remove a role from a self-roles panel')
        .addRoleOption(opt =>
          opt.setName('role')
            .setDescription('Role to remove')
            .setRequired(true)
        )
        .addIntegerOption(opt =>
          opt.setName('panel')
            .setDescription('Panel ID (defaults to most recent)')
            .setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub.setName('refresh')
        .setDescription('Refresh the panel message with current roles')
        .addIntegerOption(opt =>
          opt.setName('panel')
            .setDescription('Panel ID (defaults to most recent)')
            .setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub.setName('delete')
        .setDescription('Delete a self-roles panel')
        .addIntegerOption(opt =>
          opt.setName('panel')
            .setDescription('Panel ID (defaults to most recent)')
            .setRequired(false)
        )
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'setup') {
      const channel = interaction.options.getChannel('channel');
      const title = interaction.options.getString('title') || 'Self Roles';
      const description = interaction.options.getString('description') || null;

      // Verify the channel is a text channel we can send to
      if (!channel.isTextBased()) {
        return interaction.reply({ content: 'Please select a text channel.', flags: MessageFlags.Ephemeral });
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      try {
        const embed = buildPanelEmbed(title, description, [], interaction.guild);

        const message = await channel.send({ embeds: [embed], components: [] });
        const panel = createPanel(interaction.guild.id, channel.id, message.id, title, description);

        await interaction.editReply({ content: `Self-roles panel created in <#${channel.id}> (Panel ID: **${panel.id}**). Use \`/selfroles add\` to add roles.` });
        logger.info(`Self-roles panel ${panel.id} created in #${channel.name} by ${interaction.user.username}`);
      } catch (err) {
        logger.error(`Failed to create self-roles panel: ${err.message}`);
        await interaction.editReply({ content: `Failed to create panel: ${err.message}` });
      }
      return;
    }

    if (subcommand === 'add') {
      const role = interaction.options.getRole('role');
      const label = interaction.options.getString('label') || null;
      const emoji = interaction.options.getString('emoji') || null;
      const panelId = interaction.options.getInteger('panel');

      let panel;
      if (panelId) {
        panel = getPanel(panelId);
        if (!panel || panel.guild_id !== interaction.guild.id) {
          return interaction.reply({ content: 'Panel not found.', flags: MessageFlags.Ephemeral });
        }
      } else {
        const panels = getPanels(interaction.guild.id);
        if (panels.length === 0) {
          return interaction.reply({ content: 'No self-roles panels exist. Create one first with `/selfroles setup`.', flags: MessageFlags.Ephemeral });
        }
        panel = panels[0]; // Most recent
      }

      // Check if role is already on the panel
      const existing = getRoleOptions(panel.id);
      if (existing.find(o => o.role_id === role.id)) {
        return interaction.reply({ content: `**${role.name}** is already on this panel.`, flags: MessageFlags.Ephemeral });
      }

      // Max 25 roles per panel (5 rows x 5 buttons)
      if (existing.length >= 25) {
        return interaction.reply({ content: 'This panel already has the maximum of 25 roles.', flags: MessageFlags.Ephemeral });
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      try {
        const options = addRoleOption(panel.id, role.id, label, emoji, null);

        // Update the panel message
        const channel = await interaction.guild.channels.fetch(panel.channel_id);
        const message = await channel.messages.fetch(panel.message_id);

        const embed = buildPanelEmbed(panel.title, panel.description, options, interaction.guild);
        const rows = buildPanelButtons(panel.id, options, interaction.guild);

        await message.edit({ embeds: [embed], components: rows });

        await interaction.editReply({ content: `Added **${role.name}** to the self-roles panel (ID: ${panel.id}).` });
        logger.info(`Role ${role.name} added to self-roles panel ${panel.id} by ${interaction.user.username}`);
      } catch (err) {
        logger.error(`Failed to add role to self-roles panel: ${err.message}`);
        await interaction.editReply({ content: `Failed to add role: ${err.message}` });
      }
      return;
    }

    if (subcommand === 'remove') {
      const role = interaction.options.getRole('role');
      const panelId = interaction.options.getInteger('panel');

      let panel;
      if (panelId) {
        panel = getPanel(panelId);
        if (!panel || panel.guild_id !== interaction.guild.id) {
          return interaction.reply({ content: 'Panel not found.', flags: MessageFlags.Ephemeral });
        }
      } else {
        const panels = getPanels(interaction.guild.id);
        if (panels.length === 0) {
          return interaction.reply({ content: 'No self-roles panels exist.', flags: MessageFlags.Ephemeral });
        }
        panel = panels[0];
      }

      const existing = getRoleOptions(panel.id);
      if (!existing.find(o => o.role_id === role.id)) {
        return interaction.reply({ content: `**${role.name}** is not on this panel.`, flags: MessageFlags.Ephemeral });
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      try {
        removeRoleOption(panel.id, role.id);
        const options = getRoleOptions(panel.id);

        // Update the panel message
        const channel = await interaction.guild.channels.fetch(panel.channel_id);
        const message = await channel.messages.fetch(panel.message_id);

        const embed = buildPanelEmbed(panel.title, panel.description, options, interaction.guild);
        const rows = buildPanelButtons(panel.id, options, interaction.guild);

        await message.edit({ embeds: [embed], components: rows });

        await interaction.editReply({ content: `Removed **${role.name}** from the self-roles panel (ID: ${panel.id}).` });
        logger.info(`Role ${role.name} removed from self-roles panel ${panel.id} by ${interaction.user.username}`);
      } catch (err) {
        logger.error(`Failed to remove role from self-roles panel: ${err.message}`);
        await interaction.editReply({ content: `Failed to remove role: ${err.message}` });
      }
      return;
    }

    if (subcommand === 'refresh') {
      const panelId = interaction.options.getInteger('panel');

      let panel;
      if (panelId) {
        panel = getPanel(panelId);
        if (!panel || panel.guild_id !== interaction.guild.id) {
          return interaction.reply({ content: 'Panel not found.', flags: MessageFlags.Ephemeral });
        }
      } else {
        const panels = getPanels(interaction.guild.id);
        if (panels.length === 0) {
          return interaction.reply({ content: 'No self-roles panels exist.', flags: MessageFlags.Ephemeral });
        }
        panel = panels[0];
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      try {
        const options = getRoleOptions(panel.id);
        const channel = await interaction.guild.channels.fetch(panel.channel_id);
        const message = await channel.messages.fetch(panel.message_id);

        const embed = buildPanelEmbed(panel.title, panel.description, options, interaction.guild);
        const rows = buildPanelButtons(panel.id, options, interaction.guild);

        await message.edit({ embeds: [embed], components: rows });

        await interaction.editReply({ content: `Self-roles panel (ID: ${panel.id}) has been refreshed.` });
        logger.info(`Self-roles panel ${panel.id} refreshed by ${interaction.user.username}`);
      } catch (err) {
        logger.error(`Failed to refresh self-roles panel: ${err.message}`);
        await interaction.editReply({ content: `Failed to refresh panel: ${err.message}` });
      }
      return;
    }

    if (subcommand === 'delete') {
      const panelId = interaction.options.getInteger('panel');

      let panel;
      if (panelId) {
        panel = getPanel(panelId);
        if (!panel || panel.guild_id !== interaction.guild.id) {
          return interaction.reply({ content: 'Panel not found.', flags: MessageFlags.Ephemeral });
        }
      } else {
        const panels = getPanels(interaction.guild.id);
        if (panels.length === 0) {
          return interaction.reply({ content: 'No self-roles panels exist.', flags: MessageFlags.Ephemeral });
        }
        panel = panels[0];
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      try {
        // Try to delete the panel message
        try {
          const channel = await interaction.guild.channels.fetch(panel.channel_id);
          const message = await channel.messages.fetch(panel.message_id);
          await message.delete();
        } catch {
          // Message may have already been deleted
        }

        deletePanel(panel.id);

        await interaction.editReply({ content: `Self-roles panel (ID: ${panel.id}) has been deleted.` });
        logger.info(`Self-roles panel ${panel.id} deleted by ${interaction.user.username}`);
      } catch (err) {
        logger.error(`Failed to delete self-roles panel: ${err.message}`);
        await interaction.editReply({ content: `Failed to delete panel: ${err.message}` });
      }
      return;
    }
  },
};
