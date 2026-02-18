const { db } = require('./db');

let stmts;

function getStmts() {
  if (!stmts) {
    stmts = {
      addWarning: db.prepare(`INSERT INTO warnings (guild_id, user_id, moderator_id, reason, type) VALUES (?, ?, ?, ?, ?)`),
      getWarnings: db.prepare(`SELECT * FROM warnings WHERE guild_id = ? AND user_id = ? ORDER BY created_at ASC`),
      getWarningCount: db.prepare(`SELECT COUNT(*) as count FROM warnings WHERE guild_id = ? AND user_id = ?`),
      getRecentWarnings: db.prepare(`SELECT * FROM warnings WHERE guild_id = ? AND user_id = ? AND created_at > datetime('now', '-' || ? || ' hours') ORDER BY created_at DESC`),
      getAllGuildWarnings: db.prepare(`SELECT * FROM warnings WHERE guild_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`),
      getAllGuildWarningsCount: db.prepare(`SELECT COUNT(*) as count FROM warnings WHERE guild_id = ?`),
      deleteWarning: db.prepare(`DELETE FROM warnings WHERE id = ? AND guild_id = ?`),
      clearUserWarnings: db.prepare(`DELETE FROM warnings WHERE guild_id = ? AND user_id = ?`),
    };
  }
  return stmts;
}

function addWarning(guildId, userId, moderatorId, reason, type = 'manual') {
  return getStmts().addWarning.run(guildId, userId, moderatorId, reason, type);
}

function getWarnings(guildId, userId) {
  return getStmts().getWarnings.all(guildId, userId);
}

function getWarningCount(guildId, userId) {
  return getStmts().getWarningCount.get(guildId, userId).count;
}

function getRecentWarnings(guildId, userId, hours = 48) {
  return getStmts().getRecentWarnings.all(guildId, userId, hours);
}

function getAllGuildWarnings(guildId, limit = 25, offset = 0) {
  const s = getStmts();
  const rows = s.getAllGuildWarnings.all(guildId, limit, offset);
  const total = s.getAllGuildWarningsCount.get(guildId).count;
  return { rows, total };
}

function deleteWarning(warningId, guildId) {
  return getStmts().deleteWarning.run(warningId, guildId);
}

function clearUserWarnings(guildId, userId) {
  return getStmts().clearUserWarnings.run(guildId, userId);
}

module.exports = {
  addWarning,
  getWarnings,
  getWarningCount,
  getRecentWarnings,
  getAllGuildWarnings,
  deleteWarning,
  clearUserWarnings,
};
