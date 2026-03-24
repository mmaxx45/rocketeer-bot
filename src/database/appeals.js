const { db } = require('./db');

let stmts;

function getStmts() {
  if (!stmts) {
    stmts = {
      createAppeal: db.prepare(
        `INSERT INTO ban_appeals (guild_id, user_id, channel_id, reason) VALUES (?, ?, ?, ?)`
      ),
      getAppealByChannel: db.prepare(
        `SELECT * FROM ban_appeals WHERE channel_id = ? LIMIT 1`
      ),
      getOpenAppeal: db.prepare(
        `SELECT * FROM ban_appeals WHERE guild_id = ? AND user_id = ? AND status = 'pending' LIMIT 1`
      ),
      resolveAppeal: db.prepare(
        `UPDATE ban_appeals SET status = ?, moderator_id = ?, resolved_at = datetime('now') WHERE id = ?`
      ),
      getAppeals: db.prepare(
        `SELECT * FROM ban_appeals WHERE guild_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`
      ),
      getAppealsCount: db.prepare(
        `SELECT COUNT(*) as count FROM ban_appeals WHERE guild_id = ?`
      ),
      getAppealById: db.prepare(
        `SELECT * FROM ban_appeals WHERE id = ?`
      ),
    };
  }
  return stmts;
}

function createAppeal(guildId, userId, channelId, reason) {
  const result = getStmts().createAppeal.run(guildId, userId, channelId, reason);
  return result.lastInsertRowid;
}

function getAppealByChannel(channelId) {
  return getStmts().getAppealByChannel.get(channelId);
}

function getOpenAppeal(guildId, userId) {
  return getStmts().getOpenAppeal.get(guildId, userId);
}

function resolveAppeal(id, moderatorId, status) {
  return getStmts().resolveAppeal.run(status, moderatorId, id);
}

function getAppeals(guildId, limit = 25, offset = 0) {
  const s = getStmts();
  const rows = s.getAppeals.all(guildId, limit, offset);
  const total = s.getAppealsCount.get(guildId).count;
  return { rows, total };
}

function getAppealById(id) {
  return getStmts().getAppealById.get(id);
}

module.exports = {
  createAppeal,
  getAppealByChannel,
  getOpenAppeal,
  resolveAppeal,
  getAppeals,
  getAppealById,
};
