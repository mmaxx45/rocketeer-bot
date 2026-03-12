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

function columnExists(table, column) {
  const cols = db.pragma(`table_info(${table})`);
  return cols.some(c => c.name === column);
}

function safeAddColumn(table, column, type) {
  if (!columnExists(table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

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
    safeAddColumn('guild_settings', 'warn_log_channel_id', 'TEXT DEFAULT NULL');
    db.pragma('user_version = 2');
  }

  if (version < 3) {
    logger.info('Running database migration v3: add warn_role_id');
    safeAddColumn('guild_settings', 'warn_role_id', 'TEXT DEFAULT NULL');
    db.pragma('user_version = 3');
  }

  if (version < 4) {
    logger.info('Running database migration v4: add custom message columns');
    safeAddColumn('guild_settings', 'crosspost_first_message', 'TEXT DEFAULT NULL');
    safeAddColumn('guild_settings', 'crosspost_repeat_message', 'TEXT DEFAULT NULL');
    safeAddColumn('guild_settings', 'warn_public_message', 'TEXT DEFAULT NULL');
    db.pragma('user_version = 4');
  }

  if (version < 5) {
    logger.info('Running database migration v5: add crosspost_detection_seconds');
    safeAddColumn('guild_settings', 'crosspost_detection_seconds', 'INTEGER DEFAULT 30');
    db.pragma('user_version = 5');
  }

  if (version < 6) {
    logger.info('Running database migration v6: add ban_log_channel_id');
    safeAddColumn('guild_settings', 'ban_log_channel_id', 'TEXT DEFAULT NULL');
    db.pragma('user_version = 6');
  }

  if (version < 7) {
    logger.info('Running database migration v7: new features batch');
    safeAddColumn('guild_settings', 'crosspost_kick_count', 'INTEGER DEFAULT 3');
    safeAddColumn('guild_settings', 'crosspost_kick_window_minutes', 'INTEGER DEFAULT 60');
    safeAddColumn('guild_settings', 'ban_role_id', 'TEXT DEFAULT NULL');
    safeAddColumn('warnings', 'message_content', 'TEXT DEFAULT NULL');
    safeAddColumn('guild_settings', 'modmail_enabled', 'INTEGER DEFAULT 0');
    safeAddColumn('guild_settings', 'modmail_category_id', 'TEXT DEFAULT NULL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS modmail_threads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'closed')),
        created_at TEXT DEFAULT (datetime('now')),
        closed_at TEXT DEFAULT NULL,
        closed_by TEXT DEFAULT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_modmail_guild_user ON modmail_threads(guild_id, user_id);
      CREATE INDEX IF NOT EXISTS idx_modmail_channel ON modmail_threads(channel_id);
      CREATE INDEX IF NOT EXISTS idx_modmail_status ON modmail_threads(status);
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS mod_actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        moderator_id TEXT NOT NULL,
        action_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        details TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_mod_actions_guild_mod ON mod_actions(guild_id, moderator_id);
      CREATE INDEX IF NOT EXISTS idx_mod_actions_guild_target ON mod_actions(guild_id, target_id);
      CREATE INDEX IF NOT EXISTS idx_mod_actions_type ON mod_actions(guild_id, action_type);
    `);
    safeAddColumn('guild_settings', 'modactions_role_id', 'TEXT DEFAULT NULL');
    safeAddColumn('guild_settings', 'file_block_enabled', 'INTEGER DEFAULT 1');
    safeAddColumn('guild_settings', 'blocked_extensions', 'TEXT DEFAULT NULL');
    db.pragma('user_version = 7');
  }

  if (version < 8) {
    logger.info('Running database migration v8: add banreason_role_id and custom_warn_reasons');
    safeAddColumn('guild_settings', 'banreason_role_id', 'TEXT DEFAULT NULL');
    safeAddColumn('guild_settings', 'custom_warn_reasons', 'TEXT DEFAULT NULL');
    db.pragma('user_version = 8');
  }

  if (version < 9) {
    logger.info('Running database migration v9: add bot_status_message');
    safeAddColumn('guild_settings', 'bot_status_message', 'TEXT DEFAULT NULL');
    db.pragma('user_version = 9');
  }

  if (version < 10) {
    logger.info('Running database migration v10: licensing tickets');
    safeAddColumn('guild_settings', 'ticket_category_id', 'TEXT DEFAULT NULL');
    safeAddColumn('guild_settings', 'ticket_admin_role_id', 'TEXT DEFAULT NULL');
    safeAddColumn('guild_settings', 'ticket_log_channel_id', 'TEXT DEFAULT NULL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS license_tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'closed')),
        created_at TEXT DEFAULT (datetime('now')),
        closed_at TEXT DEFAULT NULL,
        closed_by TEXT DEFAULT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_license_tickets_guild_user ON license_tickets(guild_id, user_id);
      CREATE INDEX IF NOT EXISTS idx_license_tickets_channel ON license_tickets(channel_id);
      CREATE INDEX IF NOT EXISTS idx_license_tickets_status ON license_tickets(guild_id, status);
    `);
    db.pragma('user_version = 10');
  }

  logger.info(`Database at schema version ${db.pragma('user_version', { simple: true })}`);
}

module.exports = { db, runMigrations };
