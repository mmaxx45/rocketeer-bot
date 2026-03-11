const { db } = require('./db');

let stmts;

function getStmts() {
  if (!stmts) {
    stmts = {
      addModAction: db.prepare(`INSERT INTO mod_actions (guild_id, moderator_id, action_type, target_id, details) VALUES (?, ?, ?, ?, ?)`),
      getLastBanAction: db.prepare(`SELECT * FROM mod_actions WHERE guild_id = ? AND target_id = ? AND action_type = 'ban' ORDER BY created_at DESC LIMIT 1`),
    };
  }
  return stmts;
}

function addModAction(guildId, moderatorId, actionType, targetId, details = null) {
  return getStmts().addModAction.run(guildId, moderatorId, actionType, targetId, details);
}

function getLastBanAction(guildId, targetId) {
  return getStmts().getLastBanAction.get(guildId, targetId);
}

module.exports = {
  addModAction,
  getLastBanAction,
};
