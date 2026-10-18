const { ActivityType, PermissionFlagsBits } = require('discord.js');
const { asyncRouter } = require('../asyncHandler');
const { isUnsafeSelfRole } = require('../../bot/utils/permissions');
const { getSettings, updateSetting, addExemptChannel, removeExemptChannel, getExemptChannels, getBannedDomains, addBannedDomain, removeBannedDomain, getImageOnlyChannels, addImageOnlyChannel, removeImageOnlyChannel, getGiveawayHostUsers, addGiveawayHostUser, removeGiveawayHostUser } = require('../../database/settings');
const { getAllGuildWarnings, deleteWarning, clearUserWarnings } = require('../../database/warnings');
const { db } = require('../../database/db');
const logger = require('../../logger');
const { userCanManageGuild } = require('../middleware/auth');
const { addFilterWord, toggleWholeWord, removeFilterWordById, getFilterWords, getFilterViolations, addWhitelistWord, removeWhitelistWord, getWhitelist } = require('../../database/wordFilter');
const { getAppeals } = require('../../database/appeals');

const SNOWFLAKE = /^\d{17,20}$/;

function isSnowflake(value) {
  return typeof value === 'string' && SNOWFLAKE.test(value);
}

// Row ids from the URL: a positive integer that fits a Postgres INTEGER.
// Anything else would make Postgres raise instead of matching nothing.
function parseRowId(value) {
  if (typeof value !== 'string' || !/^\d{1,10}$/.test(value)) return null;
  const id = Number(value);
  return id >= 1 && id <= 2147483647 ? id : null;
}

function isOptionalString(value) {
  return value === undefined || value === null || typeof value === 'string';
}

const MAX_GIVEAWAY_WINNERS = 25;

function clampWinnerCount(value) {
  const count = parseInt(value, 10);
  if (!Number.isFinite(count)) return 1;
  return Math.min(MAX_GIVEAWAY_WINNERS, Math.max(1, count));
}

// Returns an error message for the giveaway text fields of a request, or null.
function giveawayFieldProblem(fields) {
  const limits = { title: 256, prize: 256, description: 4000, color: 16, duration: 32, claimTime: 32 };
  for (const [name, max] of Object.entries(limits)) {
    const value = fields[name];
    if (!isOptionalString(value)) return `${name} must be text`;
    if (value && value.length > max) return `${name} must be at most ${max} characters`;
  }
  return null;
}

function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ error: 'Not authenticated' });
}

function ensureGuildAccess(req, res, next) {
  if (!userCanManageGuild(req.user, req.params.guildId)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

function ensureGiveawayAccess(client) {
  return async (req, res, next) => {
    const guildId = req.params.guildId;
    // Admins always have access
    if (userCanManageGuild(req.user, guildId)) return next();

    // Check giveaway host permissions
    const user = req.user;
    const userGuild = (user.guilds || []).find(g => g.id === guildId);
    if (!userGuild) return res.status(403).json({ error: 'Forbidden' });

    let settings;
    let hostUsers;
    try {
      settings = await getSettings(guildId);
      hostUsers = await getGiveawayHostUsers(guildId);
    } catch (err) {
      logger.error('Failed to check giveaway access:', err);
      return res.status(500).json({ error: 'Failed to check giveaway access' });
    }
    if (hostUsers.includes(user.id)) return next();

    if (settings.giveaway_host_role_id) {
      const botGuild = client.guilds.cache.get(guildId);
      if (botGuild) {
        const member = botGuild.members.cache.get(user.id);
        if (member && member.roles.cache.has(settings.giveaway_host_role_id)) return next();
      }
    }

    return res.status(403).json({ error: 'Forbidden' });
  };
}

// Settings fields holding a Discord role/channel id ('' or null clears them).
const SETTINGS_ID_FIELDS = [
  'moderator_role_id', 'warn_log_channel_id', 'ban_log_channel_id', 'warn_role_id', 'ban_role_id',
  'modactions_role_id', 'banreason_role_id', 'modmail_category_id', 'appeal_category_id',
  'giveaway_host_role_id', 'giveaway_log_channel_id', 'giveaway_ping_role_id', 'giveaway_channel_id',
];

// Settings fields holding free text ('' or null clears them).
const SETTINGS_TEXT_FIELDS = [
  'crosspost_first_message', 'crosspost_repeat_message', 'warn_public_message', 'blocked_extensions',
  'custom_warn_reasons', 'bot_status_message', 'banned_domains', 'server_invite_code',
];

// image_only_channels arrives as an array or a JSON string of channel ids.
function parseChannelList(value) {
  let list = value;
  if (typeof value === 'string') {
    if (!value.trim()) return [];
    try {
      list = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (value === null) return [];
  if (!Array.isArray(list) || !list.every(isSnowflake)) return null;
  return [...new Set(list)];
}

module.exports = function (client) {
  const router = asyncRouter();
  router.use(ensureAuthenticated);

  // Update guild settings
  router.post('/guild/:guildId/settings', ensureGuildAccess, async (req, res) => {
    const { guildId } = req.params;
    const body = { ...req.body };
    for (const field of SETTINGS_ID_FIELDS) {
      const value = body[field];
      if (value !== undefined && value !== null && value !== '' && !isSnowflake(value)) {
        return res.status(400).json({ error: `${field} must be a Discord ID` });
      }
    }
    for (const field of SETTINGS_TEXT_FIELDS) {
      if (!isOptionalString(body[field])) {
        return res.status(400).json({ error: `${field} must be text` });
      }
      if (body[field] === null) body[field] = '';
    }
    const { moderator_role_id, crosspost_threshold, crosspost_detection_seconds, crosspost_window_hours, warning_threshold, warn_log_channel_id, ban_log_channel_id, warn_role_id, ban_role_id, modactions_role_id, banreason_role_id, crosspost_first_message, crosspost_repeat_message, warn_public_message, crosspost_kick_count, crosspost_kick_window_minutes, modmail_enabled, modmail_category_id, file_block_enabled, blocked_extensions, custom_warn_reasons, bot_status_message, banned_domains, filter_enabled, soft_slur_threshold, soft_slur_window_minutes, image_only_channels, appeal_category_id, appeal_enabled, server_invite_code, giveaway_host_role_id, giveaway_log_channel_id, giveaway_ping_role_id, giveaway_channel_id } = body;

    let imageOnlyChannels;
    if (image_only_channels !== undefined) {
      imageOnlyChannels = parseChannelList(image_only_channels);
      if (!imageOnlyChannels) {
        return res.status(400).json({ error: 'image_only_channels must be a list of channel IDs' });
      }
    }

    try {
      const warnings = [];
      if (moderator_role_id !== undefined) {
        await updateSetting(guildId, 'moderator_role_id', moderator_role_id || null);
      }
      if (crosspost_threshold !== undefined) {
        const val = parseInt(crosspost_threshold);
        if (val >= 1 && val <= 100) {
          await updateSetting(guildId, 'crosspost_threshold', val);
        } else {
          warnings.push('Crosspost threshold must be between 1 and 100');
        }
      }
      if (crosspost_detection_seconds !== undefined) {
        const val = parseInt(crosspost_detection_seconds);
        if (val >= 5 && val <= 300) {
          await updateSetting(guildId, 'crosspost_detection_seconds', val);
        } else {
          warnings.push('Detection seconds must be between 5 and 300');
        }
      }
      if (crosspost_window_hours !== undefined) {
        const val = parseInt(crosspost_window_hours);
        if (val >= 1 && val <= 168) {
          await updateSetting(guildId, 'crosspost_window_hours', val);
        } else {
          warnings.push('Window hours must be between 1 and 168');
        }
      }
      if (warning_threshold !== undefined) {
        const val = parseInt(warning_threshold);
        if (val >= 1 && val <= 50) {
          await updateSetting(guildId, 'warning_threshold', val);
        } else {
          warnings.push('Warning threshold must be between 1 and 50');
        }
      }
      if (warn_log_channel_id !== undefined) {
        await updateSetting(guildId, 'warn_log_channel_id', warn_log_channel_id || null);
      }
      if (ban_log_channel_id !== undefined) {
        await updateSetting(guildId, 'ban_log_channel_id', ban_log_channel_id || null);
      }
      if (warn_role_id !== undefined) {
        await updateSetting(guildId, 'warn_role_id', warn_role_id || null);
      }
      if (ban_role_id !== undefined) {
        await updateSetting(guildId, 'ban_role_id', ban_role_id || null);
      }
      if (modactions_role_id !== undefined) {
        await updateSetting(guildId, 'modactions_role_id', modactions_role_id || null);
      }
      if (banreason_role_id !== undefined) {
        await updateSetting(guildId, 'banreason_role_id', banreason_role_id || null);
      }
      if (crosspost_first_message !== undefined) {
        await updateSetting(guildId, 'crosspost_first_message', crosspost_first_message.trim() || null);
      }
      if (crosspost_repeat_message !== undefined) {
        await updateSetting(guildId, 'crosspost_repeat_message', crosspost_repeat_message.trim() || null);
      }
      if (warn_public_message !== undefined) {
        await updateSetting(guildId, 'warn_public_message', warn_public_message.trim() || null);
      }
      if (crosspost_kick_count !== undefined) {
        const val = parseInt(crosspost_kick_count);
        if (val >= 1 && val <= 50) {
          await updateSetting(guildId, 'crosspost_kick_count', val);
        }
      }
      if (crosspost_kick_window_minutes !== undefined) {
        const val = parseInt(crosspost_kick_window_minutes);
        if (val >= 1 && val <= 10080) {
          await updateSetting(guildId, 'crosspost_kick_window_minutes', val);
        }
      }
      if (modmail_enabled !== undefined) {
        await updateSetting(guildId, 'modmail_enabled', modmail_enabled === 'on' || modmail_enabled === true || modmail_enabled === '1' ? 1 : 0);
      }
      if (modmail_category_id !== undefined) {
        await updateSetting(guildId, 'modmail_category_id', modmail_category_id || null);
      }
      if (file_block_enabled !== undefined) {
        await updateSetting(guildId, 'file_block_enabled', file_block_enabled === 'on' || file_block_enabled === '1' || file_block_enabled === true ? 1 : 0);
      }
      if (blocked_extensions !== undefined) {
        const raw = blocked_extensions.trim();
        if (!raw) {
          await updateSetting(guildId, 'blocked_extensions', null);
        } else {
          const parsed = raw.split(/[,\s]+/).map(ext => ext.toLowerCase().replace(/^\./, '').trim()).filter(Boolean);
          await updateSetting(guildId, 'blocked_extensions', JSON.stringify(parsed));
        }
      }
      if (custom_warn_reasons !== undefined) {
        const lines = custom_warn_reasons.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        if (lines.length > 0) {
          await updateSetting(guildId, 'custom_warn_reasons', JSON.stringify(lines));
        } else {
          await updateSetting(guildId, 'custom_warn_reasons', null);
        }
      }
      if (bot_status_message !== undefined) {
        const msg = bot_status_message.trim() || null;
        await updateSetting(guildId, 'bot_status_message', msg);
        // Note: bot presence is global — last guild to save controls the status for all guilds
        try {
          if (msg) {
            client.user.setPresence({
              activities: [{ name: msg, type: ActivityType.Custom }],
              status: 'online',
            });
          } else {
            client.user.setPresence({ activities: [], status: 'online' });
          }
        } catch (err) {
          logger.warn(`Failed to update bot presence: ${err.message}`);
        }
      }

      if (banned_domains !== undefined) {
        const raw = banned_domains.trim();
        if (!raw) {
          await updateSetting(guildId, 'banned_domains', null);
        } else {
          const parsed = raw.split(/[,\s]+/).map(d => d.toLowerCase().trim()).filter(Boolean);
          await updateSetting(guildId, 'banned_domains', JSON.stringify(parsed));
        }
      }
      if (filter_enabled !== undefined) {
        await updateSetting(guildId, 'filter_enabled', filter_enabled === 'on' || filter_enabled === '1' || filter_enabled === true ? 1 : 0);
      }
      if (soft_slur_threshold !== undefined) {
        const val = parseInt(soft_slur_threshold);
        if (val >= 1 && val <= 50) {
          await updateSetting(guildId, 'soft_slur_threshold', val);
        }
      }
      if (soft_slur_window_minutes !== undefined) {
        const val = parseInt(soft_slur_window_minutes);
        if (val >= 1 && val <= 10080) {
          await updateSetting(guildId, 'soft_slur_window_minutes', val);
        }
      }
      if (imageOnlyChannels !== undefined) {
        await updateSetting(guildId, 'image_only_channels', imageOnlyChannels.length > 0 ? JSON.stringify(imageOnlyChannels) : null);
      }
      if (appeal_category_id !== undefined) {
        await updateSetting(guildId, 'appeal_category_id', appeal_category_id || null);
      }
      if (appeal_enabled !== undefined) {
        await updateSetting(guildId, 'appeal_enabled', appeal_enabled === 'on' || appeal_enabled === true || appeal_enabled === '1' ? 1 : 0);
      }
      if (server_invite_code !== undefined) {
        // Strip full URL if provided, just store the code
        let code = (server_invite_code || '').trim();
        if (code.includes('discord.gg/')) {
          code = code.split('discord.gg/').pop().split(/[?\s]/)[0];
        }
        await updateSetting(guildId, 'server_invite_code', code || null);
      }
      if (giveaway_host_role_id !== undefined) {
        await updateSetting(guildId, 'giveaway_host_role_id', giveaway_host_role_id || null);
      }
      if (giveaway_log_channel_id !== undefined) {
        await updateSetting(guildId, 'giveaway_log_channel_id', giveaway_log_channel_id || null);
      }
      if (giveaway_ping_role_id !== undefined) {
        await updateSetting(guildId, 'giveaway_ping_role_id', giveaway_ping_role_id || null);
      }
      if (giveaway_channel_id !== undefined) {
        await updateSetting(guildId, 'giveaway_channel_id', giveaway_channel_id || null);
      }

      const settings = await getSettings(guildId);
      res.json({ success: true, settings, warnings: warnings.length > 0 ? warnings : undefined });
    } catch (err) {
      logger.error('Failed to update settings:', err);
      res.status(500).json({ error: 'Failed to update settings' });
    }
  });

  // Update exempt channels
  router.post('/guild/:guildId/exempt-channels', ensureGuildAccess, async (req, res) => {
    const { guildId } = req.params;
    const { channelId, action } = req.body;
    if (!isSnowflake(channelId)) return res.status(400).json({ error: 'channelId must be a Discord ID' });

    try {
      let channels;
      if (action === 'add') {
        channels = await addExemptChannel(guildId, channelId);
      } else if (action === 'remove') {
        channels = await removeExemptChannel(guildId, channelId);
      } else {
        return res.status(400).json({ error: 'Invalid action' });
      }
      res.json({ success: true, channels });
    } catch (err) {
      logger.error('Failed to update exempt channels:', err);
      res.status(500).json({ error: 'Failed to update exempt channels' });
    }
  });

  // Update image-only channels
  router.post('/guild/:guildId/image-only-channels', ensureGuildAccess, async (req, res) => {
    const { guildId } = req.params;
    const { channelId, action } = req.body;
    if (!isSnowflake(channelId)) return res.status(400).json({ error: 'channelId must be a Discord ID' });

    try {
      let channels;
      if (action === 'add') {
        channels = await addImageOnlyChannel(guildId, channelId);
      } else if (action === 'remove') {
        channels = await removeImageOnlyChannel(guildId, channelId);
      } else {
        return res.status(400).json({ error: 'Invalid action' });
      }
      res.json({ success: true, channels });
    } catch (err) {
      logger.error('Failed to update image-only channels:', err);
      res.status(500).json({ error: 'Failed to update image-only channels' });
    }
  });


  // Get warnings
  router.get('/guild/:guildId/warnings', ensureGuildAccess, async (req, res) => {
    const { guildId } = req.params;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 25;
    const offset = (page - 1) * limit;

    try {
      const { rows, total } = await getAllGuildWarnings(guildId, limit, offset);
      res.json({ warnings: rows, total, page, totalPages: Math.ceil(total / limit) });
    } catch (err) {
      logger.error('Failed to fetch warnings:', err);
      res.status(500).json({ error: 'Failed to fetch warnings' });
    }
  });

  // Clear all warnings for a user (must be before :warningId to avoid shadowing)
  router.delete('/guild/:guildId/warnings/user/:userId', ensureGuildAccess, async (req, res) => {
    const { guildId, userId } = req.params;
    if (!isSnowflake(userId)) return res.status(400).json({ error: 'userId must be a Discord ID' });
    try {
      await clearUserWarnings(guildId, userId);
      res.json({ success: true });
    } catch (err) {
      logger.error('Failed to clear user warnings:', err);
      res.status(500).json({ error: 'Failed to clear warnings' });
    }
  });

  // Delete a warning
  router.delete('/guild/:guildId/warnings/:warningId', ensureGuildAccess, async (req, res) => {
    const { guildId } = req.params;
    const warningId = parseRowId(req.params.warningId);
    if (!warningId) return res.status(404).json({ error: 'Warning not found' });
    try {
      await deleteWarning(warningId, guildId);
      res.json({ success: true });
    } catch (err) {
      logger.error('Failed to delete warning:', err);
      res.status(500).json({ error: 'Failed to delete warning' });
    }
  });

  // Get guild stats
  router.get('/guild/:guildId/stats', ensureGuildAccess, async (req, res) => {
    const { guildId } = req.params;

    try {
      const totalWarnings = (await db.get('SELECT COUNT(*) as count FROM warnings WHERE guild_id = ?', [guildId])).count;
      const totalBans = (await db.get("SELECT COUNT(*) as count FROM mod_actions WHERE guild_id = ? AND action_type = 'ban'", [guildId])).count;
      const totalCrosspostIncidents = (await db.get('SELECT COUNT(*) as count FROM crosspost_incidents WHERE guild_id = ?', [guildId])).count;
      const botId = client.user.id;
      const activeMods = (await db.get(`
        SELECT COUNT(DISTINCT moderator_id) as count FROM mod_actions
        WHERE guild_id = ? AND moderator_id != ? AND created_at >= datetime('now', '-30 days')
      `, [guildId, botId])).count;

      const mostWarnedUsers = await db.all(`
        SELECT user_id, COUNT(*) as count FROM warnings
        WHERE guild_id = ? GROUP BY user_id ORDER BY count DESC LIMIT 10
      `, [guildId]);

      const mostActiveMods = await db.all(`
        SELECT moderator_id, COUNT(*) as count FROM mod_actions
        WHERE guild_id = ?
        GROUP BY moderator_id ORDER BY count DESC LIMIT 10
      `, [guildId]);

      const warningReasons = await db.all(`
        SELECT reason, COUNT(*) as count FROM warnings
        WHERE guild_id = ? GROUP BY reason ORDER BY count DESC LIMIT 15
      `, [guildId]);

      const recentActivity = await db.all(`
        SELECT * FROM mod_actions WHERE guild_id = ? ORDER BY created_at DESC, id DESC LIMIT 10
      `, [guildId]);

      res.json({
        totalWarnings,
        totalBans,
        totalCrosspostIncidents,
        activeMods,
        mostWarnedUsers,
        mostActiveMods,
        warningReasons,
        recentActivity,
      });
    } catch (err) {
      logger.error('Failed to fetch stats:', err);
      res.status(500).json({ error: 'Failed to fetch stats' });
    }
  });

  // --- Stats detail endpoints ---
  // NOTE: These detail routes keep their SQL inline rather than in a database
  // module. They are read infrequently (on-demand modal views) and keeping the
  // queries co-located with each handler improves readability.

  // Warnings detail breakdown
  router.get('/guild/:guildId/stats/warnings-detail', ensureGuildAccess, async (req, res) => {
    const { guildId } = req.params;
    try {
      const byType = await db.all(`
        SELECT type, COUNT(*) as count FROM warnings WHERE guild_id = ? GROUP BY type
      `, [guildId]);
      const byMonth = await db.all(`
        SELECT strftime('%Y-%m', created_at) as month, COUNT(*) as count
        FROM warnings WHERE guild_id = ?
        GROUP BY month ORDER BY month DESC LIMIT 12
      `, [guildId]);
      const recent = await db.all(`
        SELECT * FROM warnings WHERE guild_id = ? ORDER BY created_at DESC, id DESC LIMIT 20
      `, [guildId]);
      res.json({ byType, byMonth, recent });
    } catch (err) {
      logger.error('Failed to fetch warnings detail:', err);
      res.status(500).json({ error: 'Failed to fetch warnings detail' });
    }
  });

  // Bans detail list
  router.get('/guild/:guildId/stats/bans', ensureGuildAccess, async (req, res) => {
    const { guildId } = req.params;
    try {
      const bans = await db.all(`
        SELECT * FROM mod_actions
        WHERE guild_id = ? AND action_type = 'ban'
        ORDER BY created_at DESC, id DESC LIMIT 50
      `, [guildId]);
      res.json({ bans });
    } catch (err) {
      logger.error('Failed to fetch bans detail:', err);
      res.status(500).json({ error: 'Failed to fetch bans detail' });
    }
  });

  // Crosspost incidents detail
  router.get('/guild/:guildId/stats/crosspost-detail', ensureGuildAccess, async (req, res) => {
    const { guildId } = req.params;
    try {
      const byAction = await db.all(`
        SELECT action_taken, COUNT(*) as count FROM crosspost_incidents
        WHERE guild_id = ? GROUP BY action_taken
      `, [guildId]);
      const topOffenders = await db.all(`
        SELECT user_id, COUNT(*) as count FROM crosspost_incidents
        WHERE guild_id = ? GROUP BY user_id ORDER BY count DESC LIMIT 10
      `, [guildId]);
      const recent = await db.all(`
        SELECT * FROM crosspost_incidents WHERE guild_id = ? ORDER BY created_at DESC, id DESC LIMIT 20
      `, [guildId]);
      res.json({ byAction, topOffenders, recent });
    } catch (err) {
      logger.error('Failed to fetch crosspost detail:', err);
      res.status(500).json({ error: 'Failed to fetch crosspost detail' });
    }
  });

  // Active moderators detail
  router.get('/guild/:guildId/stats/mods-detail', ensureGuildAccess, async (req, res) => {
    const { guildId } = req.params;
    try {
      const mods = await db.all(`
        SELECT moderator_id, action_type, COUNT(*) as count
        FROM mod_actions WHERE guild_id = ? AND created_at >= datetime('now', '-30 days')
        GROUP BY moderator_id, action_type ORDER BY count DESC
      `, [guildId]);
      res.json({ mods });
    } catch (err) {
      logger.error('Failed to fetch mods detail:', err);
      res.status(500).json({ error: 'Failed to fetch mods detail' });
    }
  });

  // Get warnings over time (for chart)
  router.get('/guild/:guildId/warnings-over-time', ensureGuildAccess, async (req, res) => {
    const { guildId } = req.params;
    const range = req.query.range || '8w';

    // Determine bucket size and count based on range
    const ranges = {
      '7d':  { buckets: 7,  bucketDays: 1,  labelFmt: 'day' },
      '30d': { buckets: 30, bucketDays: 1,  labelFmt: 'day' },
      '8w':  { buckets: 8,  bucketDays: 7,  labelFmt: 'week' },
      '6m':  { buckets: 6,  bucketDays: 30, labelFmt: 'month' },
      '1y':  { buckets: 12, bucketDays: 30, labelFmt: 'month' },
    };

    const config = ranges[range] || ranges['8w'];
    const { buckets, bucketDays, labelFmt } = config;

    try {
      const bucketSql = `
        SELECT COUNT(*) as count FROM warnings
        WHERE guild_id = ?
          AND created_at >= datetime('now', ? || ' days')
          AND created_at < datetime('now', ? || ' days')
      `;
      const data = [];
      for (let i = buckets - 1; i >= 0; i--) {
        const startDay = -(i + 1) * bucketDays;
        const endDay = -i * bucketDays;
        const row = await db.get(bucketSql, [guildId, String(startDay), String(endDay)]);

        const date = new Date();
        date.setDate(date.getDate() + startDay + bucketDays);

        let label;
        if (labelFmt === 'day') {
          label = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        } else if (labelFmt === 'month') {
          label = date.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
        } else {
          label = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        }

        data.push({ label, count: row.count });
      }

      res.json({ range, data });
    } catch (err) {
      logger.error('Failed to fetch warnings over time:', err);
      res.status(500).json({ error: 'Failed to fetch data' });
    }
  });

  // Get crosspost incidents
  router.get('/guild/:guildId/incidents', ensureGuildAccess, async (req, res) => {
    const { guildId } = req.params;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 25;
    const offset = (page - 1) * limit;

    try {
      const total = (await db.get('SELECT COUNT(*) as count FROM crosspost_incidents WHERE guild_id = ?', [guildId])).count;
      const rows = await db.all('SELECT * FROM crosspost_incidents WHERE guild_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?', [guildId, limit, offset]);
      res.json({ incidents: rows, total, page, totalPages: Math.ceil(total / limit) });
    } catch (err) {
      logger.error('Failed to fetch incidents:', err);
      res.status(500).json({ error: 'Failed to fetch incidents' });
    }
  });

  // Get filter words
  router.get('/guild/:guildId/filter-words', ensureGuildAccess, async (req, res) => {
    const { guildId } = req.params;
    try {
      const words = await getFilterWords(guildId);
      res.json({ words });
    } catch (err) {
      logger.error('Failed to fetch filter words:', err);
      res.status(500).json({ error: 'Failed to fetch filter words' });
    }
  });

  // Add filter word
  router.post('/guild/:guildId/filter-words', ensureGuildAccess, async (req, res) => {
    const { guildId } = req.params;
    const { word, tier, wholeWord } = req.body;

    if (typeof word !== 'string' || !word.trim() || word.length > 100 || !['hard', 'soft', 'auto_delete'].includes(tier)) {
      return res.status(400).json({ error: 'Invalid word or tier' });
    }

    try {
      await addFilterWord(guildId, word.toLowerCase().trim(), tier, wholeWord ? 1 : 0);
      const words = await getFilterWords(guildId);
      res.json({ success: true, words });
    } catch (err) {
      logger.error('Failed to add filter word:', err);
      res.status(500).json({ error: 'Failed to add filter word' });
    }
  });

  // Toggle whole_word flag on filter word
  router.patch('/guild/:guildId/filter-words/:wordId/whole-word', ensureGuildAccess, async (req, res) => {
    const { guildId } = req.params;
    const wordId = parseRowId(req.params.wordId);
    if (!wordId) return res.status(404).json({ error: 'Filter word not found' });
    const { wholeWord } = req.body;
    try {
      await toggleWholeWord(guildId, wordId, wholeWord ? 1 : 0);
      const words = await getFilterWords(guildId);
      res.json({ success: true, words });
    } catch (err) {
      logger.error('Failed to toggle whole_word:', err);
      res.status(500).json({ error: 'Failed to toggle whole_word' });
    }
  });

  // Remove filter word by ID
  router.delete('/guild/:guildId/filter-words/:wordId', ensureGuildAccess, async (req, res) => {
    const { guildId } = req.params;
    const wordId = parseRowId(req.params.wordId);
    if (!wordId) return res.status(404).json({ error: 'Filter word not found' });
    try {
      await removeFilterWordById(guildId, wordId);
      const words = await getFilterWords(guildId);
      res.json({ success: true, words });
    } catch (err) {
      logger.error('Failed to remove filter word:', err);
      res.status(500).json({ error: 'Failed to remove filter word' });
    }
  });

  // ========== Filter Whitelist ==========

  router.get('/guild/:guildId/filter-whitelist', ensureGuildAccess, async (req, res) => {
    const { guildId } = req.params;
    try {
      const words = await getWhitelist(guildId);
      res.json({ success: true, words });
    } catch (err) {
      logger.error('Failed to get filter whitelist:', err);
      res.status(500).json({ error: 'Failed to get filter whitelist' });
    }
  });

  router.post('/guild/:guildId/filter-whitelist', ensureGuildAccess, async (req, res) => {
    const { guildId } = req.params;
    const { word } = req.body;
    if (typeof word !== 'string' || !word.trim() || word.length > 100) {
      return res.status(400).json({ error: 'Word is required' });
    }
    try {
      await addWhitelistWord(guildId, word.trim(), req.user ? req.user.id : null);
      const words = await getWhitelist(guildId);
      res.json({ success: true, words });
    } catch (err) {
      logger.error('Failed to add whitelist word:', err);
      res.status(500).json({ error: 'Failed to add whitelist word' });
    }
  });

  router.delete('/guild/:guildId/filter-whitelist/:word', ensureGuildAccess, async (req, res) => {
    const { guildId, word } = req.params;
    try {
      await removeWhitelistWord(guildId, word);
      const words = await getWhitelist(guildId);
      res.json({ success: true, words });
    } catch (err) {
      logger.error('Failed to remove whitelist word:', err);
      res.status(500).json({ error: 'Failed to remove whitelist word' });
    }
  });

  // ========== Banned Domains ==========

  // Get banned domains
  router.get('/guild/:guildId/banned-domains', ensureGuildAccess, async (req, res) => {
    const { guildId } = req.params;
    try {
      const domains = await getBannedDomains(guildId);
      res.json({ success: true, domains });
    } catch (err) {
      logger.error('Failed to get banned domains:', err);
      res.status(500).json({ error: 'Failed to get banned domains' });
    }
  });

  // Add or remove a banned domain
  router.post('/guild/:guildId/banned-domains', ensureGuildAccess, async (req, res) => {
    const { guildId } = req.params;
    const { domain, action } = req.body;

    if (!domain || typeof domain !== 'string') {
      return res.status(400).json({ error: 'Domain is required' });
    }

    try {
      let domains;
      if (action === 'add') {
        domains = await addBannedDomain(guildId, domain);
      } else if (action === 'remove') {
        domains = await removeBannedDomain(guildId, domain);
      } else {
        return res.status(400).json({ error: 'Invalid action. Use "add" or "remove".' });
      }
      res.json({ success: true, domains });
    } catch (err) {
      logger.error('Failed to update banned domains:', err);
      res.status(500).json({ error: 'Failed to update banned domains' });
    }
  });

  // ========== Temp Bans ==========

  // Get active temp bans
  router.get('/guild/:guildId/temp-bans', ensureGuildAccess, async (req, res) => {
    const { guildId } = req.params;

    try {
      const tempBans = await db.all('SELECT * FROM temp_bans WHERE guild_id = ? AND unbanned = 0 ORDER BY unban_at ASC', [guildId]);
      res.json({ success: true, tempBans });
    } catch (err) {
      logger.error('Failed to fetch temp bans:', err);
      res.status(500).json({ error: 'Failed to fetch temp bans' });
    }
  });

  // Cancel a temp ban early (manual unban)
  router.post('/guild/:guildId/temp-bans/:id/cancel', ensureGuildAccess, async (req, res) => {
    const { guildId } = req.params;
    const id = parseRowId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Temp ban not found or already cancelled' });

    try {
      const tempBan = await db.get('SELECT * FROM temp_bans WHERE id = ? AND guild_id = ? AND unbanned = 0', [id, guildId]);

      if (!tempBan) {
        return res.status(404).json({ error: 'Temp ban not found or already cancelled' });
      }

      // Mark as unbanned in the database
      await db.run("UPDATE temp_bans SET unbanned = 1, unbanned_at = datetime('now') WHERE id = ?", [id]);

      // Try to unban the user from the guild
      try {
        const guild = client.guilds.cache.get(guildId);
        if (guild) {
          await guild.bans.remove(tempBan.user_id, 'Temp ban cancelled via dashboard');
        }
      } catch (unbanErr) {
        logger.warn(`Failed to unban user ${tempBan.user_id} from guild ${guildId}: ${unbanErr.message}`);
      }

      res.json({ success: true });
    } catch (err) {
      logger.error('Failed to cancel temp ban:', err);
      res.status(500).json({ error: 'Failed to cancel temp ban' });
    }
  });

  // ========== Self-Role Panels ==========

  // A self-role button hands its role to anyone who clicks it, so the role has
  // to be one the dashboard user could hand out themselves, and must not carry
  // moderation or admin permissions. Returns an error message, or null.
  async function checkSelfRole(guild, userId, roleId) {
    const role = guild.roles.cache.get(roleId);
    if (!role) return 'Role not found in this server';
    if (role.id === guild.id) return 'The @everyone role cannot be a self-role';
    if (role.managed) return 'Roles managed by an integration cannot be self-roles';
    if (isUnsafeSelfRole(role)) {
      return 'Roles with moderation or admin permissions cannot be self-roles';
    }
    const me = guild.members.me;
    if (!me || role.position >= me.roles.highest.position) return "That role is not below the bot's highest role";
    if (guild.ownerId !== userId) {
      let member;
      try {
        member = await guild.members.fetch(userId);
      } catch {
        return 'Could not verify your roles in this server';
      }
      if (role.position >= member.roles.highest.position) return 'You can only add roles below your own highest role';
    }
    return null;
  }

  // Get self-role panels with options
  router.get('/guild/:guildId/self-role-panels', ensureGuildAccess, async (req, res) => {
    const { guildId } = req.params;

    try {
      const panels = await db.all('SELECT * FROM self_role_panels WHERE guild_id = ? ORDER BY created_at DESC, id DESC', [guildId]);

      const guild = client.guilds.cache.get(guildId);
      const result = [];
      for (const panel of panels) {
        const options = await db.all('SELECT * FROM self_role_options WHERE panel_id = ? ORDER BY sort_order ASC, id ASC', [panel.id]);
        result.push({
          ...panel,
          options: options.map(opt => {
            const role = guild ? guild.roles.cache.get(opt.role_id) : null;
            return { ...opt, role_name: role ? role.name : 'Deleted Role', role_color: role ? role.hexColor : '#99aab5' };
          }),
        });
      }

      res.json({ success: true, panels: result });
    } catch (err) {
      logger.error('Failed to fetch self-role panels:', err);
      res.status(500).json({ error: 'Failed to fetch self-role panels' });
    }
  });

  // Create a new panel
  router.post('/guild/:guildId/self-role-panels', ensureGuildAccess, async (req, res) => {
    const { guildId } = req.params;
    const { channelId, title, description } = req.body;
    const { createPanel } = require('../../database/selfRoles');

    if (!isSnowflake(channelId)) return res.status(400).json({ error: 'channelId must be a Discord ID' });
    if (!isOptionalString(title) || !isOptionalString(description) || (title && title.length > 256) || (description && description.length > 4000)) {
      return res.status(400).json({ error: 'Title must be text up to 256 characters, description up to 4000' });
    }

    try {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) return res.status(404).json({ error: 'Guild not found' });

      const channel = await guild.channels.fetch(channelId);
      if (!channel) return res.status(404).json({ error: 'Channel not found' });

      const { EmbedBuilder } = require('discord.js');
      const embed = new EmbedBuilder()
        .setTitle(title || 'Self Roles')
        .setDescription(description || 'Click a button below to toggle a role.')
        .setColor(0x5865F2);

      const message = await channel.send({ embeds: [embed], components: [] });
      const panel = await createPanel(guildId, channelId, message.id, title || 'Self Roles', description || null);

      logger.info(`Self-roles panel ${panel.id} created via dashboard in #${channel.name}`);
      res.json({ success: true, panel });
    } catch (err) {
      logger.error('Failed to create self-role panel:', err);
      res.status(500).json({ error: 'Failed to create panel. Check that the bot can send messages in that channel.' });
    }
  });

  // Update panel title/description
  router.patch('/guild/:guildId/self-role-panels/:panelId', ensureGuildAccess, async (req, res) => {
    const { guildId } = req.params;
    const panelId = parseRowId(req.params.panelId);
    if (!panelId) return res.status(404).json({ error: 'Panel not found' });
    const { title, description } = req.body;
    if (!isOptionalString(title) || !isOptionalString(description) || (title && title.length > 256) || (description && description.length > 4000)) {
      return res.status(400).json({ error: 'Title must be text up to 256 characters, description up to 4000' });
    }
    const { getPanel, updatePanel, getRoleOptions } = require('../../database/selfRoles');
    const { buildPanelEmbed, buildPanelButtons } = require('../../bot/commands/selfroles');

    try {
      const panel = await getPanel(panelId);
      if (!panel || panel.guild_id !== guildId) return res.status(404).json({ error: 'Panel not found' });

      await updatePanel(panelId, title || panel.title, description);

      // Update Discord message
      try {
        const guild = client.guilds.cache.get(guildId);
        const channel = await guild.channels.fetch(panel.channel_id);
        const message = await channel.messages.fetch(panel.message_id);
        const options = await getRoleOptions(panel.id);
        const embed = buildPanelEmbed(title || panel.title, description, options, guild);
        const rows = buildPanelButtons(panel.id, options, guild);
        await message.edit({ embeds: [embed], components: rows });
      } catch (err) {
        logger.warn(`Failed to update panel message: ${err.message}`);
      }

      logger.info(`Self-roles panel ${panelId} updated via dashboard`);
      res.json({ success: true });
    } catch (err) {
      logger.error('Failed to update self-role panel:', err);
      res.status(500).json({ error: 'Failed to update panel' });
    }
  });

  // Delete a panel
  router.delete('/guild/:guildId/self-role-panels/:panelId', ensureGuildAccess, async (req, res) => {
    const { guildId } = req.params;
    const panelId = parseRowId(req.params.panelId);
    if (!panelId) return res.status(404).json({ error: 'Panel not found' });
    const { getPanel, deletePanel } = require('../../database/selfRoles');

    try {
      const panel = await getPanel(panelId);
      if (!panel || panel.guild_id !== guildId) return res.status(404).json({ error: 'Panel not found' });

      // Try to delete the Discord message
      try {
        const guild = client.guilds.cache.get(guildId);
        const channel = await guild.channels.fetch(panel.channel_id);
        const message = await channel.messages.fetch(panel.message_id);
        await message.delete();
      } catch { /* message may already be gone */ }

      await deletePanel(panelId);
      logger.info(`Self-roles panel ${panelId} deleted via dashboard`);
      res.json({ success: true });
    } catch (err) {
      logger.error('Failed to delete self-role panel:', err);
      res.status(500).json({ error: 'Failed to delete panel' });
    }
  });

  // Add a role to a panel
  router.post('/guild/:guildId/self-role-panels/:panelId/roles', ensureGuildAccess, async (req, res) => {
    const { guildId } = req.params;
    const panelId = parseRowId(req.params.panelId);
    if (!panelId) return res.status(404).json({ error: 'Panel not found' });
    const { roleId, emoji, label } = req.body;
    const { getPanel, addRoleOption, getRoleOptions } = require('../../database/selfRoles');
    const { buildPanelEmbed, buildPanelButtons } = require('../../bot/commands/selfroles');

    if (!isSnowflake(roleId)) return res.status(400).json({ error: 'roleId must be a Discord ID' });
    if (!isOptionalString(emoji) || !isOptionalString(label) || (label && label.length > 80) || (emoji && emoji.length > 64)) {
      return res.status(400).json({ error: 'Label must be text up to 80 characters' });
    }

    try {
      const panel = await getPanel(panelId);
      if (!panel || panel.guild_id !== guildId) return res.status(404).json({ error: 'Panel not found' });

      const botGuild = client.guilds.cache.get(guildId);
      if (!botGuild) return res.status(404).json({ error: 'Guild not found' });
      const roleProblem = await checkSelfRole(botGuild, req.user.id, roleId);
      if (roleProblem) return res.status(400).json({ error: roleProblem });

      const existing = await getRoleOptions(panel.id);
      if (existing.find(o => o.role_id === roleId)) return res.status(400).json({ error: 'Role already on panel' });
      if (existing.length >= 25) return res.status(400).json({ error: 'Panel has maximum 25 roles' });

      const options = await addRoleOption(panel.id, roleId, label || null, emoji || null, null);

      // Update Discord message
      try {
        const guild = client.guilds.cache.get(guildId);
        const channel = await guild.channels.fetch(panel.channel_id);
        const message = await channel.messages.fetch(panel.message_id);
        const embed = buildPanelEmbed(panel.title, panel.description, options, guild);
        const rows = buildPanelButtons(panel.id, options, guild);
        await message.edit({ embeds: [embed], components: rows });
      } catch (err) {
        logger.warn(`Failed to update panel message: ${err.message}`);
      }

      const guild = client.guilds.cache.get(guildId);
      const enriched = options.map(opt => {
        const role = guild ? guild.roles.cache.get(opt.role_id) : null;
        return { ...opt, role_name: role ? role.name : 'Deleted Role', role_color: role ? role.hexColor : '#99aab5' };
      });

      logger.info(`Role ${roleId} added to self-roles panel ${panelId} via dashboard`);
      res.json({ success: true, options: enriched });
    } catch (err) {
      logger.error('Failed to add role to panel:', err);
      res.status(500).json({ error: 'Failed to add role' });
    }
  });

  // Remove a role from a panel
  router.delete('/guild/:guildId/self-role-panels/:panelId/roles/:roleId', ensureGuildAccess, async (req, res) => {
    const { guildId, roleId } = req.params;
    const panelId = parseRowId(req.params.panelId);
    if (!panelId) return res.status(404).json({ error: 'Panel not found' });
    if (!isSnowflake(roleId)) return res.status(400).json({ error: 'roleId must be a Discord ID' });
    const { getPanel, removeRoleOption, getRoleOptions } = require('../../database/selfRoles');
    const { buildPanelEmbed, buildPanelButtons } = require('../../bot/commands/selfroles');

    try {
      const panel = await getPanel(panelId);
      if (!panel || panel.guild_id !== guildId) return res.status(404).json({ error: 'Panel not found' });

      await removeRoleOption(panel.id, roleId);
      const options = await getRoleOptions(panel.id);

      // Update Discord message
      try {
        const guild = client.guilds.cache.get(guildId);
        const channel = await guild.channels.fetch(panel.channel_id);
        const message = await channel.messages.fetch(panel.message_id);
        const embed = buildPanelEmbed(panel.title, panel.description, options, guild);
        const rows = buildPanelButtons(panel.id, options, guild);
        await message.edit({ embeds: [embed], components: rows });
      } catch (err) {
        logger.warn(`Failed to update panel message: ${err.message}`);
      }

      logger.info(`Role ${roleId} removed from self-roles panel ${panelId} via dashboard`);
      res.json({ success: true });
    } catch (err) {
      logger.error('Failed to remove role from panel:', err);
      res.status(500).json({ error: 'Failed to remove role' });
    }
  });

  // ========== Ban Appeals ==========

  // Get recent ban appeals
  router.get('/guild/:guildId/appeals', ensureGuildAccess, async (req, res) => {
    const { guildId } = req.params;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 25;
    const offset = (page - 1) * limit;

    try {
      const { rows: appeals, total } = await getAppeals(guildId, limit, offset);

      res.json({
        success: true,
        appeals,
        total,
        page,
        totalPages: Math.ceil(total / limit),
      });
    } catch (err) {
      logger.error('Failed to fetch appeals:', err);
      res.status(500).json({ error: 'Failed to fetch appeals' });
    }
  });

  // ========== Filter Violations ==========

  // Get paginated filter violations
  router.get('/guild/:guildId/filter-violations', ensureGuildAccess, async (req, res) => {
    const { guildId } = req.params;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 25;
    const offset = (page - 1) * limit;

    try {
      const { rows: violations, total } = await getFilterViolations(guildId, limit, offset);

      res.json({
        success: true,
        violations,
        total,
        page,
        totalPages: Math.ceil(total / limit),
      });
    } catch (err) {
      logger.error('Failed to fetch filter violations:', err);
      res.status(500).json({ error: 'Failed to fetch filter violations' });
    }
  });

  // ========== Giveaways ==========

  const { createGiveaway, setMessageId, getAllForGuild, getGiveaway: getGiveawayById, deleteGiveaway, updateGiveaway, getEntryCount: giveawayEntryCount } = require('../../database/giveaways');
  const { buildGiveawayEmbed, buildGiveawayButtons, endGiveaway, pickEligibleWinners, beginClaimWindow, dmClaimButtons, withGiveawayLock } = require('../../bot/commands/giveaway');
  const { parseDuration, formatDuration } = require('../../bot/utils/parseDuration');

  // List giveaways
  const giveawayAccess = ensureGiveawayAccess(client);

  // Loads the giveaway named in the URL, or answers 404/500 and returns null.
  async function findGuildGiveaway(req, res) {
    try {
      const id = parseRowId(req.params.id);
      const giveaway = id ? await getGiveawayById(id) : null;
      if (giveaway && giveaway.guild_id === req.params.guildId) return giveaway;
      res.status(404).json({ error: 'Giveaway not found' });
    } catch (err) {
      logger.error('Failed to load giveaway:', err);
      res.status(500).json({ error: 'Failed to load giveaway' });
    }
    return null;
  }

  router.get('/guild/:guildId/giveaways', giveawayAccess, async (req, res) => {
    const { guildId } = req.params;
    try {
      const giveaways = [];
      for (const g of await getAllForGuild(guildId)) {
        giveaways.push({ ...g, entry_count: await giveawayEntryCount(g.id) });
      }
      res.json({ success: true, giveaways });
    } catch (err) {
      logger.error('Failed to fetch giveaways:', err);
      res.status(500).json({ error: 'Failed to fetch giveaways' });
    }
  });

  // Create giveaway
  router.post('/guild/:guildId/giveaways', giveawayAccess, async (req, res) => {
    const { guildId } = req.params;
    const { channelId, title, prize, description, color, winnerCount, duration, claimTime, claimAction } = req.body;

    const fieldProblem = giveawayFieldProblem(req.body);
    if (fieldProblem) return res.status(400).json({ error: fieldProblem });
    if (!channelId || !prize || !duration) {
      return res.status(400).json({ error: 'channelId, prize, and duration are required' });
    }
    if (!isSnowflake(channelId)) return res.status(400).json({ error: 'channelId must be a Discord ID' });

    const durationMs = parseDuration(duration);
    if (!durationMs) {
      return res.status(400).json({ error: 'Invalid duration. Examples: 30m, 1h, 2d' });
    }

    let claimSeconds = null;
    if (claimTime) {
      const claimMs = parseDuration(claimTime);
      if (!claimMs) {
        return res.status(400).json({ error: 'Invalid claim time. Examples: 5s, 5m, 24h, 3d' });
      }
      claimSeconds = Math.round(claimMs / 1000);
    }
    const claimActionValue = claimAction === 'void' ? 'void' : 'reroll';

    const endsAt = new Date(Date.now() + durationMs).toISOString().replace('T', ' ').replace('Z', '').split('.')[0];

    try {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) return res.status(404).json({ error: 'Guild not found' });

      // Enforce locked giveaway channel
      const giveawaySettings = await getSettings(guildId);
      if (giveawaySettings.giveaway_channel_id && channelId !== giveawaySettings.giveaway_channel_id) {
        return res.status(400).json({ error: `Giveaways can only be created in the designated channel.` });
      }

      const giveaway = await createGiveaway(
        guildId, channelId, req.user.id,
        title || '🎉 GIVEAWAY 🎉', prize, description || null,
        color || null, clampWinnerCount(winnerCount), claimSeconds, claimActionValue, endsAt
      );

      const embed = buildGiveawayEmbed(giveaway, 0);
      const components = buildGiveawayButtons(giveaway.id);

      const settings = await getSettings(guildId);
      let pingContent = null;
      if (settings.giveaway_ping_role_id) {
        pingContent = `<@&${settings.giveaway_ping_role_id}>`;
      }

      const channel = await guild.channels.fetch(channelId);
      const msg = await channel.send({ content: pingContent, embeds: [embed], components });
      await setMessageId(giveaway.id, msg.id);

      logger.info(`Giveaway ${giveaway.id} created via dashboard by ${req.user.username}`);
      res.json({ success: true, giveaway: { ...giveaway, message_id: msg.id, entry_count: 0 } });
    } catch (err) {
      logger.error('Failed to create giveaway:', err);
      res.status(500).json({ error: 'Failed to create giveaway. Check that the bot can send messages in that channel.' });
    }
  });

  // Edit giveaway
  router.patch('/guild/:guildId/giveaways/:id', giveawayAccess, async (req, res) => {
    const giveaway = await findGuildGiveaway(req, res);
    if (!giveaway) return;

    const { title, prize, description, color, winnerCount, claimTime, claimAction } = req.body;
    const fieldProblem = giveawayFieldProblem(req.body);
    if (fieldProblem) return res.status(400).json({ error: fieldProblem });

    let claimTimeUpdate;
    if (claimTime !== undefined) {
      if (claimTime) {
        const claimMs = parseDuration(claimTime);
        if (!claimMs) {
          return res.status(400).json({ error: 'Invalid claim time. Examples: 5s, 5m, 24h, 3d' });
        }
        claimTimeUpdate = Math.round(claimMs / 1000);
      } else {
        claimTimeUpdate = null;
      }
    }

    try {
      // Hold the giveaway lock so ending or rerolling cannot interleave with
      // this edit, and decide active/ended from a fresh read inside it.
      const result = await withGiveawayLock(giveaway.id, async () => {
        const fresh = await getGiveawayById(giveaway.id);
        if (!fresh) return { status: 404, error: 'Giveaway not found' };

        const newPrize = prize !== undefined ? prize : fresh.prize;
        if (!newPrize) return { status: 400, error: 'Prize is required' };
        await updateGiveaway(
          fresh.id,
          title !== undefined ? title : fresh.title,
          newPrize,
          description !== undefined ? description : fresh.description,
          color !== undefined ? color : fresh.color,
          winnerCount !== undefined ? clampWinnerCount(winnerCount) : fresh.winner_count,
          claimTimeUpdate !== undefined ? claimTimeUpdate : fresh.claim_time,
          claimAction === 'void' || claimAction === 'reroll' ? claimAction : fresh.claim_action
        );

        // Update Discord message if active
        if (!fresh.ended && fresh.message_id) {
          try {
            const guild = client.guilds.cache.get(fresh.guild_id);
            if (guild) {
              const channel = await guild.channels.fetch(fresh.channel_id);
              if (channel) {
                const message = await channel.messages.fetch(fresh.message_id);
                if (message) {
                  const updated = await getGiveawayById(fresh.id);
                  const count = await giveawayEntryCount(fresh.id);
                  await message.edit({
                    embeds: [buildGiveawayEmbed(updated, count)],
                    components: buildGiveawayButtons(fresh.id),
                  });
                }
              }
            }
          } catch (err) {
            logger.warn(`Failed to update giveaway message: ${err.message}`);
          }
        }
        return null;
      });

      if (result.busy) {
        return res.status(409).json({ error: 'Giveaway is being processed right now, try again in a moment' });
      }
      if (result.value) {
        return res.status(result.value.status).json({ error: result.value.error });
      }

      logger.info(`Giveaway ${giveaway.id} edited via dashboard by ${req.user.username}`);
      res.json({ success: true });
    } catch (err) {
      logger.error('Failed to edit giveaway:', err);
      res.status(500).json({ error: 'Failed to edit giveaway' });
    }
  });

  // End giveaway
  router.post('/guild/:guildId/giveaways/:id/end', giveawayAccess, async (req, res) => {
    const giveaway = await findGuildGiveaway(req, res);
    if (!giveaway) return;
    if (giveaway.ended) {
      return res.status(400).json({ error: 'Giveaway already ended' });
    }

    try {
      const winners = await endGiveaway(client, giveaway);
      if (!winners) {
        return res.status(409).json({ error: 'Giveaway was not ended: it already ended, is being ended right now, or the bot cannot reach that server' });
      }
      logger.info(`Giveaway ${giveaway.id} ended via dashboard by ${req.user.username}`);
      res.json({ success: true, winners });
    } catch (err) {
      logger.error('Failed to end giveaway:', err);
      res.status(500).json({ error: 'Failed to end giveaway' });
    }
  });

  // Reroll giveaway
  router.post('/guild/:guildId/giveaways/:id/reroll', giveawayAccess, async (req, res) => {
    const { getEntries, markEnded: markGiveawayEnded } = require('../../database/giveaways');
    const giveaway = await findGuildGiveaway(req, res);
    if (!giveaway) return;
    if (!giveaway.ended) {
      return res.status(400).json({ error: 'Giveaway has not ended yet' });
    }

    try {
      const entries = await getEntries(giveaway.id);
      if (entries.length === 0) {
        return res.status(400).json({ error: 'No entries to reroll' });
      }

      const guild = client.guilds.cache.get(giveaway.guild_id);
      if (!guild) {
        return res.status(400).json({ error: 'Bot is not in that server right now; cannot verify entrants' });
      }

      const rerolled = await withGiveawayLock(giveaway.id, async () => {
        const picked = await pickEligibleWinners(guild, entries, giveaway.winner_count);
        if (picked.length === 0) return { newWinners: picked, claimDeadline: null };
        await markGiveawayEnded(giveaway.id, JSON.stringify(picked));
        const deadline = await beginClaimWindow(giveaway.id, giveaway.claim_time, { resetClaims: true });
        return { newWinners: picked, claimDeadline: deadline };
      });
      if (rerolled.busy) {
        return res.status(409).json({ error: 'Giveaway is being processed right now, try again in a moment' });
      }

      const { newWinners, claimDeadline } = rerolled.value;
      if (newWinners.length === 0) {
        return res.status(400).json({ error: 'No eligible entries — every entrant has left the server' });
      }

      const winnerMentions = newWinners.map(id => `<@${id}>`);
      const endedView = { ...giveaway, claim_deadline: claimDeadline };

      // Update Discord message
      try {
        const channel = await guild.channels.fetch(giveaway.channel_id);
        if (channel) {
          const message = await channel.messages.fetch(giveaway.message_id);
          if (message) {
            const { buildEndedEmbed } = require('../../bot/commands/giveaway');
            await message.edit({
              embeds: [buildEndedEmbed(endedView, winnerMentions)],
              components: buildGiveawayButtons(giveaway.id, true),
            });
          }
          const claimNote = claimDeadline
            ? ` Check your DMs to claim within **${formatDuration(giveaway.claim_time * 1000)}**.`
            : '';
          await channel.send(`🎉 New winners rerolled for **${giveaway.prize}**: ${winnerMentions.join(', ')}! Congratulations!${claimNote}`);
        }
      } catch (err) {
        logger.warn(`Failed to update rerolled giveaway message: ${err.message}`);
      }

      await dmClaimButtons(client, endedView, newWinners, claimDeadline);

      logger.info(`Giveaway ${giveaway.id} rerolled via dashboard by ${req.user.username}`);
      res.json({ success: true, winners: newWinners });
    } catch (err) {
      logger.error('Failed to reroll giveaway:', err);
      res.status(500).json({ error: 'Failed to reroll giveaway' });
    }
  });

  // Delete giveaway
  router.delete('/guild/:guildId/giveaways/:id', giveawayAccess, async (req, res) => {
    const giveaway = await findGuildGiveaway(req, res);
    if (!giveaway) return;

    try {
      // Try to delete Discord message
      const guild = client.guilds.cache.get(giveaway.guild_id);
      if (guild && giveaway.message_id) {
        try {
          const channel = await guild.channels.fetch(giveaway.channel_id);
          if (channel) {
            const message = await channel.messages.fetch(giveaway.message_id);
            if (message) await message.delete();
          }
        } catch { /* message may already be gone */ }
      }

      await deleteGiveaway(giveaway.id);
      logger.info(`Giveaway ${giveaway.id} deleted via dashboard by ${req.user.username}`);
      res.json({ success: true });
    } catch (err) {
      logger.error('Failed to delete giveaway:', err);
      res.status(500).json({ error: 'Failed to delete giveaway' });
    }
  });

  // Giveaway host users
  router.post('/guild/:guildId/giveaway-hosts', ensureGuildAccess, async (req, res) => {
    const { guildId } = req.params;
    const { userId, action } = req.body;

    if (!userId || !action) {
      return res.status(400).json({ error: 'userId and action are required' });
    }
    if (!isSnowflake(userId)) return res.status(400).json({ error: 'userId must be a Discord user ID' });

    try {
      let users;
      if (action === 'add') {
        users = await addGiveawayHostUser(guildId, userId);
      } else if (action === 'remove') {
        users = await removeGiveawayHostUser(guildId, userId);
      } else {
        return res.status(400).json({ error: 'action must be add or remove' });
      }
      res.json({ success: true, users });
    } catch (err) {
      logger.error('Failed to update giveaway hosts:', err);
      res.status(500).json({ error: 'Failed to update giveaway hosts' });
    }
  });

  return router;
};
