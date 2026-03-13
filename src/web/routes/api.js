const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { ActivityType } = require('discord.js');
const { getSettings, updateSetting, addExemptChannel, removeExemptChannel, getExemptChannels } = require('../../database/settings');
const { getAllGuildWarnings, deleteWarning, clearUserWarnings } = require('../../database/warnings');
const { db } = require('../../database/db');
const logger = require('../../logger');
const { userCanManageGuild } = require('../middleware/auth');

// Multer config for loader uploads — store per guild
const loaderStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '..', '..', '..', 'data', 'loaders', req.params.guildId);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    // Sanitize: keep only the original filename (no path traversal)
    const safeName = path.basename(file.originalname);
    cb(null, safeName);
  },
});

const loaderUpload = multer({
  storage: loaderStorage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB (Nitro limit)
  fileFilter: (req, file, cb) => {
    cb(null, true);
  },
});

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
    const { moderator_role_id, crosspost_threshold, crosspost_detection_seconds, crosspost_window_hours, warning_threshold, warn_log_channel_id, ban_log_channel_id, warn_role_id, ban_role_id, modactions_role_id, banreason_role_id, crosspost_first_message, crosspost_repeat_message, warn_public_message, crosspost_kick_count, crosspost_kick_window_minutes, modmail_enabled, modmail_category_id, file_block_enabled, blocked_extensions, custom_warn_reasons, bot_status_message, ticket_category_id, ticket_admin_role_id, ticket_log_channel_id } = req.body;

    try {
      if (moderator_role_id !== undefined) {
        updateSetting(guildId, 'moderator_role_id', moderator_role_id || null);
      }
      if (crosspost_threshold !== undefined) {
        const val = parseInt(crosspost_threshold);
        if (val >= 1 && val <= 100) {
          updateSetting(guildId, 'crosspost_threshold', val);
        }
      }
      if (crosspost_detection_seconds !== undefined) {
        const val = parseInt(crosspost_detection_seconds);
        if (val >= 5 && val <= 300) {
          updateSetting(guildId, 'crosspost_detection_seconds', val);
        }
      }
      if (crosspost_window_hours !== undefined) {
        const val = parseInt(crosspost_window_hours);
        if (val >= 1 && val <= 168) {
          updateSetting(guildId, 'crosspost_window_hours', val);
        }
      }
      if (warning_threshold !== undefined) {
        const val = parseInt(warning_threshold);
        if (val >= 1 && val <= 50) {
          updateSetting(guildId, 'warning_threshold', val);
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

      if (ticket_category_id !== undefined) {
        updateSetting(guildId, 'ticket_category_id', ticket_category_id || null);
      }
      if (ticket_admin_role_id !== undefined) {
        updateSetting(guildId, 'ticket_admin_role_id', ticket_admin_role_id || null);
      }
      if (ticket_log_channel_id !== undefined) {
        updateSetting(guildId, 'ticket_log_channel_id', ticket_log_channel_id || null);
      }

      const settings = getSettings(guildId);
      res.json({ success: true, settings });
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

  // Get warnings
  router.get('/guild/:guildId/warnings', ensureGuildAccess, (req, res) => {
    const { guildId } = req.params;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 25;
    const offset = (page - 1) * limit;

    const { rows, total } = getAllGuildWarnings(guildId, limit, offset);
    res.json({ warnings: rows, total, page, totalPages: Math.ceil(total / limit) });
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

  // Clear all warnings for a user
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

  // Upload loader file
  router.post('/guild/:guildId/loader', ensureGuildAccess, loaderUpload.single('loader'), (req, res) => {
    const { guildId } = req.params;
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    try {
      // Remove any previous loader file
      const settings = getSettings(guildId);
      if (settings.loader_file_name) {
        const oldPath = path.join(__dirname, '..', '..', '..', 'data', 'loaders', guildId, settings.loader_file_name);
        if (fs.existsSync(oldPath)) {
          fs.unlinkSync(oldPath);
        }
      }

      updateSetting(guildId, 'loader_file_name', req.file.filename);
      logger.info(`Loader uploaded for guild ${guildId}: ${req.file.filename}`);
      res.json({ success: true, fileName: req.file.filename });
    } catch (err) {
      logger.error('Failed to save loader file:', err);
      res.status(500).json({ error: 'Failed to save loader file' });
    }
  });

  // Delete loader file
  router.delete('/guild/:guildId/loader', ensureGuildAccess, (req, res) => {
    const { guildId } = req.params;

    try {
      const settings = getSettings(guildId);
      if (settings.loader_file_name) {
        const filePath = path.join(__dirname, '..', '..', '..', 'data', 'loaders', guildId, settings.loader_file_name);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
        updateSetting(guildId, 'loader_file_name', null);
      }
      res.json({ success: true });
    } catch (err) {
      logger.error('Failed to delete loader file:', err);
      res.status(500).json({ error: 'Failed to delete loader file' });
    }
  });

  return router;
};
