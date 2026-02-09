const { db } = require('./db');

let stmts;

function getStmts() {
  if (!stmts) {
    stmts = {
      cacheMessage: db.prepare(`INSERT OR REPLACE INTO message_cache (guild_id, channel_id, user_id, message_id, content) VALUES (?, ?, ?, ?, ?)`),
      getRecentMessages: db.prepare(`SELECT * FROM message_cache WHERE guild_id = ? AND user_id = ? AND channel_id != ? AND created_at > datetime('now', '-' || ? || ' seconds') ORDER BY created_at DESC`),
      deleteMessage: db.prepare(`DELETE FROM message_cache WHERE message_id = ?`),
      deleteOldMessages: db.prepare(`DELETE FROM message_cache WHERE created_at < datetime('now', '-' || ? || ' hours')`),
    };
  }
  return stmts;
}

function cacheMessage(guildId, channelId, userId, messageId, content) {
  return getStmts().cacheMessage.run(guildId, channelId, userId, messageId, content);
}

function getRecentMessages(guildId, userId, excludeChannelId, windowSeconds = 30) {
  return getStmts().getRecentMessages.all(guildId, userId, excludeChannelId, windowSeconds);
}

function deleteMessage(messageId) {
  return getStmts().deleteMessage.run(messageId);
}

function deleteOldMessages(windowHours = 48) {
  return getStmts().deleteOldMessages.run(windowHours);
}

module.exports = {
  cacheMessage,
  getRecentMessages,
  deleteMessage,
  deleteOldMessages,
};
