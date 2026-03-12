const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000; // 28 days (Discord max)

const UNITS = {
  s: 1000,
  sec: 1000,
  second: 1000,
  seconds: 1000,
  m: 60 * 1000,
  min: 60 * 1000,
  minute: 60 * 1000,
  minutes: 60 * 1000,
  h: 60 * 60 * 1000,
  hr: 60 * 60 * 1000,
  hour: 60 * 60 * 1000,
  hours: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  days: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  weeks: 7 * 24 * 60 * 60 * 1000,
  mo: 28 * 24 * 60 * 60 * 1000,
  month: 28 * 24 * 60 * 60 * 1000,
  months: 28 * 24 * 60 * 60 * 1000,
};

/**
 * Parse a human-readable duration string into milliseconds.
 * Supports: 30s, 5m, 1h, 2d, 1w, 1mo/1month
 * Also supports bare numbers (treated as minutes for backward compat).
 * Returns null if invalid, or if duration exceeds 28 days.
 */
function parseDuration(input) {
  if (!input) return null;
  const str = input.trim().toLowerCase();

  // Bare number → treat as minutes
  if (/^\d+$/.test(str)) {
    const ms = parseInt(str, 10) * 60 * 1000;
    if (ms <= 0 || ms > MAX_TIMEOUT_MS) return null;
    return ms;
  }

  const match = str.match(/^(\d+(?:\.\d+)?)\s*(s|sec|seconds?|m|min|minutes?|h|hr|hours?|d|days?|w|weeks?|mo|months?)$/);
  if (!match) return null;

  const value = parseFloat(match[1]);
  const unit = match[2];
  const multiplier = UNITS[unit];
  if (!multiplier) return null;

  const ms = Math.round(value * multiplier);
  if (ms <= 0 || ms > MAX_TIMEOUT_MS) return null;

  return ms;
}

/**
 * Format milliseconds into a human-readable duration string.
 */
function formatDuration(ms) {
  if (ms >= 7 * 24 * 60 * 60 * 1000) {
    const weeks = Math.round(ms / (7 * 24 * 60 * 60 * 1000) * 10) / 10;
    return weeks === 1 ? '1 week' : `${weeks} weeks`;
  }
  if (ms >= 24 * 60 * 60 * 1000) {
    const days = Math.round(ms / (24 * 60 * 60 * 1000) * 10) / 10;
    return days === 1 ? '1 day' : `${days} days`;
  }
  if (ms >= 60 * 60 * 1000) {
    const hours = Math.round(ms / (60 * 60 * 1000) * 10) / 10;
    return hours === 1 ? '1 hour' : `${hours} hours`;
  }
  if (ms >= 60 * 1000) {
    const mins = Math.round(ms / (60 * 1000) * 10) / 10;
    return mins === 1 ? '1 minute' : `${mins} minutes`;
  }
  const secs = Math.round(ms / 1000);
  return secs === 1 ? '1 second' : `${secs} seconds`;
}

module.exports = { parseDuration, formatDuration };
