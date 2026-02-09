const express = require('express');
const { getSettings, getExemptChannels } = require('../../database/settings');
const { getAllGuildWarnings } = require('../../database/warnings');

const MANAGE_GUILD = BigInt(0x20);

function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.redirect('/');
}

function userCanManageGuild(user, guildId) {
  if (!user || !user.guilds) return false;
  const guild = user.guilds.find(g => g.id === guildId);
  if (!guild) return false;
  const permissions = BigInt(guild.permissions);
  return (permissions & MANAGE_GUILD) === MANAGE_GUILD;
}

module.exports = function (client) {
  const router = express.Router();
  router.use(ensureAuthenticated);

  // Guild selection
  router.get('/', (req, res) => {
    const botGuildIds = new Set(client.guilds.cache.map(g => g.id));
    const manageableGuilds = (req.user.guilds || [])
      .filter(g => {
        const perms = BigInt(g.permissions);
        return (perms & MANAGE_GUILD) === MANAGE_GUILD && botGuildIds.has(g.id);
      })
      .map(g => {
        const botGuild = client.guilds.cache.get(g.id);
        return {
          id: g.id,
          name: g.name,
          icon: g.icon,
          memberCount: botGuild ? botGuild.memberCount : '?',
        };
      });

    res.render('dashboard', { user: req.user, guilds: manageableGuilds, title: 'Dashboard' });
  });

  // Guild settings page
  router.get('/guild/:guildId', (req, res) => {
    const { guildId } = req.params;

    if (!userCanManageGuild(req.user, guildId)) {
      return res.status(403).send('Forbidden');
    }

    const botGuild = client.guilds.cache.get(guildId);
    if (!botGuild) return res.status(404).send('Bot is not in this guild');

    const settings = getSettings(guildId);
    const exemptChannels = getExemptChannels(guildId);

    const roles = botGuild.roles.cache
      .filter(r => r.id !== guildId) // exclude @everyone
      .sort((a, b) => b.position - a.position)
      .map(r => ({ id: r.id, name: r.name, color: r.hexColor }));

    const channels = botGuild.channels.cache
      .filter(c => c.type === 0) // GuildText
      .sort((a, b) => a.position - b.position)
      .map(c => ({ id: c.id, name: c.name }));

    const guild = { id: botGuild.id, name: botGuild.name, icon: botGuild.iconURL() };
    res.render('guild', {
      user: req.user,
      guild,
      title: guild.name + ' Settings',
      settings,
      exemptChannels,
      roles,
      channels,
    });
  });

  // Warnings page
  router.get('/guild/:guildId/warnings', (req, res) => {
    const { guildId } = req.params;

    if (!userCanManageGuild(req.user, guildId)) {
      return res.status(403).send('Forbidden');
    }

    const botGuild = client.guilds.cache.get(guildId);
    if (!botGuild) return res.status(404).send('Bot is not in this guild');

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 25;
    const offset = (page - 1) * limit;

    const { rows: warnings, total } = getAllGuildWarnings(guildId, limit, offset);
    const totalPages = Math.ceil(total / limit);

    const guild = { id: botGuild.id, name: botGuild.name, icon: botGuild.iconURL() };
    res.render('warnings', {
      user: req.user,
      guild,
      title: guild.name + ' - Warnings',
      warnings,
      page,
      totalPages,
      total,
    });
  });

  return router;
};
