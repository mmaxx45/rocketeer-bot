const { db } = require('./db');

function addModAction(guildId, moderatorId, actionType, targetId, details = null) {
  return db.run(
    `INSERT INTO mod_actions (guild_id, moderator_id, action_type, target_id, details) VALUES (?, ?, ?, ?, ?)`,
    [guildId, moderatorId, actionType, targetId, details]
  );
}

async function getModActions(guildId, moderatorId, limit = 10, offset = 0) {
  const rows = await db.all(
    `SELECT * FROM mod_actions WHERE guild_id = ? AND moderator_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    [guildId, moderatorId, limit, offset]
  );
  const { count: total } = await db.get(`SELECT COUNT(*) as count FROM mod_actions WHERE guild_id = ? AND moderator_id = ?`, [guildId, moderatorId]);
  return { rows, total };
}

function getLastBanAction(guildId, targetId) {
  return db.get(
    `SELECT * FROM mod_actions WHERE guild_id = ? AND target_id = ? AND action_type = 'ban' ORDER BY created_at DESC, id DESC LIMIT 1`,
    [guildId, targetId]
  );
}

module.exports = {
  addModAction,
  getModActions,
  getLastBanAction,
};
