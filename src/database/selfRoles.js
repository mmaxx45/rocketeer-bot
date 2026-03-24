const { db } = require('./db');

let stmts;

function getStmts() {
  if (!stmts) {
    stmts = {
      createPanel: db.prepare(`INSERT INTO self_role_panels (guild_id, channel_id, message_id, title, description) VALUES (?, ?, ?, ?, ?)`),
      getPanel: db.prepare(`SELECT * FROM self_role_panels WHERE id = ?`),
      getPanelByMessage: db.prepare(`SELECT * FROM self_role_panels WHERE message_id = ?`),
      getPanels: db.prepare(`SELECT * FROM self_role_panels WHERE guild_id = ? ORDER BY created_at DESC`),
      updatePanel: db.prepare(`UPDATE self_role_panels SET title = ?, description = ? WHERE id = ?`),
      deletePanel: db.prepare(`DELETE FROM self_role_panels WHERE id = ?`),
      addRoleOption: db.prepare(`INSERT INTO self_role_options (panel_id, role_id, label, emoji, description, sort_order) VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM self_role_options WHERE panel_id = ?))`),
      removeRoleOption: db.prepare(`DELETE FROM self_role_options WHERE panel_id = ? AND role_id = ?`),
      getRoleOptions: db.prepare(`SELECT * FROM self_role_options WHERE panel_id = ? ORDER BY sort_order ASC`),
    };
  }
  return stmts;
}

function createPanel(guildId, channelId, messageId, title, description) {
  const s = getStmts();
  s.createPanel.run(guildId, channelId, messageId, title, description || null);
  return s.getPanelByMessage.get(messageId);
}

function getPanel(panelId) {
  return getStmts().getPanel.get(panelId);
}

function getPanelByMessage(messageId) {
  return getStmts().getPanelByMessage.get(messageId);
}

function getPanels(guildId) {
  return getStmts().getPanels.all(guildId);
}

function updatePanel(panelId, title, description) {
  return getStmts().updatePanel.run(title, description || null, panelId);
}

function deletePanel(panelId) {
  return getStmts().deletePanel.run(panelId);
}

function addRoleOption(panelId, roleId, label, emoji, description) {
  const s = getStmts();
  s.addRoleOption.run(panelId, roleId, label || null, emoji || null, description || null, panelId);
  return s.getRoleOptions.all(panelId);
}

function removeRoleOption(panelId, roleId) {
  return getStmts().removeRoleOption.run(panelId, roleId);
}

function getRoleOptions(panelId) {
  return getStmts().getRoleOptions.all(panelId);
}

module.exports = { createPanel, getPanel, getPanelByMessage, getPanels, updatePanel, deletePanel, addRoleOption, removeRoleOption, getRoleOptions };
