const { db } = require('./db');

let stmts;

function getStmts() {
  if (!stmts) {
    stmts = {
      addModAction: db.prepare(`INSERT INTO mod_actions (guild_id, moderator_id, action_type, target_id, details) VALUES (?, ?, ?, ?, ?)`),
      getModActions: db.prepare(`SELECT * FROM mod_actions WHERE guild_id = ? AND moderator_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`),
      getModActionsCount: db.prepare(`SELECT COUNT(*) as count FROM mod_actions WHERE guild_id = ? AND moderator_id = ?`),
    };
  }
  return stmts;
}

function addModAction(guildId, moderatorId, actionType, targetId, details = null) {
  return getStmts().addModAction.run(guildId, moderatorId, actionType, targetId, details);
}

function getModActions(guildId, moderatorId, limit = 10, offset = 0) {
  const s = getStmts();
  const rows = s.getModActions.all(guildId, moderatorId, limit, offset);
  const total = s.getModActionsCount.get(guildId, moderatorId).count;
  return { rows, total };
}

module.exports = {
  addModAction,
  getModActions,
};
