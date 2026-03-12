const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const logger = require('../../logger');
const config = require('../../config');
const { getSettings } = require('../../database/settings');
const { getOpenTicketByChannel } = require('../../database/tickets');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('create-license')
    .setDescription('Generate a license key for a user (use inside a ticket channel)')
    .addUserOption(opt =>
      opt.setName('user').setDescription('The user to create a license for').setRequired(true)
    )
    .addIntegerOption(opt =>
      opt.setName('days').setDescription('License duration in days (omit for lifetime)').setRequired(false)
        .setMinValue(1).setMaxValue(3650)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    const settings = getSettings(interaction.guild.id);

    // Permission check: admin or ticket admin role
    const hasPermission = interaction.member.permissions.has(PermissionFlagsBits.Administrator) ||
      (settings.ticket_admin_role_id && interaction.member.roles.cache.has(settings.ticket_admin_role_id));

    if (!hasPermission) {
      return interaction.reply({ content: 'You do not have permission to create licenses.', ephemeral: true });
    }

    // Check licensing API is configured
    if (!config.licensing.apiUrl || !config.licensing.apiKey) {
      return interaction.reply({ content: 'Licensing API is not configured. Set `LICENSING_API_URL` and `LICENSING_API_KEY` in the bot\'s `.env` file.', ephemeral: true });
    }

    const targetUser = interaction.options.getUser('user');
    const days = interaction.options.getInteger('days') || null;

    await interaction.deferReply();

    try {
      const res = await fetch(`${config.licensing.apiUrl}/api/v1/licenses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.licensing.apiKey}`,
        },
        body: JSON.stringify({
          discord_user: targetUser.username,
          expires_in_days: days,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        logger.error(`License API error: ${res.status} ${JSON.stringify(data)}`);
        return interaction.editReply({ content: `License API error (${res.status}): ${data.error || 'Unknown error'}` });
      }

      const embed = new EmbedBuilder()
        .setTitle('License Created')
        .setColor(0x2ECC71)
        .addFields(
          { name: 'User', value: `<@${targetUser.id}> (${targetUser.username})`, inline: true },
          { name: 'Duration', value: days ? `${days} day(s)` : 'Lifetime', inline: true },
          { name: 'License Key', value: `\`\`\`\n${data.license_key}\n\`\`\`` },
        )
        .setTimestamp();

      if (data.expires_at) {
        embed.addFields({ name: 'Expires', value: new Date(data.expires_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }), inline: true });
      }

      await interaction.editReply({ embeds: [embed] });

      // Log to ticket log channel if configured
      if (settings.ticket_log_channel_id) {
        try {
          const logChannel = await interaction.guild.channels.fetch(settings.ticket_log_channel_id);
          if (logChannel) {
            const logEmbed = new EmbedBuilder()
              .setTitle('License Provisioned')
              .setColor(0x2ECC71)
              .addFields(
                { name: 'User', value: `<@${targetUser.id}> (${targetUser.username})`, inline: true },
                { name: 'Issued by', value: `<@${interaction.user.id}>`, inline: true },
                { name: 'Duration', value: days ? `${days} day(s)` : 'Lifetime', inline: true },
                { name: 'Channel', value: `<#${interaction.channel.id}>`, inline: true },
              )
              .setTimestamp();
            await logChannel.send({ embeds: [logEmbed] });
          }
        } catch (err) {
          logger.warn(`Failed to post to ticket log channel: ${err.message}`);
        }
      }

      logger.info(`License created for ${targetUser.username} by ${interaction.user.tag} (${days ? days + ' days' : 'lifetime'})`);
    } catch (err) {
      logger.error(`Failed to create license: ${err.message}`);
      await interaction.editReply({ content: `Failed to contact licensing API: ${err.message}` });
    }
  },
};
