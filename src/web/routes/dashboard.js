const express = require('express');
const { getSettings, getExemptChannels } = require('../../database/settings');
const { getAllGuildWarnings } = require('../../database/warnings');
const { db } = require('../../database/db');

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

    const categories = botGuild.channels.cache
      .filter(c => c.type === 4) // GuildCategory
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
      categories,
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

  // Stats page
  router.get('/guild/:guildId/stats', (req, res) => {
    const { guildId } = req.params;

    if (!userCanManageGuild(req.user, guildId)) {
      return res.status(403).send('Forbidden');
    }

    const botGuild = client.guilds.cache.get(guildId);
    if (!botGuild) return res.status(404).send('Bot is not in this guild');

    // Total warnings
    const totalWarnings = db.prepare('SELECT COUNT(*) as count FROM warnings WHERE guild_id = ?').get(guildId).count;

    // Total bans
    const totalBans = db.prepare("SELECT COUNT(*) as count FROM mod_actions WHERE guild_id = ? AND action_type = 'ban'").get(guildId).count;

    // Total crosspost incidents
    const totalCrosspostIncidents = db.prepare('SELECT COUNT(*) as count FROM crosspost_incidents WHERE guild_id = ?').get(guildId).count;

    // Active moderators (distinct mods who issued warnings)
    const activeMods = db.prepare('SELECT COUNT(DISTINCT moderator_id) as count FROM warnings WHERE guild_id = ?').get(guildId).count;

    // Warnings over time (last 8 weeks)
    const warningsOverTime = [];
    for (let i = 7; i >= 0; i--) {
      const row = db.prepare(`
        SELECT COUNT(*) as count FROM warnings
        WHERE guild_id = ?
          AND created_at >= datetime('now', ? || ' days')
          AND created_at < datetime('now', ? || ' days')
      `).get(guildId, String(-i * 7), String(-(i - 1) * 7));

      const weekStart = new Date();
      weekStart.setDate(weekStart.getDate() - i * 7);
      const month = weekStart.toLocaleString('en-US', { month: 'short' });
      const day = weekStart.getDate();
      warningsOverTime.push({
        label: `${month} ${day}`,
        count: row.count,
      });
    }

    // Most warned users (top 10)
    const mostWarnedUsers = db.prepare(`
      SELECT user_id, COUNT(*) as count FROM warnings
      WHERE guild_id = ?
      GROUP BY user_id
      ORDER BY count DESC
      LIMIT 10
    `).all(guildId);

    // Most active moderators (top 10, based on mod_actions which logs all actions)
    const mostActiveMods = db.prepare(`
      SELECT moderator_id, COUNT(*) as count FROM mod_actions
      WHERE guild_id = ?
      GROUP BY moderator_id
      ORDER BY count DESC
      LIMIT 10
    `).all(guildId);

    // Warning reasons breakdown
    const warningReasons = db.prepare(`
      SELECT reason, COUNT(*) as count FROM warnings
      WHERE guild_id = ?
      GROUP BY reason
      ORDER BY count DESC
      LIMIT 15
    `).all(guildId);

    // Recent activity (last 10 mod actions)
    const recentActivity = db.prepare(`
      SELECT * FROM mod_actions
      WHERE guild_id = ?
      ORDER BY created_at DESC
      LIMIT 10
    `).all(guildId);

    const guild = { id: botGuild.id, name: botGuild.name, icon: botGuild.iconURL() };
    res.render('stats', {
      user: req.user,
      guild,
      title: guild.name + ' - Statistics',
      stats: {
        totalWarnings,
        totalBans,
        totalCrosspostIncidents,
        activeMods,
        warningsOverTime,
        mostWarnedUsers,
        mostActiveMods,
        warningReasons,
        recentActivity,
      },
    });
  });

  return router;
};
