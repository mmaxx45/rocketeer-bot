const { db } = require('./db');

function addWarning(guildId, userId, moderatorId, reason, type = 'manual', messageContent = null) {
  return db.run(
    `INSERT INTO warnings (guild_id, user_id, moderator_id, reason, type, message_content) VALUES (?, ?, ?, ?, ?, ?)`,
    [guildId, userId, moderatorId, reason, type, messageContent]
  );
}

function getWarnings(guildId, userId) {
  return db.all(`SELECT * FROM warnings WHERE guild_id = ? AND user_id = ? ORDER BY created_at ASC, id ASC`, [guildId, userId]);
}

// Adds a warning and returns its number for that user (1 for the first one).
// The count only covers warnings up to the new row, so two warnings added at
// the same time get different numbers instead of both reporting the total.
async function addWarningNumbered(guildId, userId, moderatorId, reason, type = 'manual', messageContent = null) {
  const id = await db.insert(
    `INSERT INTO warnings (guild_id, user_id, moderator_id, reason, type, message_content) VALUES (?, ?, ?, ?, ?, ?)`,
    [guildId, userId, moderatorId, reason, type, messageContent]
  );
  const row = await db.get(`SELECT COUNT(*) as count FROM warnings WHERE guild_id = ? AND user_id = ? AND id <= ?`, [guildId, userId, id]);
  return row.count;
}

async function getWarningCount(guildId, userId) {
  const row = await db.get(`SELECT COUNT(*) as count FROM warnings WHERE guild_id = ? AND user_id = ?`, [guildId, userId]);
  return row.count;
}

function getRecentWarnings(guildId, userId, hours = 48) {
  return db.all(
    `SELECT * FROM warnings WHERE guild_id = ? AND user_id = ? AND created_at > datetime('now', '-' || ? || ' hours') ORDER BY created_at DESC, id DESC`,
    [guildId, userId, hours]
  );
}

async function getAllGuildWarnings(guildId, limit = 25, offset = 0) {
  const rows = await db.all(`SELECT * FROM warnings WHERE guild_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, [guildId, limit, offset]);
  const { count: total } = await db.get(`SELECT COUNT(*) as count FROM warnings WHERE guild_id = ?`, [guildId]);
  return { rows, total };
}

function deleteWarning(warningId, guildId) {
  return db.run(`DELETE FROM warnings WHERE id = ? AND guild_id = ?`, [warningId, guildId]);
}

function clearUserWarnings(guildId, userId) {
  return db.run(`DELETE FROM warnings WHERE guild_id = ? AND user_id = ?`, [guildId, userId]);
}

module.exports = {
  addWarning,
  addWarningNumbered,
  getWarnings,
  getWarningCount,
  getRecentWarnings,
  getAllGuildWarnings,
  deleteWarning,
  clearUserWarnings,
};
