#!/usr/bin/env node
'use strict';

// Copies an existing SQLite database into Postgres.
//
//   npm run db:sqlite-to-postgres -- [--sqlite <file>] [--force]
//
// The Postgres connection comes from .env (DATABASE_URL or PG*), the SQLite
// file from --sqlite or DATABASE_PATH. The SQLite database is first brought
// up to the current schema version, the Postgres schema is created if needed,
// and every table is copied in one transaction, keeping row ids. The target
// tables must be empty unless --force is given, which empties them first.
// Stop the bot before running this.

const path = require('path');

process.env.DATABASE_CLIENT = 'postgres';
const config = require('../src/config');
const logger = require('../src/logger');
const { db } = require('../src/database/db');

const BATCH_SIZE = 500;

function parseArgs(argv) {
  const args = { sqlite: null, force: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--sqlite') args.sqlite = argv[++i];
    else if (argv[i] === '--force') args.force = true;
    else if (argv[i] === '-h' || argv[i] === '--help') args.help = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return args;
}

function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

// Parents before children, so foreign keys hold while rows are inserted.
function orderTables(tables, foreignKeys) {
  const ordered = [];
  const visiting = new Set();
  const done = new Set();
  const visit = table => {
    if (done.has(table)) return;
    if (visiting.has(table)) throw new Error(`foreign key cycle at ${table}`);
    visiting.add(table);
    for (const fk of foreignKeys.filter(f => f.table === table && f.refTable !== table)) {
      if (tables.includes(fk.refTable)) visit(fk.refTable);
    }
    visiting.delete(table);
    done.add(table);
    ordered.push(table);
  };
  tables.forEach(visit);
  return ordered;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write('Usage: npm run db:sqlite-to-postgres -- [--sqlite <file>] [--force]\n');
    return;
  }

  const sqlitePath = path.resolve(args.sqlite || config.database.path);
  const Database = require('better-sqlite3');
  const source = new Database(sqlitePath, { fileMustExist: true });
  const { runSqliteMigrations } = require('../src/database/migrations');
  runSqliteMigrations(source, logger);

  await db.runMigrations();

  const sourceTables = source.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all().map(r => r.name);
  const targetTables = (await db.all(`SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' AND table_name <> 'app_meta'`)).map(r => r.table_name);
  const foreignKeys = (await db.all(`
    SELECT kcu.table_name AS child, kcu.column_name AS col, ccu.table_name AS parent, ccu.column_name AS parent_col
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
    JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = current_schema()
  `)).map(r => ({ table: r.child, column: r.col, refTable: r.parent, refColumn: r.parent_col }));

  const missing = sourceTables.filter(t => !targetTables.includes(t));
  if (missing.length > 0) {
    logger.warn(`Skipping SQLite tables that do not exist in Postgres: ${missing.join(', ')}`);
  }
  const tables = orderTables(targetTables.filter(t => sourceTables.includes(t)), foreignKeys);

  const counts = {};
  await db.transaction(async tx => {
    for (const table of tables) {
      const { count } = await tx.get(`SELECT COUNT(*) AS count FROM ${quoteIdent(table)}`);
      if (count > 0 && !args.force) {
        throw new Error(`Postgres table ${table} already has ${count} row(s); re-run with --force to replace its contents`);
      }
    }
    if (args.force) {
      await tx.exec(`TRUNCATE ${tables.map(quoteIdent).join(', ')} RESTART IDENTITY CASCADE`);
    }

    const copiedIds = new Map();
    for (const table of tables) {
      const targetColumns = (await tx.all(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?`,
        [table]
      )).map(r => r.column_name);
      const sourceColumns = source.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all().map(c => c.name);
      const columns = sourceColumns.filter(c => targetColumns.includes(c));

      // Drop rows whose parent row does not exist (SQLite only enforces
      // foreign keys when the pragma is on, so old databases can have them).
      const parents = foreignKeys.filter(fk => fk.table === table && copiedIds.has(fk.refTable));
      let rows = source.prepare(`SELECT ${columns.map(quoteIdent).join(', ')} FROM ${quoteIdent(table)}`).all();
      const before = rows.length;
      rows = rows.filter(row => parents.every(fk => row[fk.column] === null || copiedIds.get(fk.refTable).has(row[fk.column])));
      if (rows.length < before) {
        logger.warn(`${table}: skipped ${before - rows.length} row(s) pointing at missing parent rows`);
      }

      for (let start = 0; start < rows.length; start += BATCH_SIZE) {
        const batch = rows.slice(start, start + BATCH_SIZE);
        const values = [];
        const tuples = batch.map(row => {
          const placeholders = columns.map(column => {
            values.push(row[column]);
            return '?';
          });
          return `(${placeholders.join(', ')})`;
        });
        await tx.run(
          `INSERT INTO ${quoteIdent(table)} (${columns.map(quoteIdent).join(', ')}) VALUES ${tuples.join(', ')}`,
          values
        );
      }

      if (columns.includes('id')) {
        copiedIds.set(table, new Set(rows.map(r => r.id)));
        // Rows were inserted with their ids, so move the identity past them.
        await tx.get(
          `SELECT setval(pg_get_serial_sequence(?, 'id'), COALESCE((SELECT MAX(id) FROM ${quoteIdent(table)}), 0) + 1, false)`,
          [table]
        );
      }
      counts[table] = rows.length;
    }
  });

  source.close();
  for (const table of tables) {
    process.stdout.write(`  ${table.padEnd(22)} ${counts[table]}\n`);
  }
  process.stdout.write(`Copied ${tables.length} table(s) from ${sqlitePath} to Postgres.\n`);
  process.stdout.write('Set DATABASE_CLIENT=postgres in .env (if it is not already) and start the bot.\n');
}

main()
  .catch(err => {
    process.stderr.write(`error: ${err.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => db.close());
