const { db } = require('./db');

let stmts;

function getStmts() {
  if (!stmts) {
    stmts = {
      create: db.prepare(`INSERT INTO giveaways (guild_id, channel_id, host_id, title, prize, description, color, winner_count, ends_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      setMessageId: db.prepare(`UPDATE giveaways SET message_id = ? WHERE id = ?`),
      get: db.prepare(`SELECT * FROM giveaways WHERE id = ?`),
      getByMessage: db.prepare(`SELECT * FROM giveaways WHERE message_id = ?`),
      getActive: db.prepare(`SELECT * FROM giveaways WHERE guild_id = ? AND ended = 0 ORDER BY ends_at ASC`),
      getActiveInChannel: db.prepare(`SELECT * FROM giveaways WHERE channel_id = ? AND ended = 0 ORDER BY ends_at ASC`),
      getRecentEndedInChannel: db.prepare(`SELECT * FROM giveaways WHERE channel_id = ? AND ended = 1 ORDER BY ends_at DESC LIMIT 1`),
      getAllForGuild: db.prepare(`SELECT * FROM giveaways WHERE guild_id = ? ORDER BY created_at DESC LIMIT 50`),
      getExpired: db.prepare(`SELECT * FROM giveaways WHERE ended = 0 AND ends_at <= datetime('now')`),
      markEnded: db.prepare(`UPDATE giveaways SET ended = 1, winners = ? WHERE id = ?`),
      delete: db.prepare(`DELETE FROM giveaways WHERE id = ?`),
      addEntry: db.prepare(`INSERT OR IGNORE INTO giveaway_entries (giveaway_id, user_id) VALUES (?, ?)`),
      removeEntry: db.prepare(`DELETE FROM giveaway_entries WHERE giveaway_id = ? AND user_id = ?`),
      getEntries: db.prepare(`SELECT user_id FROM giveaway_entries WHERE giveaway_id = ?`),
      getEntryCount: db.prepare(`SELECT COUNT(*) as count FROM giveaway_entries WHERE giveaway_id = ?`),
      hasEntry: db.prepare(`SELECT 1 FROM giveaway_entries WHERE giveaway_id = ? AND user_id = ?`),
    };
  }
  return stmts;
}

function createGiveaway(guildId, channelId, hostId, title, prize, description, color, winnerCount, endsAt) {
  const result = getStmts().create.run(guildId, channelId, hostId, title, prize, description || null, color || null, winnerCount, endsAt);
  return { id: result.lastInsertRowid, ...getGiveaway(result.lastInsertRowid) };
}

function setMessageId(giveawayId, messageId) {
  return getStmts().setMessageId.run(messageId, giveawayId);
}

function getGiveaway(id) {
  return getStmts().get.get(id);
}

function getGiveawayByMessage(messageId) {
  return getStmts().getByMessage.get(messageId);
}

function getActiveGiveaways(guildId) {
  return getStmts().getActive.all(guildId);
}

function getActiveInChannel(channelId) {
  return getStmts().getActiveInChannel.all(channelId);
}

function getRecentEndedInChannel(channelId) {
  return getStmts().getRecentEndedInChannel.get(channelId);
}

function getAllForGuild(guildId) {
  return getStmts().getAllForGuild.all(guildId);
}

function getExpiredGiveaways() {
  return getStmts().getExpired.all();
}

function markEnded(giveawayId, winnersJson) {
  return getStmts().markEnded.run(winnersJson, giveawayId);
}

function deleteGiveaway(giveawayId) {
  return getStmts().delete.run(giveawayId);
}

function addEntry(giveawayId, userId) {
  return getStmts().addEntry.run(giveawayId, userId);
}

function removeEntry(giveawayId, userId) {
  return getStmts().removeEntry.run(giveawayId, userId);
}

function getEntries(giveawayId) {
  return getStmts().getEntries.all(giveawayId).map(r => r.user_id);
}

function getEntryCount(giveawayId) {
  return getStmts().getEntryCount.get(giveawayId).count;
}

function hasEntry(giveawayId, userId) {
  return !!getStmts().hasEntry.get(giveawayId, userId);
}

module.exports = {
  createGiveaway,
  setMessageId,
  getGiveaway,
  getGiveawayByMessage,
  getActiveGiveaways,
  getActiveInChannel,
  getRecentEndedInChannel,
  getAllForGuild,
  getExpiredGiveaways,
  markEnded,
  deleteGiveaway,
  addEntry,
  removeEntry,
  getEntries,
  getEntryCount,
  hasEntry,
};
