const { db } = require('./db');

// Columns updateSetting may write. The key is interpolated into the SQL, so it
// must come from this list, never straight from a request.
const SETTING_COLUMNS = new Set([
  'moderator_role_id',
  'crosspost_threshold',
  'crosspost_window_hours',
  'warning_threshold',
  'exempt_channels',
  'warn_log_channel_id',
  'warn_role_id',
  'crosspost_detection_seconds',
  'crosspost_first_message',
  'crosspost_repeat_message',
  'warn_public_message',
  'ban_log_channel_id',
  'crosspost_kick_count',
  'crosspost_kick_window_minutes',
  'ban_role_id',
  'modmail_enabled',
  'modmail_category_id',
  'modactions_role_id',
  'file_block_enabled',
  'blocked_extensions',
  'banreason_role_id',
  'custom_warn_reasons',
  'bot_status_message',
  'banned_domains',
  'filter_enabled',
  'soft_slur_threshold',
  'soft_slur_window_minutes',
  'image_only_channels',
  'appeal_category_id',
  'appeal_enabled',
  'server_invite_code',
  'giveaway_host_role_id',
  'giveaway_host_user_ids',
  'giveaway_log_channel_id',
  'giveaway_ping_role_id',
  'giveaway_channel_id',
]);

// getSettings runs on every message, so keep it off the database where we
// can. Rows are never deleted, so a guild only needs ensuring once per process,
// and every write goes through updateSetting, which drops the cached row. The
// TTL only bounds staleness from edits made outside the bot.
const SETTINGS_TTL_MS = 30 * 1000;
const ensuredGuilds = new Set();
const settingsCache = new Map();

async function ensureGuild(guildId) {
  if (ensuredGuilds.has(guildId)) return;
  await db.run(`INSERT OR IGNORE INTO guild_settings (guild_id) VALUES (?)`, [guildId]);
  ensuredGuilds.add(guildId);
}

// Returns a copy, so callers can't modify the cached row.
async function getSettings(guildId) {
  const cached = settingsCache.get(guildId);
  if (cached && Date.now() - cached.at < SETTINGS_TTL_MS) return { ...cached.row };
  await ensureGuild(guildId);
  const row = await db.get(`SELECT * FROM guild_settings WHERE guild_id = ?`, [guildId]);
  settingsCache.set(guildId, { row, at: Date.now() });
  return { ...row };
}

async function updateSetting(guildId, key, value) {
  if (!SETTING_COLUMNS.has(key)) throw new Error(`Unknown setting: ${key}`);
  await ensureGuild(guildId);
  try {
    return await db.run(`UPDATE guild_settings SET ${key} = ?, updated_at = datetime('now') WHERE guild_id = ?`, [value, guildId]);
  } finally {
    settingsCache.delete(guildId);
  }
}

// Parses one of the JSON list columns of an already fetched settings row.
function parseJsonList(settings, column) {
  try {
    const list = JSON.parse((settings && settings[column]) || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

async function getJsonList(guildId, column) {
  return parseJsonList(await getSettings(guildId), column);
}

// The add/remove helpers read a JSON list, change it and write it back. With
// awaits in between, two dashboard requests could interleave and one change
// would be lost, so they run one at a time per guild.
const listLocks = new Map();

function withListLock(guildId, fn) {
  const previous = listLocks.get(guildId) || Promise.resolve();
  const next = previous.catch(() => {}).then(fn);
  const settled = next.catch(() => {});
  listLocks.set(guildId, settled);
  settled.then(() => {
    if (listLocks.get(guildId) === settled) listLocks.delete(guildId);
  });
  return next;
}

// Adds or removes one value of a JSON list column under the guild's lock.
function changeList(guildId, column, change) {
  return withListLock(guildId, async () => {
    const before = await getJsonList(guildId, column);
    const after = change(before);
    if (after !== before) await updateSetting(guildId, column, JSON.stringify(after));
    return after;
  });
}

const addValue = value => list => (list.includes(value) ? list : [...list, value]);
const removeValue = value => list => list.filter(item => item !== value);
const normalizeDomain = domain => domain.toLowerCase().trim();

function getExemptChannels(guildId) {
  return getJsonList(guildId, 'exempt_channels');
}

function addExemptChannel(guildId, channelId) {
  return changeList(guildId, 'exempt_channels', addValue(channelId));
}

function removeExemptChannel(guildId, channelId) {
  return changeList(guildId, 'exempt_channels', removeValue(channelId));
}

function getBannedDomains(guildId) {
  return getJsonList(guildId, 'banned_domains');
}

function addBannedDomain(guildId, domain) {
  return changeList(guildId, 'banned_domains', addValue(normalizeDomain(domain)));
}

function removeBannedDomain(guildId, domain) {
  return changeList(guildId, 'banned_domains', removeValue(normalizeDomain(domain)));
}

function getImageOnlyChannels(guildId) {
  return getJsonList(guildId, 'image_only_channels');
}

function addImageOnlyChannel(guildId, channelId) {
  return changeList(guildId, 'image_only_channels', addValue(channelId));
}

function removeImageOnlyChannel(guildId, channelId) {
  return changeList(guildId, 'image_only_channels', removeValue(channelId));
}

function getGiveawayHostUsers(guildId) {
  return getJsonList(guildId, 'giveaway_host_user_ids');
}

function addGiveawayHostUser(guildId, userId) {
  return changeList(guildId, 'giveaway_host_user_ids', addValue(userId));
}

function removeGiveawayHostUser(guildId, userId) {
  return changeList(guildId, 'giveaway_host_user_ids', removeValue(userId));
}

module.exports = {
  getSettings,
  updateSetting,
  parseJsonList,
  getExemptChannels,
  addExemptChannel,
  removeExemptChannel,
  getBannedDomains,
  addBannedDomain,
  removeBannedDomain,
  getImageOnlyChannels,
  addImageOnlyChannel,
  removeImageOnlyChannel,
  getGiveawayHostUsers,
  addGiveawayHostUser,
  removeGiveawayHostUser,
};
