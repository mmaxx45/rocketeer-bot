const { db } = require('./db');

let stmts;

function getStmts() {
  if (!stmts) {
    stmts = {
      addTempBan: db.prepare(`INSERT INTO temp_bans (guild_id, user_id, moderator_id, reason, duration_days, unban_at) VALUES (?, ?, ?, ?, ?, datetime('now', '+' || ? || ' days'))`),
      getDueTempBans: db.prepare(`SELECT * FROM temp_bans WHERE unbanned = 0 AND unban_at <= datetime('now')`),
      markUnbanned: db.prepare(`UPDATE temp_bans SET unbanned = 1 WHERE id = ?`),
      getTempBan: db.prepare(`SELECT * FROM temp_bans WHERE guild_id = ? AND user_id = ? AND unbanned = 0 ORDER BY banned_at DESC LIMIT 1`),
      cancelTempBan: db.prepare(`UPDATE temp_bans SET unbanned = 1 WHERE guild_id = ? AND user_id = ? AND unbanned = 0`),
    };
  }
  return stmts;
}

function addTempBan(guildId, userId, moderatorId, reason, durationDays) {
  return getStmts().addTempBan.run(guildId, userId, moderatorId, reason, durationDays, durationDays);
}

function getDueTempBans() {
  return getStmts().getDueTempBans.all();
}

function markUnbanned(id) {
  return getStmts().markUnbanned.run(id);
}

function getTempBan(guildId, userId) {
  return getStmts().getTempBan.get(guildId, userId);
}

function cancelTempBan(guildId, userId) {
  return getStmts().cancelTempBan.run(guildId, userId);
}

module.exports = {
  addTempBan,
  getDueTempBans,
  markUnbanned,
  getTempBan,
  cancelTempBan,
};
