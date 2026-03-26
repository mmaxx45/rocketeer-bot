const express = require('express');
const { getSettings, getGiveawayHostUsers } = require('../../database/settings');

function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.redirect('/');
}

module.exports = function (client) {
  const router = express.Router();
  router.use(ensureAuthenticated);

  // Check if user is allowed to host giveaways in this guild
  function canAccessGiveaways(user, guildId) {
    // User must be in the guild (from OAuth guilds list)
    const userGuild = (user.guilds || []).find(g => g.id === guildId);
    if (!userGuild) return false;

    // Check if user has ManageGuild permission (admin)
    const perms = BigInt(userGuild.permissions);
    const MANAGE_GUILD = BigInt(0x20);
    if ((perms & MANAGE_GUILD) === MANAGE_GUILD) return true;

    // Check giveaway-specific permissions
    const settings = getSettings(guildId);

    // Check host role — user must have it in Discord
    // We can't check roles from OAuth data, but we can check if user is in the host users list
    const hostUsers = getGiveawayHostUsers(guildId);
    if (hostUsers.includes(user.id)) return true;

    // Check if user has the host role via bot's guild member cache
    if (settings.giveaway_host_role_id) {
      const botGuild = client.guilds.cache.get(guildId);
      if (botGuild) {
        const member = botGuild.members.cache.get(user.id);
        if (member && member.roles.cache.has(settings.giveaway_host_role_id)) return true;
      }
    }

    return false;
  }

  // Giveaway host page
  router.get('/:guildId', (req, res) => {
    const { guildId } = req.params;

    if (!canAccessGiveaways(req.user, guildId)) {
      return res.status(403).send('You do not have permission to manage giveaways in this server.');
    }

    const botGuild = client.guilds.cache.get(guildId);
    if (!botGuild) return res.status(404).send('Bot is not in this guild');

    const settings = getSettings(guildId);

    // If giveaway channel is locked, only show that channel
    let channels;
    if (settings.giveaway_channel_id) {
      const locked = botGuild.channels.cache.get(settings.giveaway_channel_id);
      channels = locked ? [{ id: locked.id, name: locked.name }] : [];
    } else {
      channels = botGuild.channels.cache
        .filter(c => c.type === 0)
        .sort((a, b) => a.position - b.position)
        .map(c => ({ id: c.id, name: c.name }));
    }

    const guild = { id: botGuild.id, name: botGuild.name, icon: botGuild.iconURL() };
    res.render('giveaways', {
      user: req.user,
      guild,
      title: guild.name + ' - Giveaways',
      channels,
      settings,
    });
  });

  return router;
};
