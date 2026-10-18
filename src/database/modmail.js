const { db } = require('./db');

function createThread(guildId, userId, channelId) {
  return db.run(`INSERT INTO modmail_threads (guild_id, user_id, channel_id) VALUES (?, ?, ?)`, [guildId, userId, channelId]);
}

function getOpenThread(guildId, userId) {
  return db.get(`SELECT * FROM modmail_threads WHERE guild_id = ? AND user_id = ? AND status = 'open' LIMIT 1`, [guildId, userId]);
}

function getOpenThreadByChannel(channelId) {
  return db.get(`SELECT * FROM modmail_threads WHERE channel_id = ? AND status = 'open' LIMIT 1`, [channelId]);
}

function getThreadByChannel(channelId) {
  return db.get(`SELECT * FROM modmail_threads WHERE channel_id = ? LIMIT 1`, [channelId]);
}

function closeThread(threadId, closedBy) {
  return db.run(`UPDATE modmail_threads SET status = 'closed', closed_at = datetime('now'), closed_by = ? WHERE id = ?`, [closedBy, threadId]);
}

function getOpenThreadForUser(userId) {
  return db.get(`SELECT * FROM modmail_threads WHERE user_id = ? AND status = 'open' LIMIT 1`, [userId]);
}

function getAllOpenThreads(guildId) {
  return db.all(`SELECT * FROM modmail_threads WHERE guild_id = ? AND status = 'open' ORDER BY created_at DESC, id DESC`, [guildId]);
}

module.exports = {
  createThread,
  getOpenThread,
  getOpenThreadByChannel,
  getThreadByChannel,
  closeThread,
  getOpenThreadForUser,
  getAllOpenThreads,
};
