const { db } = require('./db');

let stmts;

function getStmts() {
  if (!stmts) {
    stmts = {
      createThread: db.prepare(
        `INSERT INTO modmail_threads (guild_id, user_id, channel_id) VALUES (?, ?, ?)`
      ),
      getOpenThread: db.prepare(
        `SELECT * FROM modmail_threads WHERE guild_id = ? AND user_id = ? AND status = 'open' LIMIT 1`
      ),
      getOpenThreadByChannel: db.prepare(
        `SELECT * FROM modmail_threads WHERE channel_id = ? AND status = 'open' LIMIT 1`
      ),
      getThreadByChannel: db.prepare(
        `SELECT * FROM modmail_threads WHERE channel_id = ? LIMIT 1`
      ),
      closeThread: db.prepare(
        `UPDATE modmail_threads SET status = 'closed', closed_at = datetime('now'), closed_by = ? WHERE id = ?`
      ),
      getOpenThreadForUser: db.prepare(
        `SELECT * FROM modmail_threads WHERE user_id = ? AND status = 'open' LIMIT 1`
      ),
      getAllOpenThreads: db.prepare(
        `SELECT * FROM modmail_threads WHERE guild_id = ? AND status = 'open' ORDER BY created_at DESC`
      ),
    };
  }
  return stmts;
}

function createThread(guildId, userId, channelId) {
  return getStmts().createThread.run(guildId, userId, channelId);
}

function getOpenThread(guildId, userId) {
  return getStmts().getOpenThread.get(guildId, userId);
}

function getOpenThreadByChannel(channelId) {
  return getStmts().getOpenThreadByChannel.get(channelId);
}

function getThreadByChannel(channelId) {
  return getStmts().getThreadByChannel.get(channelId);
}

function closeThread(threadId, closedBy) {
  return getStmts().closeThread.run(closedBy, threadId);
}

function getOpenThreadForUser(userId) {
  return getStmts().getOpenThreadForUser.get(userId);
}

function getAllOpenThreads(guildId) {
  return getStmts().getAllOpenThreads.all(guildId);
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
