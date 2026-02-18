const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const logger = require('../logger');

const dbDir = path.dirname(path.resolve(config.database.path));
fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(path.resolve(config.database.path));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function runMigrations() {
  const version = db.pragma('user_version', { simple: true });

  if (version < 1) {
    logger.info('Running database migration v1: initial schema');
    db.exec(`
      CREATE TABLE IF NOT EXISTS guild_settings (
        guild_id TEXT PRIMARY KEY,
        moderator_role_id TEXT,
        crosspost_threshold INTEGER DEFAULT 80,
        crosspost_window_hours INTEGER DEFAULT 48,
        warning_threshold INTEGER DEFAULT 3,
        exempt_channels TEXT DEFAULT '[]',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS warnings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        moderator_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('manual', 'crosspost')),
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_warnings_guild_user ON warnings(guild_id, user_id);
      CREATE INDEX IF NOT EXISTS idx_warnings_created ON warnings(created_at);

      CREATE TABLE IF NOT EXISTS crosspost_incidents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        original_channel_id TEXT NOT NULL,
        original_message_content TEXT,
        crosspost_channel_id TEXT NOT NULL,
        crosspost_message_content TEXT,
        similarity_score REAL NOT NULL,
        action_taken TEXT NOT NULL CHECK(action_taken IN ('deleted', 'warned')),
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_crosspost_guild_user ON crosspost_incidents(guild_id, user_id);

      CREATE TABLE IF NOT EXISTS message_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        message_id TEXT NOT NULL UNIQUE,
        content TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_message_cache_lookup ON message_cache(guild_id, user_id, channel_id);
      CREATE INDEX IF NOT EXISTS idx_message_cache_created ON message_cache(created_at);
    `);
    db.pragma('user_version = 1');
  }

  if (version < 2) {
    logger.info('Running database migration v2: add warn_log_channel_id');
    db.exec(`ALTER TABLE guild_settings ADD COLUMN warn_log_channel_id TEXT DEFAULT NULL`);
    db.pragma('user_version = 2');
  }

  if (version < 3) {
    logger.info('Running database migration v3: add warn_role_id');
    db.exec(`ALTER TABLE guild_settings ADD COLUMN warn_role_id TEXT DEFAULT NULL`);
    db.pragma('user_version = 3');
  }

  if (version < 4) {
    logger.info('Running database migration v4: add custom message columns');
    db.exec(`ALTER TABLE guild_settings ADD COLUMN crosspost_first_message TEXT DEFAULT NULL`);
    db.exec(`ALTER TABLE guild_settings ADD COLUMN crosspost_repeat_message TEXT DEFAULT NULL`);
    db.exec(`ALTER TABLE guild_settings ADD COLUMN warn_public_message TEXT DEFAULT NULL`);
    db.pragma('user_version = 4');
  }

  if (version < 5) {
    logger.info('Running database migration v5: add crosspost_detection_seconds');
    db.exec(`ALTER TABLE guild_settings ADD COLUMN crosspost_detection_seconds INTEGER DEFAULT 30`);
    db.pragma('user_version = 5');
  }

  if (version < 6) {
    logger.info('Running database migration v6: add ban_log_channel_id');
    db.exec(`ALTER TABLE guild_settings ADD COLUMN ban_log_channel_id TEXT DEFAULT NULL`);
    db.pragma('user_version = 6');
  }

  logger.info(`Database at schema version ${db.pragma('user_version', { simple: true })}`);
}

let cleanupStmt;

function cleanupMessageCache(maxHours = 48) {
  if (!cleanupStmt) {
    cleanupStmt = db.prepare(
      `DELETE FROM message_cache WHERE created_at < datetime('now', '-' || ? || ' hours')`
    );
  }
  const result = cleanupStmt.run(maxHours);
  return result.changes;
}

module.exports = { db, runMigrations, cleanupMessageCache };
