const { db } = require('./db');

let stmts;

function getStmts() {
  if (!stmts) {
    stmts = {
      ensureGuild: db.prepare(`INSERT OR IGNORE INTO guild_settings (guild_id) VALUES (?)`),
      getSettings: db.prepare(`SELECT * FROM guild_settings WHERE guild_id = ?`),
      update: {
        moderator_role_id: db.prepare(`UPDATE guild_settings SET moderator_role_id = ?, updated_at = datetime('now') WHERE guild_id = ?`),
        crosspost_threshold: db.prepare(`UPDATE guild_settings SET crosspost_threshold = ?, updated_at = datetime('now') WHERE guild_id = ?`),
        crosspost_window_hours: db.prepare(`UPDATE guild_settings SET crosspost_window_hours = ?, updated_at = datetime('now') WHERE guild_id = ?`),
        warning_threshold: db.prepare(`UPDATE guild_settings SET warning_threshold = ?, updated_at = datetime('now') WHERE guild_id = ?`),
        exempt_channels: db.prepare(`UPDATE guild_settings SET exempt_channels = ?, updated_at = datetime('now') WHERE guild_id = ?`),
        warn_log_channel_id: db.prepare(`UPDATE guild_settings SET warn_log_channel_id = ?, updated_at = datetime('now') WHERE guild_id = ?`),
        warn_role_id: db.prepare(`UPDATE guild_settings SET warn_role_id = ?, updated_at = datetime('now') WHERE guild_id = ?`),
        crosspost_detection_seconds: db.prepare(`UPDATE guild_settings SET crosspost_detection_seconds = ?, updated_at = datetime('now') WHERE guild_id = ?`),
        crosspost_first_message: db.prepare(`UPDATE guild_settings SET crosspost_first_message = ?, updated_at = datetime('now') WHERE guild_id = ?`),
        crosspost_repeat_message: db.prepare(`UPDATE guild_settings SET crosspost_repeat_message = ?, updated_at = datetime('now') WHERE guild_id = ?`),
        warn_public_message: db.prepare(`UPDATE guild_settings SET warn_public_message = ?, updated_at = datetime('now') WHERE guild_id = ?`),
        ban_log_channel_id: db.prepare(`UPDATE guild_settings SET ban_log_channel_id = ?, updated_at = datetime('now') WHERE guild_id = ?`),
      },
    };
  }
  return stmts;
}

function getSettings(guildId) {
  const s = getStmts();
  s.ensureGuild.run(guildId);
  return s.getSettings.get(guildId);
}

function updateSetting(guildId, key, value) {
  const s = getStmts();
  s.ensureGuild.run(guildId);
  const stmt = s.update[key];
  if (!stmt) throw new Error(`Unknown setting: ${key}`);
  return stmt.run(value, guildId);
}

function getExemptChannels(guildId) {
  const settings = getSettings(guildId);
  try {
    return JSON.parse(settings.exempt_channels || '[]');
  } catch {
    return [];
  }
}

function addExemptChannel(guildId, channelId) {
  const channels = getExemptChannels(guildId);
  if (!channels.includes(channelId)) {
    channels.push(channelId);
    updateSetting(guildId, 'exempt_channels', JSON.stringify(channels));
  }
  return channels;
}

function removeExemptChannel(guildId, channelId) {
  const channels = getExemptChannels(guildId);
  const filtered = channels.filter(id => id !== channelId);
  updateSetting(guildId, 'exempt_channels', JSON.stringify(filtered));
  return filtered;
}

module.exports = {
  getSettings,
  updateSetting,
  getExemptChannels,
  addExemptChannel,
  removeExemptChannel,
};
