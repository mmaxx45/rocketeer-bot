const express = require('express');
const { ActivityType } = require('discord.js');
const { getSettings, updateSetting, addExemptChannel, removeExemptChannel, getExemptChannels, getBannedDomains, addBannedDomain, removeBannedDomain, getImageOnlyChannels, addImageOnlyChannel, removeImageOnlyChannel } = require('../../database/settings');
const { getAllGuildWarnings, deleteWarning, clearUserWarnings } = require('../../database/warnings');
const { db } = require('../../database/db');
const logger = require('../../logger');
const { userCanManageGuild } = require('../middleware/auth');
const { addFilterWord, removeFilterWord, removeFilterWordById, getFilterWords } = require('../../database/wordFilter');

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

module.exports = function (client) {
  const router = express.Router();
  router.use(ensureAuthenticated);

  // Update guild settings
  router.post('/guild/:guildId/settings', ensureGuildAccess, (req, res) => {
    const { guildId } = req.params;
    const { moderator_role_id, crosspost_threshold, crosspost_detection_seconds, crosspost_window_hours, warning_threshold, warn_log_channel_id, ban_log_channel_id, warn_role_id, ban_role_id, modactions_role_id, banreason_role_id, crosspost_first_message, crosspost_repeat_message, warn_public_message, crosspost_kick_count, crosspost_kick_window_minutes, modmail_enabled, modmail_category_id, file_block_enabled, blocked_extensions, custom_warn_reasons, bot_status_message, banned_domains, filter_enabled, soft_slur_threshold, soft_slur_window_minutes, image_only_channels, appeal_category_id, appeal_enabled, server_invite_code } = req.body;

    try {
      const warnings = [];
      if (moderator_role_id !== undefined) {
        updateSetting(guildId, 'moderator_role_id', moderator_role_id || null);
      }
      if (crosspost_threshold !== undefined) {
        const val = parseInt(crosspost_threshold);
        if (val >= 1 && val <= 100) {
          updateSetting(guildId, 'crosspost_threshold', val);
        } else {
          warnings.push('Crosspost threshold must be between 1 and 100');
        }
      }
      if (crosspost_detection_seconds !== undefined) {
        const val = parseInt(crosspost_detection_seconds);
        if (val >= 5 && val <= 300) {
          updateSetting(guildId, 'crosspost_detection_seconds', val);
        } else {
          warnings.push('Detection seconds must be between 5 and 300');
        }
      }
      if (crosspost_window_hours !== undefined) {
        const val = parseInt(crosspost_window_hours);
        if (val >= 1 && val <= 168) {
          updateSetting(guildId, 'crosspost_window_hours', val);
        } else {
          warnings.push('Window hours must be between 1 and 168');
        }
      }
      if (warning_threshold !== undefined) {
        const val = parseInt(warning_threshold);
        if (val >= 1 && val <= 50) {
          updateSetting(guildId, 'warning_threshold', val);
        } else {
          warnings.push('Warning threshold must be between 1 and 50');
        }
      }
      if (warn_log_channel_id !== undefined) {
        updateSetting(guildId, 'warn_log_channel_id', warn_log_channel_id || null);
      }
      if (ban_log_channel_id !== undefined) {
        updateSetting(guildId, 'ban_log_channel_id', ban_log_channel_id || null);
      }
      if (warn_role_id !== undefined) {
        updateSetting(guildId, 'warn_role_id', warn_role_id || null);
      }
      if (ban_role_id !== undefined) {
        updateSetting(guildId, 'ban_role_id', ban_role_id || null);
      }
      if (modactions_role_id !== undefined) {
        updateSetting(guildId, 'modactions_role_id', modactions_role_id || null);
      }
      if (banreason_role_id !== undefined) {
        updateSetting(guildId, 'banreason_role_id', banreason_role_id || null);
      }
      if (crosspost_first_message !== undefined) {
        updateSetting(guildId, 'crosspost_first_message', crosspost_first_message.trim() || null);
      }
      if (crosspost_repeat_message !== undefined) {
        updateSetting(guildId, 'crosspost_repeat_message', crosspost_repeat_message.trim() || null);
      }
      if (warn_public_message !== undefined) {
        updateSetting(guildId, 'warn_public_message', warn_public_message.trim() || null);
      }
      if (crosspost_kick_count !== undefined) {
        const val = parseInt(crosspost_kick_count);
        if (val >= 1 && val <= 50) {
          updateSetting(guildId, 'crosspost_kick_count', val);
        }
      }
      if (crosspost_kick_window_minutes !== undefined) {
        const val = parseInt(crosspost_kick_window_minutes);
        if (val >= 1 && val <= 10080) {
          updateSetting(guildId, 'crosspost_kick_window_minutes', val);
        }
      }
      if (modmail_enabled !== undefined) {
        updateSetting(guildId, 'modmail_enabled', modmail_enabled === 'on' || modmail_enabled === true || modmail_enabled === '1' ? 1 : 0);
      }
      if (modmail_category_id !== undefined) {
        updateSetting(guildId, 'modmail_category_id', modmail_category_id || null);
      }
      if (file_block_enabled !== undefined) {
        updateSetting(guildId, 'file_block_enabled', file_block_enabled === 'on' || file_block_enabled === '1' || file_block_enabled === true ? 1 : 0);
      }
      if (blocked_extensions !== undefined) {
        const raw = blocked_extensions.trim();
        if (!raw) {
          updateSetting(guildId, 'blocked_extensions', null);
        } else {
          const parsed = raw.split(/[,\s]+/).map(ext => ext.toLowerCase().replace(/^\./, '').trim()).filter(Boolean);
          updateSetting(guildId, 'blocked_extensions', JSON.stringify(parsed));
        }
      }
      if (custom_warn_reasons !== undefined) {
        const lines = custom_warn_reasons.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        if (lines.length > 0) {
          updateSetting(guildId, 'custom_warn_reasons', JSON.stringify(lines));
        } else {
          updateSetting(guildId, 'custom_warn_reasons', null);
        }
      }
      if (bot_status_message !== undefined) {
        const msg = bot_status_message.trim() || null;
        updateSetting(guildId, 'bot_status_message', msg);
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
          updateSetting(guildId, 'banned_domains', null);
        } else {
          const parsed = raw.split(/[,\s]+/).map(d => d.toLowerCase().trim()).filter(Boolean);
          updateSetting(guildId, 'banned_domains', JSON.stringify(parsed));
        }
      }
      if (filter_enabled !== undefined) {
        updateSetting(guildId, 'filter_enabled', filter_enabled === 'on' || filter_enabled === '1' || filter_enabled === true ? 1 : 0);
      }
      if (soft_slur_threshold !== undefined) {
        const val = parseInt(soft_slur_threshold);
        if (val >= 1 && val <= 50) {
          updateSetting(guildId, 'soft_slur_threshold', val);
        }
      }
      if (soft_slur_window_minutes !== undefined) {
        const val = parseInt(soft_slur_window_minutes);
        if (val >= 1 && val <= 10080) {
          updateSetting(guildId, 'soft_slur_window_minutes', val);
        }
      }
      if (image_only_channels !== undefined) {
        // Accepts JSON string or array
        const channelsStr = typeof image_only_channels === 'string' ? image_only_channels : JSON.stringify(image_only_channels);
        updateSetting(guildId, 'image_only_channels', channelsStr || null);
      }
      if (appeal_category_id !== undefined) {
        updateSetting(guildId, 'appeal_category_id', appeal_category_id || null);
      }
      if (appeal_enabled !== undefined) {
        updateSetting(guildId, 'appeal_enabled', appeal_enabled === 'on' || appeal_enabled === true || appeal_enabled === '1' ? 1 : 0);
      }
      if (server_invite_code !== undefined) {
        // Strip full URL if provided, just store the code
        let code = (server_invite_code || '').trim();
        if (code.includes('discord.gg/')) {
          code = code.split('discord.gg/').pop().split(/[?\s]/)[0];
        }
        updateSetting(guildId, 'server_invite_code', code || null);
      }


      const settings = getSettings(guildId);
      res.json({ success: true, settings, warnings: warnings.length > 0 ? warnings : undefined });
    } catch (err) {
      logger.error('Failed to update settings:', err);
      res.status(500).json({ error: 'Failed to update settings' });
    }
  });

  // Update exempt channels
  router.post('/guild/:guildId/exempt-channels', ensureGuildAccess, (req, res) => {
    const { guildId } = req.params;
    const { channelId, action } = req.body;

    try {
      let channels;
      if (action === 'add') {
        channels = addExemptChannel(guildId, channelId);
      } else if (action === 'remove') {
        channels = removeExemptChannel(guildId, channelId);
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
  router.post('/guild/:guildId/image-only-channels', ensureGuildAccess, (req, res) => {
    const { guildId } = req.params;
    const { channelId, action } = req.body;

    try {
      let channels;
      if (action === 'add') {
        channels = addImageOnlyChannel(guildId, channelId);
      } else if (action === 'remove') {
        channels = removeImageOnlyChannel(guildId, channelId);
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
  router.get('/guild/:guildId/warnings', ensureGuildAccess, (req, res) => {
    const { guildId } = req.params;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 25;
    const offset = (page - 1) * limit;

    const { rows, total } = getAllGuildWarnings(guildId, limit, offset);
    res.json({ warnings: rows, total, page, totalPages: Math.ceil(total / limit) });
  });

  // Clear all warnings for a user (must be before :warningId to avoid shadowing)
  router.delete('/guild/:guildId/warnings/user/:userId', ensureGuildAccess, (req, res) => {
    const { guildId, userId } = req.params;
    try {
      clearUserWarnings(guildId, userId);
      res.json({ success: true });
    } catch (err) {
      logger.error('Failed to clear user warnings:', err);
      res.status(500).json({ error: 'Failed to clear warnings' });
    }
  });

  // Delete a warning
  router.delete('/guild/:guildId/warnings/:warningId', ensureGuildAccess, (req, res) => {
    const { guildId, warningId } = req.params;
    try {
      deleteWarning(warningId, guildId);
      res.json({ success: true });
    } catch (err) {
      logger.error('Failed to delete warning:', err);
      res.status(500).json({ error: 'Failed to delete warning' });
    }
  });

  // Get guild stats
  router.get('/guild/:guildId/stats', ensureGuildAccess, (req, res) => {
    const { guildId } = req.params;

    try {
      const totalWarnings = db.prepare('SELECT COUNT(*) as count FROM warnings WHERE guild_id = ?').get(guildId).count;
      const totalBans = db.prepare("SELECT COUNT(*) as count FROM mod_actions WHERE guild_id = ? AND action_type = 'ban'").get(guildId).count;
      const totalCrosspostIncidents = db.prepare('SELECT COUNT(*) as count FROM crosspost_incidents WHERE guild_id = ?').get(guildId).count;
      const botId = client.user.id;
      const activeMods = db.prepare(`
        SELECT COUNT(DISTINCT moderator_id) as count FROM mod_actions
        WHERE guild_id = ? AND moderator_id != ? AND created_at >= datetime('now', '-30 days')
      `).get(guildId, botId).count;

      const mostWarnedUsers = db.prepare(`
        SELECT user_id, COUNT(*) as count FROM warnings
        WHERE guild_id = ? GROUP BY user_id ORDER BY count DESC LIMIT 10
      `).all(guildId);

      const mostActiveMods = db.prepare(`
        SELECT moderator_id, COUNT(*) as count FROM mod_actions
        WHERE guild_id = ?
        GROUP BY moderator_id ORDER BY count DESC LIMIT 10
      `).all(guildId);

      const warningReasons = db.prepare(`
        SELECT reason, COUNT(*) as count FROM warnings
        WHERE guild_id = ? GROUP BY reason ORDER BY count DESC LIMIT 15
      `).all(guildId);

      const recentActivity = db.prepare(`
        SELECT * FROM mod_actions WHERE guild_id = ? ORDER BY created_at DESC LIMIT 10
      `).all(guildId);

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
  // NOTE: These detail routes use inline db.prepare() rather than module-level
  // cached statements. This is intentional — they are read-infrequently
  // (on-demand modal views) so the overhead is negligible, and keeping the
  // queries co-located with each handler improves readability.

  // Warnings detail breakdown
  router.get('/guild/:guildId/stats/warnings-detail', ensureGuildAccess, (req, res) => {
    const { guildId } = req.params;
    try {
      const byType = db.prepare(`
        SELECT type, COUNT(*) as count FROM warnings WHERE guild_id = ? GROUP BY type
      `).all(guildId);
      const byMonth = db.prepare(`
        SELECT strftime('%Y-%m', created_at) as month, COUNT(*) as count
        FROM warnings WHERE guild_id = ?
        GROUP BY month ORDER BY month DESC LIMIT 12
      `).all(guildId);
      const recent = db.prepare(`
        SELECT * FROM warnings WHERE guild_id = ? ORDER BY created_at DESC LIMIT 20
      `).all(guildId);
      res.json({ byType, byMonth, recent });
    } catch (err) {
      logger.error('Failed to fetch warnings detail:', err);
      res.status(500).json({ error: 'Failed to fetch warnings detail' });
    }
  });

  // Bans detail list
  router.get('/guild/:guildId/stats/bans', ensureGuildAccess, (req, res) => {
    const { guildId } = req.params;
    try {
      const bans = db.prepare(`
        SELECT * FROM mod_actions
        WHERE guild_id = ? AND action_type = 'ban'
        ORDER BY created_at DESC LIMIT 50
      `).all(guildId);
      res.json({ bans });
    } catch (err) {
      logger.error('Failed to fetch bans detail:', err);
      res.status(500).json({ error: 'Failed to fetch bans detail' });
    }
  });

  // Crosspost incidents detail
  router.get('/guild/:guildId/stats/crosspost-detail', ensureGuildAccess, (req, res) => {
    const { guildId } = req.params;
    try {
      const byAction = db.prepare(`
        SELECT action_taken, COUNT(*) as count FROM crosspost_incidents
        WHERE guild_id = ? GROUP BY action_taken
      `).all(guildId);
      const topOffenders = db.prepare(`
        SELECT user_id, COUNT(*) as count FROM crosspost_incidents
        WHERE guild_id = ? GROUP BY user_id ORDER BY count DESC LIMIT 10
      `).all(guildId);
      const recent = db.prepare(`
        SELECT * FROM crosspost_incidents WHERE guild_id = ? ORDER BY created_at DESC LIMIT 20
      `).all(guildId);
      res.json({ byAction, topOffenders, recent });
    } catch (err) {
      logger.error('Failed to fetch crosspost detail:', err);
      res.status(500).json({ error: 'Failed to fetch crosspost detail' });
    }
  });

  // Active moderators detail
  router.get('/guild/:guildId/stats/mods-detail', ensureGuildAccess, (req, res) => {
    const { guildId } = req.params;
    try {
      const mods = db.prepare(`
        SELECT moderator_id, action_type, COUNT(*) as count
        FROM mod_actions WHERE guild_id = ? AND created_at >= datetime('now', '-30 days')
        GROUP BY moderator_id, action_type ORDER BY count DESC
      `).all(guildId);
      res.json({ mods });
    } catch (err) {
      logger.error('Failed to fetch mods detail:', err);
      res.status(500).json({ error: 'Failed to fetch mods detail' });
    }
  });

  // Get warnings over time (for chart)
  router.get('/guild/:guildId/warnings-over-time', ensureGuildAccess, (req, res) => {
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
      const bucketStmt = db.prepare(`
        SELECT COUNT(*) as count FROM warnings
        WHERE guild_id = ?
          AND created_at >= datetime('now', ? || ' days')
          AND created_at < datetime('now', ? || ' days')
      `);
      const data = [];
      for (let i = buckets - 1; i >= 0; i--) {
        const startDay = -(i + 1) * bucketDays;
        const endDay = -i * bucketDays;
        const row = bucketStmt.get(guildId, String(startDay), String(endDay));

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
  router.get('/guild/:guildId/incidents', ensureGuildAccess, (req, res) => {
    const { guildId } = req.params;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 25;
    const offset = (page - 1) * limit;

    try {
      const countStmt = db.prepare('SELECT COUNT(*) as count FROM crosspost_incidents WHERE guild_id = ?');
      const total = countStmt.get(guildId).count;
      const rowsStmt = db.prepare('SELECT * FROM crosspost_incidents WHERE guild_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?');
      const rows = rowsStmt.all(guildId, limit, offset);
      res.json({ incidents: rows, total, page, totalPages: Math.ceil(total / limit) });
    } catch (err) {
      logger.error('Failed to fetch incidents:', err);
      res.status(500).json({ error: 'Failed to fetch incidents' });
    }
  });

  // Get filter words
  router.get('/guild/:guildId/filter-words', ensureGuildAccess, (req, res) => {
    const { guildId } = req.params;
    try {
      const words = getFilterWords(guildId);
      res.json({ words });
    } catch (err) {
      logger.error('Failed to fetch filter words:', err);
      res.status(500).json({ error: 'Failed to fetch filter words' });
    }
  });

  // Add filter word
  router.post('/guild/:guildId/filter-words', ensureGuildAccess, (req, res) => {
    const { guildId } = req.params;
    const { word, tier } = req.body;

    if (!word || !tier || !['hard', 'soft', 'auto_delete'].includes(tier)) {
      return res.status(400).json({ error: 'Invalid word or tier' });
    }

    try {
      addFilterWord(guildId, word.toLowerCase().trim(), tier);
      const words = getFilterWords(guildId);
      res.json({ success: true, words });
    } catch (err) {
      logger.error('Failed to add filter word:', err);
      res.status(500).json({ error: 'Failed to add filter word' });
    }
  });

  // Remove filter word by ID
  router.delete('/guild/:guildId/filter-words/:wordId', ensureGuildAccess, (req, res) => {
    const { guildId, wordId } = req.params;
    try {
      removeFilterWordById(guildId, parseInt(wordId, 10));
      const words = getFilterWords(guildId);
      res.json({ success: true, words });
    } catch (err) {
      logger.error('Failed to remove filter word:', err);
      res.status(500).json({ error: 'Failed to remove filter word' });
    }
  });

  // ========== Banned Domains ==========

  // Get banned domains
  router.get('/guild/:guildId/banned-domains', ensureGuildAccess, (req, res) => {
    const { guildId } = req.params;
    try {
      const domains = getBannedDomains(guildId);
      res.json({ success: true, domains });
    } catch (err) {
      logger.error('Failed to get banned domains:', err);
      res.status(500).json({ error: 'Failed to get banned domains' });
    }
  });

  // Add or remove a banned domain
  router.post('/guild/:guildId/banned-domains', ensureGuildAccess, (req, res) => {
    const { guildId } = req.params;
    const { domain, action } = req.body;

    if (!domain || typeof domain !== 'string') {
      return res.status(400).json({ error: 'Domain is required' });
    }

    try {
      let domains;
      if (action === 'add') {
        domains = addBannedDomain(guildId, domain);
      } else if (action === 'remove') {
        domains = removeBannedDomain(guildId, domain);
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
  router.get('/guild/:guildId/temp-bans', ensureGuildAccess, (req, res) => {
    const { guildId } = req.params;

    try {
      const tempBans = db.prepare(
        'SELECT * FROM temp_bans WHERE guild_id = ? AND unbanned = 0 ORDER BY unban_at ASC'
      ).all(guildId);
      res.json({ success: true, tempBans });
    } catch (err) {
      logger.error('Failed to fetch temp bans:', err);
      res.status(500).json({ error: 'Failed to fetch temp bans' });
    }
  });

  // Cancel a temp ban early (manual unban)
  router.post('/guild/:guildId/temp-bans/:id/cancel', ensureGuildAccess, async (req, res) => {
    const { guildId, id } = req.params;

    try {
      const tempBan = db.prepare(
        'SELECT * FROM temp_bans WHERE id = ? AND guild_id = ? AND unbanned = 0'
      ).get(id, guildId);

      if (!tempBan) {
        return res.status(404).json({ error: 'Temp ban not found or already cancelled' });
      }

      // Mark as unbanned in the database
      db.prepare(
        "UPDATE temp_bans SET unbanned = 1 WHERE id = ?"
      ).run(id);

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

  const { createPanel, getPanel, getPanels, deletePanel, addRoleOption, removeRoleOption, getRoleOptions } = require('../../database/selfRoles');
  const { buildPanelEmbed, buildPanelButtons } = require('../../bot/commands/selfroles');

  // Get self-role panels with options
  router.get('/guild/:guildId/self-role-panels', ensureGuildAccess, (req, res) => {
    const { guildId } = req.params;

    try {
      const panels = db.prepare(
        'SELECT * FROM self_role_panels WHERE guild_id = ? ORDER BY created_at DESC'
      ).all(guildId);

      const getOptionsStmt = db.prepare(
        'SELECT * FROM self_role_options WHERE panel_id = ?'
      );

      const guild = client.guilds.cache.get(guildId);
      const result = panels.map(panel => ({
        ...panel,
        options: getOptionsStmt.all(panel.id).map(opt => {
          const role = guild ? guild.roles.cache.get(opt.role_id) : null;
          return { ...opt, role_name: role ? role.name : 'Deleted Role', role_color: role ? role.hexColor : '#99aab5' };
        }),
      }));

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

    if (!channelId) return res.status(400).json({ error: 'channelId is required' });

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
      const panel = createPanel(guildId, channelId, message.id, title || 'Self Roles', description || null);

      logger.info(`Self-roles panel ${panel.id} created via dashboard in #${channel.name}`);
      res.json({ success: true, panel });
    } catch (err) {
      logger.error('Failed to create self-role panel:', err);
      res.status(500).json({ error: 'Failed to create panel: ' + err.message });
    }
  });

  // Delete a panel
  router.delete('/guild/:guildId/self-role-panels/:panelId', ensureGuildAccess, async (req, res) => {
    const { guildId, panelId } = req.params;

    try {
      const panel = getPanel(panelId);
      if (!panel || panel.guild_id !== guildId) return res.status(404).json({ error: 'Panel not found' });

      // Try to delete the Discord message
      try {
        const guild = client.guilds.cache.get(guildId);
        const channel = await guild.channels.fetch(panel.channel_id);
        const message = await channel.messages.fetch(panel.message_id);
        await message.delete();
      } catch { /* message may already be gone */ }

      deletePanel(panelId);
      logger.info(`Self-roles panel ${panelId} deleted via dashboard`);
      res.json({ success: true });
    } catch (err) {
      logger.error('Failed to delete self-role panel:', err);
      res.status(500).json({ error: 'Failed to delete panel' });
    }
  });

  // Add a role to a panel
  router.post('/guild/:guildId/self-role-panels/:panelId/roles', ensureGuildAccess, async (req, res) => {
    const { guildId, panelId } = req.params;
    const { roleId, emoji, label } = req.body;

    if (!roleId) return res.status(400).json({ error: 'roleId is required' });

    try {
      const panel = getPanel(panelId);
      if (!panel || panel.guild_id !== guildId) return res.status(404).json({ error: 'Panel not found' });

      const existing = getRoleOptions(panel.id);
      if (existing.find(o => o.role_id === roleId)) return res.status(400).json({ error: 'Role already on panel' });
      if (existing.length >= 25) return res.status(400).json({ error: 'Panel has maximum 25 roles' });

      const options = addRoleOption(panel.id, roleId, label || null, emoji || null, null);

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
    const { guildId, panelId, roleId } = req.params;

    try {
      const panel = getPanel(panelId);
      if (!panel || panel.guild_id !== guildId) return res.status(404).json({ error: 'Panel not found' });

      removeRoleOption(panel.id, roleId);
      const options = getRoleOptions(panel.id);

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
  router.get('/guild/:guildId/appeals', ensureGuildAccess, (req, res) => {
    const { guildId } = req.params;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 25;
    const offset = (page - 1) * limit;

    try {
      const total = db.prepare(
        'SELECT COUNT(*) as count FROM ban_appeals WHERE guild_id = ?'
      ).get(guildId).count;

      const appeals = db.prepare(
        'SELECT * FROM ban_appeals WHERE guild_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
      ).all(guildId, limit, offset);

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
  router.get('/guild/:guildId/filter-violations', ensureGuildAccess, (req, res) => {
    const { guildId } = req.params;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 25;
    const offset = (page - 1) * limit;

    try {
      const total = db.prepare(
        'SELECT COUNT(*) as count FROM filter_violations WHERE guild_id = ?'
      ).get(guildId).count;

      const violations = db.prepare(
        'SELECT * FROM filter_violations WHERE guild_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
      ).all(guildId, limit, offset);

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

  return router;
};
