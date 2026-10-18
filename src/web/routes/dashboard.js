const express = require('express');
const { getSettings, getExemptChannels, getBannedDomains, getImageOnlyChannels } = require('../../database/settings');
const { getAllGuildWarnings } = require('../../database/warnings');
const { db } = require('../../database/db');
const { MANAGE_GUILD, userCanManageGuild } = require('../middleware/auth');

function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.redirect('/');
}

// In-memory username cache: id -> { name, ts }
const userNameCache = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

async function resolveUserNames(botGuild, userIds) {
  const map = {};
  const now = Date.now();
  const unique = [...new Set(userIds.filter(Boolean))];
  const uncached = [];

  // Check cache and guild member cache first (no API calls)
  for (const id of unique) {
    const cached = userNameCache.get(id);
    if (cached && now - cached.ts < CACHE_TTL) {
      map[id] = cached.name;
      continue;
    }
    const member = botGuild.members.cache.get(id);
    if (member) {
      map[id] = member.user.username;
      userNameCache.set(id, { name: member.user.username, ts: now });
      continue;
    }
    uncached.push(id);
  }

  if (uncached.length === 0) return map;

  // Batch-fetch guild members in one API call
  try {
    const fetched = await botGuild.members.fetch({ user: uncached });
    for (const [id, member] of fetched) {
      map[id] = member.user.username;
      userNameCache.set(id, { name: member.user.username, ts: now });
    }
  } catch {
    // partial failure is fine
  }

  // For any still missing (left the guild), check client user cache only — no extra API calls
  for (const id of uncached) {
    if (!map[id]) {
      const user = botGuild.client.users.cache.get(id);
      if (user) {
        map[id] = user.username;
        userNameCache.set(id, { name: user.username, ts: now });
      }
    }
  }

  return map;
}

// Express 4 does not catch rejected promises from async handlers.
const { asyncHandler } = require('../asyncHandler');

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
  router.get('/guild/:guildId', asyncHandler(async (req, res) => {
    const { guildId } = req.params;

    if (!userCanManageGuild(req.user, guildId)) {
      return res.status(403).send('Forbidden');
    }

    const botGuild = client.guilds.cache.get(guildId);
    if (!botGuild) return res.status(404).send('Bot is not in this guild');

    const settings = await getSettings(guildId);
    const exemptChannels = await getExemptChannels(guildId);
    const bannedDomains = await getBannedDomains(guildId);
    const imageOnlyChannels = await getImageOnlyChannels(guildId);

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

    const emojis = botGuild.emojis.cache
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(e => ({ id: e.id, name: e.name, animated: e.animated, identifier: e.animated ? `<a:${e.name}:${e.id}>` : `<:${e.name}:${e.id}>`, url: e.imageURL() }));

    const guild = { id: botGuild.id, name: botGuild.name, icon: botGuild.iconURL() };
    res.render('guild', {
      user: req.user,
      guild,
      title: guild.name + ' Settings',
      settings,
      exemptChannels,
      bannedDomains,
      imageOnlyChannels,
      roles,
      channels,
      categories,
      emojis,
    });
  }));

  // Warnings page
  router.get('/guild/:guildId/warnings', asyncHandler(async (req, res) => {
    const { guildId } = req.params;

    if (!userCanManageGuild(req.user, guildId)) {
      return res.status(403).send('Forbidden');
    }

    const botGuild = client.guilds.cache.get(guildId);
    if (!botGuild) return res.status(404).send('Bot is not in this guild');

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 25;
    const offset = (page - 1) * limit;

    const { rows: warnings, total } = await getAllGuildWarnings(guildId, limit, offset);
    const totalPages = Math.ceil(total / limit);

    const allIds = warnings.flatMap(w => [w.user_id, w.moderator_id]);
    const userMap = await resolveUserNames(botGuild, allIds);

    const guild = { id: botGuild.id, name: botGuild.name, icon: botGuild.iconURL() };
    res.render('warnings', {
      user: req.user,
      guild,
      title: guild.name + ' - Warnings',
      warnings,
      page,
      totalPages,
      total,
      userMap,
    });
  }));

  // Stats page
  router.get('/guild/:guildId/stats', asyncHandler(async (req, res) => {
    const { guildId } = req.params;

    if (!userCanManageGuild(req.user, guildId)) {
      return res.status(403).send('Forbidden');
    }

    const botGuild = client.guilds.cache.get(guildId);
    if (!botGuild) return res.status(404).send('Bot is not in this guild');

    // Total warnings
    const { count: totalWarnings } = await db.get('SELECT COUNT(*) as count FROM warnings WHERE guild_id = ?', [guildId]);

    // Total bans
    const { count: totalBans } = await db.get("SELECT COUNT(*) as count FROM mod_actions WHERE guild_id = ? AND action_type = 'ban'", [guildId]);

    // Total crosspost incidents
    const { count: totalCrosspostIncidents } = await db.get('SELECT COUNT(*) as count FROM crosspost_incidents WHERE guild_id = ?', [guildId]);

    // Active moderators (distinct human mods with actions in the last 30 days)
    const botId = client.user.id;
    const { count: activeMods } = await db.get(`
      SELECT COUNT(DISTINCT moderator_id) as count FROM mod_actions
      WHERE guild_id = ? AND moderator_id != ? AND created_at >= datetime('now', '-30 days')
    `, [guildId, botId]);

    // Most warned users (top 10)
    const mostWarnedUsers = await db.all(`
      SELECT user_id, COUNT(*) as count FROM warnings
      WHERE guild_id = ?
      GROUP BY user_id
      ORDER BY count DESC
      LIMIT 10
    `, [guildId]);

    // Most active moderators (top 10)
    const mostActiveMods = await db.all(`
      SELECT moderator_id, COUNT(*) as count FROM mod_actions
      WHERE guild_id = ?
      GROUP BY moderator_id
      ORDER BY count DESC
      LIMIT 10
    `, [guildId]);

    // Warning reasons breakdown
    const warningReasons = await db.all(`
      SELECT reason, COUNT(*) as count FROM warnings
      WHERE guild_id = ?
      GROUP BY reason
      ORDER BY count DESC
      LIMIT 15
    `, [guildId]);

    // Recent activity (last 10 mod actions)
    const recentActivity = await db.all(`
      SELECT * FROM mod_actions
      WHERE guild_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 10
    `, [guildId]);

    const allIds = [
      ...mostWarnedUsers.map(u => u.user_id),
      ...mostActiveMods.map(m => m.moderator_id),
      ...recentActivity.flatMap(a => [a.moderator_id, a.target_id]),
    ];
    const userMap = await resolveUserNames(botGuild, allIds);

    const guild = { id: botGuild.id, name: botGuild.name, icon: botGuild.iconURL() };
    res.render('stats', {
      user: req.user,
      guild,
      title: guild.name + ' - Statistics',
      botId,
      userMap,
      stats: {
        totalWarnings,
        totalBans,
        totalCrosspostIncidents,
        activeMods,
        mostWarnedUsers,
        mostActiveMods,
        warningReasons,
        recentActivity,
      },
    });
  }));

  return router;
};
