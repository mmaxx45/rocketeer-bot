'use strict';

// Database access for both backends. Every query goes through the async API
// below (get / all / run / insert / exec / transaction) with SQLite-flavoured
// SQL and `?` placeholders; on Postgres the SQL is translated by ./dialect.

const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../logger');
const dialect = require('./dialect');

// The SQLite migrations in ./migrations end at this version; a Postgres
// database reaches it through the snapshot plus POSTGRES_MIGRATIONS.
const SCHEMA_VERSION = 27;

// schema.postgres.sql is a snapshot of the schema at this version. A fresh
// Postgres database is created from it and then migrated forward, so the
// snapshot never has to be regenerated when a migration is added.
const POSTGRES_SNAPSHOT_VERSION = 26;

// Postgres schema changes after the snapshot. Each entry runs once, in a
// transaction, when the database is older than its version:
//   { version: 27, description: '...', up: async (tx) => { await tx.exec('ALTER TABLE ...'); } }
// Add the matching SQLite migration to ./migrations and bump SCHEMA_VERSION.
const POSTGRES_MIGRATIONS = [
  {
    version: 27,
    description: 'dashboard sessions, one open modmail thread per user',
    up: async tx => {
      await tx.exec(`
        CREATE TABLE IF NOT EXISTS web_sessions (
          sid TEXT PRIMARY KEY,
          sess TEXT NOT NULL,
          expires_at BIGINT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_web_sessions_expires ON web_sessions(expires_at);

        UPDATE modmail_threads SET status = 'closed', closed_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
        WHERE status = 'open' AND id NOT IN (
          SELECT MAX(id) FROM modmail_threads WHERE status = 'open' GROUP BY guild_id, user_id
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_modmail_one_open ON modmail_threads(guild_id, user_id) WHERE status = 'open';
      `);
    },
  },
];

const client = config.database.client === 'postgres' ? 'postgres' : 'sqlite';

let sqliteHandle = null;
let pgPool = null;
// Set by close(): the getters below would otherwise reopen the database for
// handlers still finishing during shutdown.
let closed = false;
const sqliteStatements = new Map();

function sqlite() {
  if (closed) throw new Error('the database is closed');
  if (!sqliteHandle) {
    const Database = require('better-sqlite3');
    const file = path.resolve(config.database.path);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    sqliteHandle = new Database(file);
    sqliteHandle.pragma('journal_mode = WAL');
    sqliteHandle.pragma('foreign_keys = ON');
  }
  return sqliteHandle;
}

function postgres() {
  if (closed) throw new Error('the database is closed');
  if (!pgPool) {
    const { Pool, types } = require('pg');
    // COUNT(*) and SUM() come back as int8 / numeric, which pg returns as
    // strings to avoid precision loss. Every count here fits in a JS number,
    // and callers compare and add them like SQLite's numbers.
    types.setTypeParser(types.builtins.INT8, value => parseInt(value, 10));
    types.setTypeParser(types.builtins.NUMERIC, value => parseFloat(value));

    const settings = config.database;
    pgPool = new Pool({
      connectionString: settings.url || undefined,
      host: settings.url ? undefined : settings.host,
      port: settings.url ? undefined : settings.port,
      database: settings.url ? undefined : settings.name,
      user: settings.url ? undefined : settings.user,
      password: settings.url ? undefined : settings.password,
      max: settings.poolSize || 10,
      // Fail instead of hanging forever when the server is unreachable.
      connectionTimeoutMillis: 10000,
      ssl: settings.ssl ? { rejectUnauthorized: settings.ssl !== 'no-verify' } : undefined,
    });
    pgPool.on('error', err => logger.error(`Postgres pool error: ${err.message}`));
  }
  return pgPool;
}

function statement(sql) {
  let prepared = sqliteStatements.get(sql);
  if (!prepared) {
    prepared = sqlite().prepare(sql);
    sqliteStatements.set(sql, prepared);
  }
  return prepared;
}

function withReturningId(sql) {
  return /\breturning\b/i.test(sql) ? sql : sql.replace(/[\s;]*$/, '') + ' RETURNING id';
}

// The SQL strings are static, so translate each one once.
const postgresSql = new Map();

function toPostgres(sql) {
  let translated = postgresSql.get(sql);
  if (translated === undefined) {
    translated = dialect.toPostgres(sql);
    postgresSql.set(sql, translated);
  }
  return translated;
}

// Query helpers bound to one Postgres connection (the pool, or a client that
// holds an open transaction).
function postgresApi(connection) {
  const query = (sql, params = []) => connection.query(toPostgres(sql), params);
  return {
    async get(sql, params) {
      return (await query(sql, params)).rows[0];
    },
    async all(sql, params) {
      return (await query(sql, params)).rows;
    },
    async run(sql, params) {
      const result = await query(sql, params);
      return { changes: result.rowCount, lastInsertRowid: result.rows[0] ? result.rows[0].id : undefined };
    },
    async insert(sql, params) {
      const result = await query(withReturningId(sql), params);
      return result.rows[0] ? result.rows[0].id : undefined;
    },
    async exec(sql) {
      await connection.query(sql);
    },
  };
}

const sqliteApi = {
  async get(sql, params = []) {
    return statement(sql).get(...params);
  },
  async all(sql, params = []) {
    return statement(sql).all(...params);
  },
  async run(sql, params = []) {
    const info = statement(sql).run(...params);
    return { changes: info.changes, lastInsertRowid: info.lastInsertRowid };
  },
  async insert(sql, params = []) {
    return statement(sql).run(...params).lastInsertRowid;
  },
  async exec(sql) {
    sqlite().exec(sql);
  },
};

function api() {
  return client === 'postgres' ? postgresApi(postgres()) : sqliteApi;
}

// async so that every failure, including a closed database, is a rejection
// rather than a synchronous throw.
const get = async (sql, params) => api().get(sql, params);
const all = async (sql, params) => api().all(sql, params);
const run = async (sql, params) => api().run(sql, params);
const insert = async (sql, params) => api().insert(sql, params);
const exec = async sql => api().exec(sql);

// SQLite has a single connection, so transactions are serialised here: a
// second BEGIN while one is open would fail. Statements issued outside a
// transaction while one is awaiting still run on the same connection.
let sqliteTransactionQueue = Promise.resolve();

// Runs fn(tx) in a transaction; tx has get / all / run / insert / exec.
// Commits when fn resolves, rolls back when it throws.
async function transaction(fn) {
  if (client === 'postgres') {
    const connection = await postgres().connect();
    try {
      await connection.query('BEGIN');
      const result = await fn(postgresApi(connection));
      await connection.query('COMMIT');
      return result;
    } catch (err) {
      await connection.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      connection.release();
    }
  }

  const previous = sqliteTransactionQueue;
  let release;
  sqliteTransactionQueue = new Promise(resolve => { release = resolve; });
  await previous;
  const handle = sqlite();
  try {
    handle.exec('BEGIN IMMEDIATE');
    try {
      const result = await fn(sqliteApi);
      handle.exec('COMMIT');
      return result;
    } catch (err) {
      if (handle.inTransaction) handle.exec('ROLLBACK');
      throw err;
    }
  } finally {
    release();
  }
}

async function ping() {
  await get('SELECT 1 AS ok');
  return true;
}

async function runMigrations() {
  if (client === 'postgres') return runPostgresMigrations();
  const { runSqliteMigrations } = require('./migrations');
  runSqliteMigrations(sqlite(), logger);
}

async function readPostgresVersion(pool) {
  await pool.query('CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const found = await pool.query("SELECT value FROM app_meta WHERE key = 'schema_version'");
  return found.rows[0] ? parseInt(found.rows[0].value, 10) : 0;
}

const SET_VERSION = "INSERT INTO app_meta (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value";

async function runPostgresMigrations() {
  const pool = postgres();
  let current = await readPostgresVersion(pool);

  if (current === 0) {
    logger.info(`Creating the Postgres schema (version ${POSTGRES_SNAPSHOT_VERSION})`);
    const schema = fs.readFileSync(path.join(__dirname, 'schema.postgres.sql'), 'utf8');
    await transaction(async tx => {
      // Two processes starting at once (e.g. the installer check and the
      // service) must not both create the schema.
      await tx.exec('LOCK TABLE app_meta IN EXCLUSIVE MODE');
      const again = await tx.get("SELECT value FROM app_meta WHERE key = 'schema_version'");
      if (again) return;
      await tx.exec(schema);
      await tx.run(SET_VERSION, [String(POSTGRES_SNAPSHOT_VERSION)]);
    });
    current = await readPostgresVersion(pool);
  }

  for (const migration of POSTGRES_MIGRATIONS) {
    if (migration.version <= current) continue;
    logger.info(`Running Postgres migration v${migration.version}: ${migration.description}`);
    await transaction(async tx => {
      await migration.up(tx);
      await tx.run(SET_VERSION, [String(migration.version)]);
    });
    current = migration.version;
  }

  if (current > SCHEMA_VERSION) {
    logger.warn(`Database schema version ${current} is newer than this build (${SCHEMA_VERSION}); was the bot downgraded?`);
  }
  logger.info(`Database at schema version ${current} (postgres)`);
}

async function close() {
  closed = true;
  if (pgPool) {
    const pool = pgPool;
    pgPool = null;
    await pool.end();
  }
  if (sqliteHandle) {
    sqliteHandle.close();
    sqliteHandle = null;
    sqliteStatements.clear();
  }
}

// True when err is a unique-constraint violation on either backend.
function isUniqueViolation(err) {
  return Boolean(err) && (err.code === '23505' || err.code === 'SQLITE_CONSTRAINT_UNIQUE' || err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY');
}

const db = { client, get, all, run, insert, exec, transaction, ping, runMigrations, close, isUniqueViolation, SCHEMA_VERSION };

module.exports = { db, runMigrations, close };
