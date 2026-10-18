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
    // Any other modifier is an expression that evaluates to something like
    // '-7 days' (e.g. `? || ' days'` with a negative number bound): add it as
    // an interval, which handles both signs.
    return `to_char(now() AT TIME ZONE 'UTC' + (${expression})::interval, ${UTC_NOW_FORMAT})`;
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
    // Timestamps are stored as TEXT ('YYYY-MM-DD HH:MM:SS'), so cast first:
    // Postgres has no to_char(text, ...).
    return `to_char((${column.trim()})::timestamp, '${postgresFormat}')`;
  });
}

function translateInsertOrIgnore(sql) {
  if (!/^\s*insert\s+or\s+ignore\s+into/i.test(sql)) return sql;
  const rewritten = sql.replace(/^\s*insert\s+or\s+ignore\s+into/i, 'INSERT INTO');
  if (/on\s+conflict/i.test(rewritten)) return rewritten;
  return rewritten.replace(/\s*$/, '') + ' ON CONFLICT DO NOTHING';
}

// INSERT OR REPLACE has no direct equivalent: dropping the OR REPLACE would
// turn it into an INSERT that fails on conflict. Write the query as
// INSERT ... ON CONFLICT (...) DO UPDATE instead, which both backends accept.
function rejectInsertOrReplace(sql) {
  if (/^\s*insert\s+or\s+replace\s+into/i.test(sql)) {
    throw new Error('INSERT OR REPLACE is not portable; use INSERT ... ON CONFLICT (...) DO UPDATE');
  }
  return sql;
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

// SQLite's LIKE is case-insensitive, Postgres's is not.
function translateLooseLike(sql) {
  return sql.replace(/\bLIKE\b/gi, 'ILIKE');
}

function toPostgres(sql) {
  let out = rejectInsertOrReplace(sql);
  out = translateInsertOrIgnore(out);
  out = translateDatetime(out);
  out = translateStrftime(out);
  out = translateLooseLike(out);
  return numberPlaceholders(out);
}

module.exports = { toPostgres, numberPlaceholders };
