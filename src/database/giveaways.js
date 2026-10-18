const { db } = require('./db');

async function createGiveaway(guildId, channelId, hostId, title, prize, description, color, winnerCount, claimTime, claimAction, endsAt) {
  const id = await db.insert(
    `INSERT INTO giveaways (guild_id, channel_id, host_id, title, prize, description, color, winner_count, claim_time, claim_action, ends_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [guildId, channelId, hostId, title, prize, description || null, color || null, winnerCount, claimTime || null, claimAction || 'reroll', endsAt]
  );
  return { id, ...(await getGiveaway(id)) };
}

function setMessageId(giveawayId, messageId) {
  return db.run(`UPDATE giveaways SET message_id = ? WHERE id = ?`, [messageId, giveawayId]);
}

function getGiveaway(id) {
  return db.get(`SELECT * FROM giveaways WHERE id = ?`, [id]);
}

function getGiveawayByMessage(messageId) {
  return db.get(`SELECT * FROM giveaways WHERE message_id = ?`, [messageId]);
}

function getActiveGiveaways(guildId) {
  return db.all(`SELECT * FROM giveaways WHERE guild_id = ? AND ended = 0 ORDER BY ends_at ASC, id ASC`, [guildId]);
}

function getActiveInChannel(channelId) {
  return db.all(`SELECT * FROM giveaways WHERE channel_id = ? AND ended = 0 ORDER BY ends_at ASC, id ASC`, [channelId]);
}

function getRecentEndedInChannel(channelId) {
  return db.get(`SELECT * FROM giveaways WHERE channel_id = ? AND ended = 1 ORDER BY ends_at DESC, id DESC LIMIT 1`, [channelId]);
}

function getAllForGuild(guildId) {
  return db.all(`SELECT * FROM giveaways WHERE guild_id = ? ORDER BY created_at DESC, id DESC LIMIT 50`, [guildId]);
}

function getExpiredGiveaways() {
  return db.all(`SELECT * FROM giveaways WHERE ended = 0 AND ends_at <= datetime('now')`);
}

function markEnded(giveawayId, winnersJson) {
  return db.run(`UPDATE giveaways SET ended = 1, winners = ? WHERE id = ?`, [winnersJson, giveawayId]);
}

function updateGiveaway(giveawayId, title, prize, description, color, winnerCount, claimTime, claimAction) {
  return db.run(
    `UPDATE giveaways SET title = ?, prize = ?, description = ?, color = ?, winner_count = ?, claim_time = ?, claim_action = ? WHERE id = ?`,
    [title, prize, description || null, color || null, winnerCount, claimTime || null, claimAction || 'reroll', giveawayId]
  );
}

function deleteGiveaway(giveawayId) {
  return db.run(`DELETE FROM giveaways WHERE id = ?`, [giveawayId]);
}

function addEntry(giveawayId, userId) {
  return db.run(`INSERT OR IGNORE INTO giveaway_entries (giveaway_id, user_id) VALUES (?, ?)`, [giveawayId, userId]);
}

// Enters a user only while the giveaway is still running, so a click that
// races the end cannot add someone to the reroll pool. changes is 1 when the
// entry was added, 0 when the user was already in or the giveaway has ended.
function addEntryIfActive(giveawayId, userId) {
  return db.run(
    `INSERT INTO giveaway_entries (giveaway_id, user_id)
     SELECT ?, ? WHERE EXISTS (SELECT 1 FROM giveaways WHERE id = ? AND ended = 0)
     ON CONFLICT (giveaway_id, user_id) DO NOTHING`,
    [giveawayId, userId, giveawayId]
  );
}

function removeEntry(giveawayId, userId) {
  return db.run(`DELETE FROM giveaway_entries WHERE giveaway_id = ? AND user_id = ?`, [giveawayId, userId]);
}

async function getEntries(giveawayId) {
  const rows = await db.all(`SELECT user_id FROM giveaway_entries WHERE giveaway_id = ? ORDER BY id`, [giveawayId]);
  return rows.map(r => r.user_id);
}

async function getEntryCount(giveawayId) {
  const row = await db.get(`SELECT COUNT(*) as count FROM giveaway_entries WHERE giveaway_id = ?`, [giveawayId]);
  return row.count;
}

async function hasEntry(giveawayId, userId) {
  return !!(await db.get(`SELECT 1 AS found FROM giveaway_entries WHERE giveaway_id = ? AND user_id = ?`, [giveawayId, userId]));
}

function setClaimDeadline(giveawayId, deadline) {
  return db.run(`UPDATE giveaways SET claim_deadline = ? WHERE id = ?`, [deadline, giveawayId]);
}

function clearClaimDeadline(giveawayId) {
  return db.run(`UPDATE giveaways SET claim_deadline = NULL WHERE id = ?`, [giveawayId]);
}

function getClaim(giveawayId, userId) {
  return db.get(`SELECT * FROM giveaway_claims WHERE giveaway_id = ? AND user_id = ?`, [giveawayId, userId]);
}

function getClaims(giveawayId) {
  return db.all(`SELECT user_id, status FROM giveaway_claims WHERE giveaway_id = ?`, [giveawayId]);
}

function setClaim(giveawayId, userId, status) {
  return db.run(
    `INSERT INTO giveaway_claims (giveaway_id, user_id, status) VALUES (?, ?, ?) ON CONFLICT(giveaway_id, user_id) DO UPDATE SET status = excluded.status, updated_at = datetime('now')`,
    [giveawayId, userId, status]
  );
}

// Marks a winner's prize as claimed. Atomic: changes is 1 only for the call
// that actually made the transition, so a double click (or two devices) cannot
// run the claim side effects twice.
function claimPrize(giveawayId, userId) {
  return db.run(
    `INSERT INTO giveaway_claims (giveaway_id, user_id, status) VALUES (?, ?, 'claimed')
     ON CONFLICT (giveaway_id, user_id) DO UPDATE SET status = 'claimed', updated_at = datetime('now')
     WHERE giveaway_claims.status <> 'claimed'`,
    [giveawayId, userId]
  );
}

function clearClaims(giveawayId) {
  return db.run(`DELETE FROM giveaway_claims WHERE giveaway_id = ?`, [giveawayId]);
}

// Writes a giveaway's winners and claim deadline in one transaction, so it can
// never be left ended without its claim window (or with stale claims).
//   expiredIds:  winners whose claim window ran out (marked 'expired')
//   resetClaims: forget every claim (a manual reroll starts over)
function recordWinners(giveawayId, winnerIds, claimDeadline, { expiredIds = [], resetClaims = false } = {}) {
  return db.transaction(async tx => {
    if (resetClaims) {
      await tx.run(`DELETE FROM giveaway_claims WHERE giveaway_id = ?`, [giveawayId]);
    }
    for (const userId of expiredIds) {
      await tx.run(
        `INSERT INTO giveaway_claims (giveaway_id, user_id, status) VALUES (?, ?, 'expired')
         ON CONFLICT (giveaway_id, user_id) DO UPDATE SET status = 'expired', updated_at = datetime('now')`,
        [giveawayId, userId]
      );
    }
    await tx.run(
      `UPDATE giveaways SET ended = 1, winners = ?, claim_deadline = ? WHERE id = ?`,
      [JSON.stringify(winnerIds), claimDeadline, giveawayId]
    );
  });
}

function getPendingClaimGiveaways() {
  return db.all(`SELECT * FROM giveaways WHERE ended = 1 AND claim_time IS NOT NULL AND claim_deadline IS NOT NULL AND claim_deadline <= datetime('now')`);
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
  updateGiveaway,
  deleteGiveaway,
  addEntry,
  addEntryIfActive,
  removeEntry,
  getEntries,
  getEntryCount,
  hasEntry,
  setClaimDeadline,
  clearClaimDeadline,
  getClaim,
  getClaims,
  setClaim,
  claimPrize,
  clearClaims,
  recordWinners,
  getPendingClaimGiveaways,
};
