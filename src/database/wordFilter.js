const { db } = require('./db');

function addFilterWord(guildId, word, tier, wholeWord = 0) {
  return db.run(
    `INSERT OR IGNORE INTO word_filter (guild_id, word, tier, whole_word) VALUES (?, ?, ?, ?)`,
    [guildId, word.toLowerCase(), tier, wholeWord ? 1 : 0]
  );
}

function toggleWholeWord(guildId, id, wholeWord) {
  return db.run(`UPDATE word_filter SET whole_word = ? WHERE guild_id = ? AND id = ?`, [wholeWord ? 1 : 0, guildId, id]);
}

function removeFilterWord(guildId, word) {
  return db.run(`DELETE FROM word_filter WHERE guild_id = ? AND word = ?`, [guildId, word.toLowerCase()]);
}

function removeFilterWordById(guildId, id) {
  return db.run(`DELETE FROM word_filter WHERE guild_id = ? AND id = ?`, [guildId, id]);
}

function getFilterWords(guildId) {
  return db.all(`SELECT * FROM word_filter WHERE guild_id = ? ORDER BY tier, word`, [guildId]);
}

function getFilterWordsByTier(guildId, tier) {
  return db.all(`SELECT * FROM word_filter WHERE guild_id = ? AND tier = ? ORDER BY word`, [guildId, tier]);
}

function addFilterViolation(guildId, userId, wordMatched, tier, messageContent, channelId) {
  return db.run(
    `INSERT INTO filter_violations (guild_id, user_id, word_matched, tier, message_content, channel_id) VALUES (?, ?, ?, ?, ?, ?)`,
    [guildId, userId, wordMatched, tier, messageContent, channelId]
  );
}

async function getRecentViolations(guildId, userId, minutes) {
  const row = await db.get(
    `SELECT COUNT(*) as count FROM filter_violations
     WHERE guild_id = ? AND user_id = ? AND tier = 'soft'
       AND created_at > datetime('now', '-' || ? || ' minutes')`,
    [guildId, userId, minutes]
  );
  return row.count;
}

async function getFilterViolations(guildId, limit = 25, offset = 0) {
  const rows = await db.all(`SELECT * FROM filter_violations WHERE guild_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, [guildId, limit, offset]);
  const { count: total } = await db.get(`SELECT COUNT(*) as count FROM filter_violations WHERE guild_id = ?`, [guildId]);
  return { rows, total };
}

function addWhitelistWord(guildId, word, addedBy) {
  return db.run(`INSERT OR IGNORE INTO filter_whitelist (guild_id, word, added_by) VALUES (?, ?, ?)`, [guildId, word.toLowerCase(), addedBy || null]);
}

function removeWhitelistWord(guildId, word) {
  return db.run(`DELETE FROM filter_whitelist WHERE guild_id = ? AND word = ?`, [guildId, word.toLowerCase()]);
}

function getWhitelist(guildId) {
  return db.all(`SELECT * FROM filter_whitelist WHERE guild_id = ? ORDER BY word`, [guildId]);
}

module.exports = {
  addFilterWord,
  toggleWholeWord,
  removeFilterWord,
  removeFilterWordById,
  getFilterWords,
  getFilterWordsByTier,
  addFilterViolation,
  getRecentViolations,
  getFilterViolations,
  addWhitelistWord,
  removeWhitelistWord,
  getWhitelist,
};
