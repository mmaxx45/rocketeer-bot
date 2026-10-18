const { db } = require('./db');

function addTempBan(guildId, userId, moderatorId, reason, durationDays) {
  return db.run(
    `INSERT INTO temp_bans (guild_id, user_id, moderator_id, reason, duration_days, unban_at) VALUES (?, ?, ?, ?, ?, datetime('now', '+' || ? || ' days'))`,
    [guildId, userId, moderatorId, reason, durationDays, durationDays]
  );
}

function getDueTempBans() {
  return db.all(`SELECT * FROM temp_bans WHERE unbanned = 0 AND unban_at <= datetime('now')`);
}

function markUnbanned(id) {
  return db.run(`UPDATE temp_bans SET unbanned = 1, unbanned_at = datetime('now') WHERE id = ?`, [id]);
}

function getTempBan(guildId, userId) {
  return db.get(
    `SELECT * FROM temp_bans WHERE guild_id = ? AND user_id = ? AND unbanned = 0 ORDER BY banned_at DESC, id DESC LIMIT 1`,
    [guildId, userId]
  );
}

function cancelTempBan(guildId, userId) {
  return db.run(
    `UPDATE temp_bans SET unbanned = 1, unbanned_at = datetime('now') WHERE guild_id = ? AND user_id = ? AND unbanned = 0`,
    [guildId, userId]
  );
}

module.exports = {
  addTempBan,
  getDueTempBans,
  markUnbanned,
  getTempBan,
  cancelTempBan,
};
