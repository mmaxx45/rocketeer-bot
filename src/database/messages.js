/**
 * In-memory message cache for crosspost similarity detection.
 *
 * Messages are short-lived (checked within seconds) so there is no need
 * to persist them to SQLite. A plain Map avoids unnecessary disk I/O.
 *
 * Primary index:  cacheByUser   – Map<"guildId:userId", Array<Entry>>
 * Secondary index: cacheById    – Map<messageId, Entry>   (for deleteMessage)
 *
 * Entry shape: { guildId, channelId, messageId, content, createdAt }
 */

const DEFAULT_MAX_AGE_SECONDS = 300; // 5 minutes — plenty for 30-second detection window
const DEFAULT_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // run cleanup every 5 minutes

/** @type {Map<string, Array<{guildId: string, channelId: string, messageId: string, content: string, createdAt: number}>>} */
const cacheByUser = new Map();

/** @type {Map<string, {guildId: string, channelId: string, messageId: string, content: string, createdAt: number, userKey: string}>} */
const cacheById = new Map();

let cleanupTimer = null;
let maxAgeSeconds = DEFAULT_MAX_AGE_SECONDS;

// ---------------------------------------------------------------------------
// Public API — same function signatures as the old SQLite-backed module
// ---------------------------------------------------------------------------

function cacheMessage(guildId, channelId, userId, messageId, content) {
  const userKey = `${guildId}:${userId}`;
  const entry = {
    guildId,
    channelId,
    messageId,
    content,
    createdAt: Date.now(),
    userKey, // kept so deleteMessage can locate the array quickly
  };

  // User-keyed list
  let list = cacheByUser.get(userKey);
  if (!list) {
    list = [];
    cacheByUser.set(userKey, list);
  }
  list.push(entry);

  // Message-ID index
  cacheById.set(messageId, entry);
}

/**
 * Return recent messages for the given guild + user, excluding a specific
 * channel, within the last `windowSeconds`.
 *
 * Returns objects with the same property names the rest of the codebase
 * expects (channel_id, message_id, content) for backward compatibility
 * with code written against the old SQLite column names.
 */
function getRecentMessages(guildId, userId, excludeChannelId, windowSeconds = 30) {
  const userKey = `${guildId}:${userId}`;
  const list = cacheByUser.get(userKey);
  if (!list || list.length === 0) return [];

  const cutoff = Date.now() - windowSeconds * 1000;
  const results = [];

  for (const entry of list) {
    if (entry.createdAt > cutoff && entry.channelId !== excludeChannelId) {
      // Expose SQLite-compatible property names so callers don't need changes
      results.push({
        channel_id: entry.channelId,
        message_id: entry.messageId,
        content: entry.content,
      });
    }
  }

  // Most recent first (matches the old ORDER BY created_at DESC)
  results.reverse();
  return results;
}

function deleteMessage(messageId) {
  const entry = cacheById.get(messageId);
  if (!entry) return;

  cacheById.delete(messageId);

  const list = cacheByUser.get(entry.userKey);
  if (list) {
    const idx = list.indexOf(entry);
    if (idx !== -1) list.splice(idx, 1);
    if (list.length === 0) cacheByUser.delete(entry.userKey);
  }
}

/**
 * No-op — retained for backward compatibility. The in-memory cache handles
 * its own cleanup via startCleanup / the periodic timer.
 */
function deleteOldMessages() {
  // intentional no-op
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

function purgeExpired() {
  const cutoff = Date.now() - maxAgeSeconds * 1000;

  for (const [userKey, list] of cacheByUser) {
    // Entries are appended chronologically, so we can find the first
    // non-expired index and slice.
    let firstValid = 0;
    while (firstValid < list.length && list[firstValid].createdAt <= cutoff) {
      cacheById.delete(list[firstValid].messageId);
      firstValid++;
    }
    if (firstValid > 0) {
      list.splice(0, firstValid);
    }
    if (list.length === 0) {
      cacheByUser.delete(userKey);
    }
  }
}

/**
 * Start the periodic cleanup timer.
 * @param {number} [intervalMs=300000] – how often to run cleanup (default 5 min)
 * @param {number} [maxAgeSec=300]     – entries older than this are purged
 */
function startCleanup(intervalMs = DEFAULT_CLEANUP_INTERVAL_MS, maxAgeSec = DEFAULT_MAX_AGE_SECONDS) {
  stopCleanup(); // clear any existing timer
  maxAgeSeconds = maxAgeSec;
  cleanupTimer = setInterval(purgeExpired, intervalMs);
  // Allow the Node process to exit even if the timer is still scheduled
  if (cleanupTimer.unref) cleanupTimer.unref();
}

function stopCleanup() {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

// Auto-start cleanup so callers don't have to remember
startCleanup();

module.exports = {
  cacheMessage,
  getRecentMessages,
  deleteMessage,
  deleteOldMessages,
  startCleanup,
  stopCleanup,
};
