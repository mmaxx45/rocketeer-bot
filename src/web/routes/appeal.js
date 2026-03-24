const express = require('express');
const { ChannelType, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getSettings } = require('../../database/settings');
const { createAppeal, getOpenAppeal } = require('../../database/appeals');
const logger = require('../../logger');

module.exports = function (client) {
  const router = express.Router();

  // GET /appeal/:guildId — public appeal form
  router.get('/:guildId', async (req, res) => {
    const { guildId } = req.params;

    try {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) {
        return res.status(404).render('appeal', {
          title: 'Appeal Ban',
          guild: null,
          error: 'Server not found.',
          success: null,
        });
      }

      const settings = getSettings(guildId);
      if (!settings.appeal_enabled || !settings.appeal_category_id) {
        return res.status(403).render('appeal', {
          title: 'Appeal Ban',
          guild: { id: guild.id, name: guild.name, icon: guild.iconURL({ size: 128 }) },
          error: 'Ban appeals are not enabled on this server.',
          success: null,
        });
      }

      res.render('appeal', {
        title: `Appeal Ban — ${guild.name}`,
        guild: { id: guild.id, name: guild.name, icon: guild.iconURL({ size: 128 }) },
        error: null,
        success: null,
      });
    } catch (err) {
      logger.error(`Failed to load appeal page: ${err.message}`);
      res.status(500).render('appeal', {
        title: 'Appeal Ban',
        guild: null,
        error: 'Something went wrong. Please try again later.',
        success: null,
      });
    }
  });

  // POST /appeal/:guildId/submit — public appeal submission
  router.post('/:guildId/submit', express.json({ limit: '10kb' }), async (req, res) => {
    const { guildId } = req.params;
    const { user_id, reason } = req.body;

    // Validate input
    if (!user_id || !/^\d{17,20}$/.test(user_id)) {
      return res.status(400).json({ error: 'Please enter a valid Discord User ID (17-20 digits).' });
    }
    if (!reason || reason.trim().length === 0) {
      return res.status(400).json({ error: 'Please provide a reason for your appeal.' });
    }
    if (reason.length > 1000) {
      return res.status(400).json({ error: 'Appeal reason must be under 1000 characters.' });
    }

    try {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) {
        return res.status(404).json({ error: 'Server not found.' });
      }

      const settings = getSettings(guildId);
      if (!settings.appeal_enabled || !settings.appeal_category_id) {
        return res.status(403).json({ error: 'Ban appeals are not enabled on this server.' });
      }

      // Verify user is actually banned
      let banReason = 'No reason provided';
      try {
        const banInfo = await guild.bans.fetch(user_id);
        if (banInfo.reason) banReason = banInfo.reason;
      } catch {
        return res.status(400).json({ error: 'This User ID is not currently banned from this server.' });
      }

      // Check for existing open appeal
      const existingAppeal = getOpenAppeal(guildId, user_id);
      if (existingAppeal) {
        return res.status(409).json({ error: 'You already have a pending appeal. Please wait for a moderator to review it.' });
      }

      // Fetch user info from Discord
      let username = user_id;
      let avatarURL = null;
      let accountCreated = null;
      try {
        const discordUser = await client.users.fetch(user_id);
        username = discordUser.username;
        avatarURL = discordUser.displayAvatarURL({ size: 128 });
        accountCreated = discordUser.createdAt;
      } catch {
        // User may have deleted account — proceed with ID only
      }

      // Create appeal channel
      const overwrites = [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages] },
      ];

      if (settings.moderator_role_id) {
        overwrites.push({ id: settings.moderator_role_id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
      }

      const channelName = `appeal-${username}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 100);
      const channel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: settings.appeal_category_id,
        permissionOverwrites: overwrites,
      });

      // Record appeal in database
      const appealId = createAppeal(guildId, user_id, channel.id, banReason);

      // Build the appeal info embed
      const appealEmbed = new EmbedBuilder()
        .setTitle('Ban Appeal')
        .setColor(0xFFA500)
        .addFields(
          { name: 'User', value: `${username} (${user_id})`, inline: true },
          { name: 'Ban Reason', value: banReason },
          { name: 'Appeal Reason', value: reason.trim().slice(0, 1024) },
        )
        .setTimestamp();

      if (avatarURL) appealEmbed.setThumbnail(avatarURL);
      if (accountCreated) {
        appealEmbed.addFields({ name: 'Account Created', value: `<t:${Math.floor(accountCreated.getTime() / 1000)}:R>`, inline: true });
      }

      const appealRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`appeal_accept:${appealId}`)
          .setLabel('Accept (Unban)')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`appeal_reject:${appealId}`)
          .setLabel('Reject')
          .setStyle(ButtonStyle.Danger),
      );

      await channel.send({ embeds: [appealEmbed], components: [appealRow] });

      // Ping the moderator role
      if (settings.moderator_role_id) {
        await channel.send({
          content: `<@&${settings.moderator_role_id}> — A new ban appeal has been submitted.`,
          allowedMentions: { roles: [settings.moderator_role_id] },
        });
      }

      logger.info(`Web ban appeal created: user=${username}(${user_id}) guild=${guild.name} appealId=${appealId}`);
      res.json({ success: true, message: 'Your ban appeal has been submitted. A moderator will review it shortly.' });
    } catch (err) {
      logger.error(`Failed to create web ban appeal: ${err.message}`);
      res.status(500).json({ error: 'Failed to submit your appeal. Please try again later.' });
    }
  });

  return router;
};
