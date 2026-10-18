'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../logger');
const dialect = require('./dialect');

const SCHEMA_VERSION = 26;
const client = String(config.database.client || 'sqlite').toLowerCase() === 'postgres' ? 'postgres' : 'sqlite';

let sqliteHandle = null;
let pgPool = null;
const sqliteStatements = new Map();

function sqlite() {
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
  if (!pgPool) {
    const { Pool } = require('pg');
    const settings = config.database;
    pgPool = new Pool({
      connectionString: settings.url || undefined,
      host: settings.url ? undefined : settings.host,
      port: settings.url ? undefined : settings.port,
      database: settings.url ? undefined : settings.name,
      user: settings.url ? undefined : settings.user,
      password: settings.url ? undefined : settings.password,
      max: settings.poolSize || 10,
      ssl: settings.ssl ? { rejectUnauthorized: false } : undefined,
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

async function get(sql, params = []) {
  if (client === 'postgres') {
    const result = await postgres().query(dialect.toPostgres(sql), params);
    return result.rows[0];
  }
  return statement(sql).get(...params);
}

async function all(sql, params = []) {
  if (client === 'postgres') {
    const result = await postgres().query(dialect.toPostgres(sql), params);
    return result.rows;
  }
  return statement(sql).all(...params);
}

async function run(sql, params = []) {
  if (client === 'postgres') {
    const result = await postgres().query(dialect.toPostgres(sql), params);
    const first = result.rows[0];
    return { changes: result.rowCount, lastInsertRowid: first ? first.id : undefined };
  }
  const info = statement(sql).run(...params);
  return { changes: info.changes, lastInsertRowid: info.lastInsertRowid };
}

async function insert(sql, params = []) {
  if (client === 'postgres') {
    const text = /returning/i.test(sql) ? dialect.toPostgres(sql) : dialect.toPostgres(sql.replace(/\s*$/, '')) + ' RETURNING id';
    const result = await postgres().query(text, params);
    return result.rows[0] ? result.rows[0].id : undefined;
  }
  return statement(sql).run(...params).lastInsertRowid;
}

async function exec(sql) {
  if (client === 'postgres') {
    await postgres().query(sql);
    return;
  }
  sqlite().exec(sql);
}

async function ping() {
  if (client === 'postgres') {
    await postgres().query('SELECT 1');
    return true;
  }
  sqlite().prepare('SELECT 1').get();
  return true;
}

async function runMigrations() {
  if (client === 'postgres') return runPostgresMigrations();
  const { runSqliteMigrations } = require('./migrations');
  runSqliteMigrations(sqlite(), logger);
}

async function runPostgresMigrations() {
  const pool = postgres();
  await pool.query('CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const found = await pool.query("SELECT value FROM app_meta WHERE key = 'schema_version'");
  const current = found.rows[0] ? parseInt(found.rows[0].value, 10) : 0;

  if (current === 0) {
    logger.info(`Creating the Postgres schema (version ${SCHEMA_VERSION})`);
    const schema = fs.readFileSync(path.join(__dirname, 'schema.postgres.sql'), 'utf8');
    const connection = await pool.connect();
    try {
      await connection.query('BEGIN');
      await connection.query(schema);
      await connection.query(
        "INSERT INTO app_meta (key, value) VALUES ('schema_version', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        [String(SCHEMA_VERSION)]
      );
      await connection.query('COMMIT');
    } catch (err) {
      await connection.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      connection.release();
    }
    logger.info(`Database at schema version ${SCHEMA_VERSION}`);
    return;
  }

  if (current > SCHEMA_VERSION) {
    logger.warn(`Database schema version ${current} is newer than this build (${SCHEMA_VERSION})`);
  }
  logger.info(`Database at schema version ${current}`);
}

async function close() {
  if (pgPool) {
    await pgPool.end();
    pgPool = null;
  }
  if (sqliteHandle) {
    sqliteHandle.close();
    sqliteHandle = null;
    sqliteStatements.clear();
  }
}

const db = { client, get, all, run, insert, exec, ping, runMigrations, close, SCHEMA_VERSION };

module.exports = { db, runMigrations, close, client };
