const { db } = require('./db');

let stmts;

function getStmts() {
  if (!stmts) {
    stmts = {
      addWord: db.prepare(`INSERT OR IGNORE INTO word_filter (guild_id, word, tier) VALUES (?, ?, ?)`),
      removeWord: db.prepare(`DELETE FROM word_filter WHERE guild_id = ? AND word = ?`),
      getWords: db.prepare(`SELECT * FROM word_filter WHERE guild_id = ? ORDER BY tier, word`),
      getWordsByTier: db.prepare(`SELECT * FROM word_filter WHERE guild_id = ? AND tier = ? ORDER BY word`),
      addViolation: db.prepare(`INSERT INTO filter_violations (guild_id, user_id, word_matched, tier, message_content, channel_id) VALUES (?, ?, ?, ?, ?, ?)`),
      getRecentViolations: db.prepare(`
        SELECT COUNT(*) as count FROM filter_violations
        WHERE guild_id = ? AND user_id = ? AND tier = 'soft'
          AND created_at > datetime('now', '-' || ? || ' minutes')
      `),
      getViolations: db.prepare(`SELECT * FROM filter_violations WHERE guild_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`),
      getViolationsCount: db.prepare(`SELECT COUNT(*) as count FROM filter_violations WHERE guild_id = ?`),
      removeWordById: db.prepare(`DELETE FROM word_filter WHERE guild_id = ? AND id = ?`),
      addWhitelist: db.prepare(`INSERT OR IGNORE INTO filter_whitelist (guild_id, word, added_by) VALUES (?, ?, ?)`),
      removeWhitelist: db.prepare(`DELETE FROM filter_whitelist WHERE guild_id = ? AND word = ?`),
      getWhitelist: db.prepare(`SELECT * FROM filter_whitelist WHERE guild_id = ? ORDER BY word`),
    };
  }
  return stmts;
}

function addFilterWord(guildId, word, tier) {
  return getStmts().addWord.run(guildId, word.toLowerCase(), tier);
}

function removeFilterWord(guildId, word) {
  return getStmts().removeWord.run(guildId, word.toLowerCase());
}

function removeFilterWordById(guildId, id) {
  return getStmts().removeWordById.run(guildId, id);
}

function getFilterWords(guildId) {
  return getStmts().getWords.all(guildId);
}

function getFilterWordsByTier(guildId, tier) {
  return getStmts().getWordsByTier.all(guildId, tier);
}

function addFilterViolation(guildId, userId, wordMatched, tier, messageContent, channelId) {
  return getStmts().addViolation.run(guildId, userId, wordMatched, tier, messageContent, channelId);
}

function getRecentViolations(guildId, userId, minutes) {
  return getStmts().getRecentViolations.get(guildId, userId, minutes).count;
}

function getFilterViolations(guildId, limit = 25, offset = 0) {
  const s = getStmts();
  const rows = s.getViolations.all(guildId, limit, offset);
  const total = s.getViolationsCount.get(guildId).count;
  return { rows, total };
}

function addWhitelistWord(guildId, word, addedBy) {
  return getStmts().addWhitelist.run(guildId, word.toLowerCase(), addedBy || null);
}

function removeWhitelistWord(guildId, word) {
  return getStmts().removeWhitelist.run(guildId, word.toLowerCase());
}

function getWhitelist(guildId) {
  return getStmts().getWhitelist.all(guildId);
}

module.exports = {
  addFilterWord,
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
