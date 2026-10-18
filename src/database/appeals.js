const { db } = require('./db');

function createAppeal(guildId, userId, channelId, reason) {
  return db.insert(
    `INSERT INTO ban_appeals (guild_id, user_id, channel_id, reason) VALUES (?, ?, ?, ?)`,
    [guildId, userId, channelId, reason]
  );
}

function getAppealByChannel(channelId) {
  return db.get(`SELECT * FROM ban_appeals WHERE channel_id = ? LIMIT 1`, [channelId]);
}

function getOpenAppeal(guildId, userId) {
  return db.get(`SELECT * FROM ban_appeals WHERE guild_id = ? AND user_id = ? AND status = 'pending' LIMIT 1`, [guildId, userId]);
}

// Resolves a pending appeal. Returns true only for the call that resolved it,
// so two moderators clicking at once cannot both act on it.
async function resolveAppeal(id, moderatorId, status) {
  const result = await db.run(
    `UPDATE ban_appeals SET status = ?, moderator_id = ?, resolved_at = datetime('now') WHERE id = ? AND status = 'pending'`,
    [status, moderatorId, id]
  );
  return result.changes === 1;
}

// Undoes resolveAppeal when acting on the decision failed (e.g. the unban).
function reopenAppeal(id) {
  return db.run(`UPDATE ban_appeals SET status = 'pending', moderator_id = NULL, resolved_at = NULL WHERE id = ?`, [id]);
}

async function getAppeals(guildId, limit = 25, offset = 0) {
  const rows = await db.all(`SELECT * FROM ban_appeals WHERE guild_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, [guildId, limit, offset]);
  const { count: total } = await db.get(`SELECT COUNT(*) as count FROM ban_appeals WHERE guild_id = ?`, [guildId]);
  return { rows, total };
}

function getAppealById(id) {
  return db.get(`SELECT * FROM ban_appeals WHERE id = ?`, [id]);
}

module.exports = {
  createAppeal,
  getAppealByChannel,
  getOpenAppeal,
  resolveAppeal,
  reopenAppeal,
  getAppeals,
  getAppealById,
};
