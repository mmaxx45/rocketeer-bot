'use strict';

const UTC_NOW = "to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')";
const UTC_NOW_FORMAT = "'YYYY-MM-DD HH24:MI:SS'";

function translateDatetime(sql) {
  return sql.replace(/datetime\(\s*'now'\s*(?:,\s*([^)]*?))?\s*\)/gi, (match, modifier) => {
    if (!modifier) return UTC_NOW;
    const expression = modifier.trim();
    const literal = expression.match(/^'([+-]?)\s*([^']*)'$/);
    if (literal) {
      const sign = literal[1] === '-' ? '-' : '+';
      return `to_char(now() AT TIME ZONE 'UTC' ${sign} interval '${literal[2]}', ${UTC_NOW_FORMAT})`;
    }
    const concat = expression.match(/^'([+-])'\s*\|\|\s*([\s\S]+)$/);
    if (concat) {
      const sign = concat[1] === '-' ? '-' : '+';
      return `to_char(now() AT TIME ZONE 'UTC' ${sign} (${concat[2]})::interval, ${UTC_NOW_FORMAT})`;
    }
    return `to_char(now() AT TIME ZONE 'UTC' ${expression}, ${UTC_NOW_FORMAT})`;
  });
}

function translateStrftime(sql) {
  return sql.replace(/strftime\(\s*'([^']*)'\s*,\s*([^)]+?)\)/gi, (match, format, column) => {
    const postgresFormat = format
      .replace(/%Y/g, 'YYYY')
      .replace(/%m/g, 'MM')
      .replace(/%d/g, 'DD')
      .replace(/%H/g, 'HH24')
      .replace(/%M/g, 'MI')
      .replace(/%S/g, 'SS');
    return `to_char(${column.trim()}, '${postgresFormat}')`;
  });
}

function translateInsertOrIgnore(sql) {
  if (!/^\s*insert\s+or\s+ignore\s+into/i.test(sql)) return sql;
  const rewritten = sql.replace(/^\s*insert\s+or\s+ignore\s+into/i, 'INSERT INTO');
  if (/on\s+conflict/i.test(rewritten)) return rewritten;
  return rewritten.replace(/\s*$/, '') + ' ON CONFLICT DO NOTHING';
}

function translateInsertOrReplace(sql) {
  return sql.replace(/^\s*insert\s+or\s+replace\s+into/i, 'INSERT INTO');
}

function numberPlaceholders(sql) {
  let index = 0;
  let result = '';
  let quote = null;
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];
    if (quote) {
      result += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      result += char;
      continue;
    }
    if (char === '?') {
      index += 1;
      result += '$' + index;
      continue;
    }
    result += char;
  }
  return result;
}

function translateLooseLike(sql) {
  return sql.replace(/\bLIKE\b/g, 'ILIKE');
}

function toPostgres(sql) {
  let out = translateInsertOrReplace(sql);
  out = translateInsertOrIgnore(out);
  out = translateDatetime(out);
  out = translateStrftime(out);
  out = translateLooseLike(out);
  return numberPlaceholders(out);
}

const SQLITE_ISMS = [
  { name: "datetime('now'", test: sql => /datetime\(/i.test(sql) },
  { name: 'INSERT OR IGNORE/REPLACE', test: sql => /insert\s+or\s+(ignore|replace)/i.test(sql) },
  { name: 'AUTOINCREMENT', test: sql => /autoincrement/i.test(sql) },
  { name: 'strftime(', test: sql => /strftime\(/i.test(sql) },
  { name: 'PRAGMA', test: sql => /pragma/i.test(sql) },
  { name: 'sqlite_master', test: sql => /sqlite_master/i.test(sql) },
  { name: 'last_insert_rowid', test: sql => /last_insert_rowid/i.test(sql) },
];

function findSqliteIsms(sql) {
  return SQLITE_ISMS.filter(ism => ism.test(sql)).map(ism => ism.name);
}

module.exports = { toPostgres, findSqliteIsms, numberPlaceholders };
