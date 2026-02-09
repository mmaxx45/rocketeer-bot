const express = require('express');
const { getSettings, updateSetting, addExemptChannel, removeExemptChannel, getExemptChannels } = require('../../database/settings');
const { getAllGuildWarnings, deleteWarning, clearUserWarnings } = require('../../database/warnings');
const { db } = require('../../database/db');
const logger = require('../../logger');

const MANAGE_GUILD = BigInt(0x20);

function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ error: 'Not authenticated' });
}

function userCanManageGuild(user, guildId) {
  if (!user || !user.guilds) return false;
  const guild = user.guilds.find(g => g.id === guildId);
  if (!guild) return false;
  const permissions = BigInt(guild.permissions);
  return (permissions & MANAGE_GUILD) === MANAGE_GUILD;
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
    const { moderator_role_id, crosspost_threshold, crosspost_detection_seconds, crosspost_window_hours, warning_threshold, warn_log_channel_id, warn_role_id, crosspost_first_message, crosspost_repeat_message, warn_public_message } = req.body;

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
        if (val >= 5 && val <= 3600) {
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
      if (warn_role_id !== undefined) {
        updateSetting(guildId, 'warn_role_id', warn_role_id || null);
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

  return router;
};
