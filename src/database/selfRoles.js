const { db } = require('./db');

async function createPanel(guildId, channelId, messageId, title, description) {
  const id = await db.insert(
    `INSERT INTO self_role_panels (guild_id, channel_id, message_id, title, description) VALUES (?, ?, ?, ?, ?)`,
    [guildId, channelId, messageId, title, description || null]
  );
  return getPanel(id);
}

function getPanel(panelId) {
  return db.get(`SELECT * FROM self_role_panels WHERE id = ?`, [panelId]);
}

function getPanelByMessage(messageId) {
  return db.get(`SELECT * FROM self_role_panels WHERE message_id = ?`, [messageId]);
}

function getPanels(guildId) {
  return db.all(`SELECT * FROM self_role_panels WHERE guild_id = ? ORDER BY created_at DESC, id DESC`, [guildId]);
}

function updatePanel(panelId, title, description) {
  return db.run(`UPDATE self_role_panels SET title = ?, description = ? WHERE id = ?`, [title, description || null, panelId]);
}

function deletePanel(panelId) {
  return db.run(`DELETE FROM self_role_panels WHERE id = ?`, [panelId]);
}

async function addRoleOption(panelId, roleId, label, emoji, description) {
  await db.run(
    `INSERT INTO self_role_options (panel_id, role_id, label, emoji, description, sort_order) VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM self_role_options WHERE panel_id = ?))`,
    [panelId, roleId, label || null, emoji || null, description || null, panelId]
  );
  return getRoleOptions(panelId);
}

function removeRoleOption(panelId, roleId) {
  return db.run(`DELETE FROM self_role_options WHERE panel_id = ? AND role_id = ?`, [panelId, roleId]);
}

function getRoleOptions(panelId) {
  return db.all(`SELECT * FROM self_role_options WHERE panel_id = ? ORDER BY sort_order ASC, id ASC`, [panelId]);
}

module.exports = { createPanel, getPanel, getPanelByMessage, getPanels, updatePanel, deletePanel, addRoleOption, removeRoleOption, getRoleOptions };
