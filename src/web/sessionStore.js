const session = require('express-session');
const { db } = require('../database/db');
const logger = require('../logger');

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 15 * 60 * 1000;

// express-session store backed by the bot's database (SQLite or Postgres), so
// dashboard logins survive restarts and updates. express-session's default
// MemoryStore leaks memory and is not meant for production.
class DatabaseSessionStore extends session.Store {
  constructor({ ttlMs = DEFAULT_TTL_MS } = {}) {
    super();
    this.ttlMs = ttlMs;
    this.pruneTimer = setInterval(() => {
      this.prune().catch(err => logger.warn(`Failed to prune expired dashboard sessions: ${err.message}`));
    }, PRUNE_INTERVAL_MS);
    this.pruneTimer.unref();
  }

  expiresAt(sess) {
    const expires = sess && sess.cookie && sess.cookie.expires;
    return expires ? new Date(expires).getTime() : Date.now() + this.ttlMs;
  }

  // express-session calls back exactly once; keep callback errors (thrown by
  // the caller's code) out of the promise chain so they are not reported twice.
  settle(promise, callback, map = value => value) {
    promise.then(
      value => callback && process.nextTick(callback, null, map(value)),
      err => callback && process.nextTick(callback, err)
    );
  }

  get(sid, callback) {
    this.settle(db.get(`SELECT sess, expires_at FROM web_sessions WHERE sid = ?`, [sid]), callback, row => {
      if (!row || Number(row.expires_at) <= Date.now()) return null;
      try {
        return JSON.parse(row.sess);
      } catch {
        return null;
      }
    });
  }

  set(sid, sess, callback) {
    this.settle(db.run(
      `INSERT INTO web_sessions (sid, sess, expires_at) VALUES (?, ?, ?)
       ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires_at = excluded.expires_at`,
      [sid, JSON.stringify(sess), this.expiresAt(sess)]
    ), callback, () => undefined);
  }

  touch(sid, sess, callback) {
    this.settle(db.run(`UPDATE web_sessions SET expires_at = ? WHERE sid = ?`, [this.expiresAt(sess), sid]), callback, () => undefined);
  }

  destroy(sid, callback) {
    this.settle(db.run(`DELETE FROM web_sessions WHERE sid = ?`, [sid]), callback, () => undefined);
  }

  prune() {
    return db.run(`DELETE FROM web_sessions WHERE expires_at <= ?`, [Date.now()]);
  }
}

module.exports = { DatabaseSessionStore };
