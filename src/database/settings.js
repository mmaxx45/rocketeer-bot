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
        crosspost_kick_count: db.prepare(`UPDATE guild_settings SET crosspost_kick_count = ?, updated_at = datetime('now') WHERE guild_id = ?`),
        crosspost_kick_window_minutes: db.prepare(`UPDATE guild_settings SET crosspost_kick_window_minutes = ?, updated_at = datetime('now') WHERE guild_id = ?`),
        ban_role_id: db.prepare(`UPDATE guild_settings SET ban_role_id = ?, updated_at = datetime('now') WHERE guild_id = ?`),
        modmail_enabled: db.prepare(`UPDATE guild_settings SET modmail_enabled = ?, updated_at = datetime('now') WHERE guild_id = ?`),
        modmail_category_id: db.prepare(`UPDATE guild_settings SET modmail_category_id = ?, updated_at = datetime('now') WHERE guild_id = ?`),
        modactions_role_id: db.prepare(`UPDATE guild_settings SET modactions_role_id = ?, updated_at = datetime('now') WHERE guild_id = ?`),
        file_block_enabled: db.prepare(`UPDATE guild_settings SET file_block_enabled = ?, updated_at = datetime('now') WHERE guild_id = ?`),
        blocked_extensions: db.prepare(`UPDATE guild_settings SET blocked_extensions = ?, updated_at = datetime('now') WHERE guild_id = ?`),
        banreason_role_id: db.prepare(`UPDATE guild_settings SET banreason_role_id = ?, updated_at = datetime('now') WHERE guild_id = ?`),
        custom_warn_reasons: db.prepare(`UPDATE guild_settings SET custom_warn_reasons = ?, updated_at = datetime('now') WHERE guild_id = ?`),
        bot_status_message: db.prepare(`UPDATE guild_settings SET bot_status_message = ?, updated_at = datetime('now') WHERE guild_id = ?`),
        ticket_category_id: db.prepare(`UPDATE guild_settings SET ticket_category_id = ?, updated_at = datetime('now') WHERE guild_id = ?`),
        ticket_admin_role_id: db.prepare(`UPDATE guild_settings SET ticket_admin_role_id = ?, updated_at = datetime('now') WHERE guild_id = ?`),
        ticket_log_channel_id: db.prepare(`UPDATE guild_settings SET ticket_log_channel_id = ?, updated_at = datetime('now') WHERE guild_id = ?`),
        loader_file_name: db.prepare(`UPDATE guild_settings SET loader_file_name = ?, updated_at = datetime('now') WHERE guild_id = ?`),
        ticket_open_message: db.prepare(`UPDATE guild_settings SET ticket_open_message = ?, updated_at = datetime('now') WHERE guild_id = ?`),
        license_required_role_ids: db.prepare(`UPDATE guild_settings SET license_required_role_ids = ?, updated_at = datetime('now') WHERE guild_id = ?`),
        license_role_prices: db.prepare(`UPDATE guild_settings SET license_role_prices = ?, updated_at = datetime('now') WHERE guild_id = ?`),
        banned_domains: db.prepare(`UPDATE guild_settings SET banned_domains = ?, updated_at = datetime('now') WHERE guild_id = ?`),
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

function getLicenseRequiredRoles(guildId) {
  const settings = getSettings(guildId);
  try {
    return JSON.parse(settings.license_required_role_ids || '[]');
  } catch {
    return [];
  }
}

function addLicenseRequiredRole(guildId, roleId) {
  const roles = getLicenseRequiredRoles(guildId);
  if (!roles.includes(roleId)) {
    roles.push(roleId);
    updateSetting(guildId, 'license_required_role_ids', JSON.stringify(roles));
  }
  return roles;
}

function removeLicenseRequiredRole(guildId, roleId) {
  const roles = getLicenseRequiredRoles(guildId);
  const filtered = roles.filter(id => id !== roleId);
  updateSetting(guildId, 'license_required_role_ids', JSON.stringify(filtered));
  return filtered;
}

function getLicenseRolePrices(guildId) {
  const settings = getSettings(guildId);
  try {
    return JSON.parse(settings.license_role_prices || '{}');
  } catch {
    return {};
  }
}

function setLicenseRolePrice(guildId, roleId, price) {
  const prices = getLicenseRolePrices(guildId);
  if (price === null || price === undefined || price === '') {
    delete prices[roleId];
  } else {
    prices[roleId] = parseFloat(price);
  }
  updateSetting(guildId, 'license_role_prices', JSON.stringify(prices));
  return prices;
}

function getBannedDomains(guildId) {
  const settings = getSettings(guildId);
  try {
    return JSON.parse(settings.banned_domains || '[]');
  } catch {
    return [];
  }
}

function addBannedDomain(guildId, domain) {
  const domains = getBannedDomains(guildId);
  const normalized = domain.toLowerCase().trim();
  if (!domains.includes(normalized)) {
    domains.push(normalized);
    updateSetting(guildId, 'banned_domains', JSON.stringify(domains));
  }
  return domains;
}

function removeBannedDomain(guildId, domain) {
  const domains = getBannedDomains(guildId);
  const normalized = domain.toLowerCase().trim();
  const filtered = domains.filter(d => d !== normalized);
  updateSetting(guildId, 'banned_domains', JSON.stringify(filtered));
  return filtered;
}

module.exports = {
  getSettings,
  updateSetting,
  getExemptChannels,
  addExemptChannel,
  removeExemptChannel,
  getLicenseRequiredRoles,
  addLicenseRequiredRole,
  removeLicenseRequiredRole,
  getLicenseRolePrices,
  setLicenseRolePrice,
  getBannedDomains,
  addBannedDomain,
  removeBannedDomain,
};
