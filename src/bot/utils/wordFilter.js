/**
 * Word filter utility with bypass detection.
 *
 * Normalizes text to defeat common evasion techniques:
 *  - Zero-width characters and Unicode control chars
 *  - L33t speak substitutions (0->o, 1->i/l, 3->e, etc.)
 *  - Spaces/special chars inserted between letters
 *  - Unicode homoglyphs (Cyrillic, Greek look-alikes)
 *  - Repeated characters collapsed
 */

// Zero-width and invisible Unicode characters to strip
const ZERO_WIDTH_RE = /[\u200B\u200C\u200D\u200E\u200F\uFEFF\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u2000-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F]/g;

// L33t speak mapping (character -> possible replacements)
const LEET_MAP = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '8': 'b',
  '9': 'g',
  '@': 'a',
  '$': 's',
  '!': 'i',
  '|': 'i',
  '+': 't',
  '(': 'c',
  '<': 'c',
  '{': 'c',
  '^': 'a',
};

// Unicode homoglyph mapping (look-alike characters -> ASCII equivalent)
const HOMOGLYPH_MAP = {
  // Cyrillic
  '\u0410': 'a', '\u0430': 'a', // А а
  '\u0412': 'b', '\u0432': 'b', // В в
  '\u0421': 'c', '\u0441': 'c', // С с
  '\u0415': 'e', '\u0435': 'e', // Е е
  '\u041D': 'h', '\u043D': 'h', // Н н
  '\u041A': 'k', '\u043A': 'k', // К к
  '\u041C': 'm', '\u043C': 'm', // М м
  '\u041E': 'o', '\u043E': 'o', // О о
  '\u0420': 'p', '\u0440': 'p', // Р р
  '\u0422': 't', '\u0442': 't', // Т т
  '\u0425': 'x', '\u0445': 'x', // Х х
  '\u0423': 'y', '\u0443': 'y', // У у
  // Greek
  '\u0391': 'a', '\u03B1': 'a', // Α α
  '\u0392': 'b', '\u03B2': 'b', // Β β
  '\u0395': 'e', '\u03B5': 'e', // Ε ε
  '\u0397': 'h', '\u03B7': 'h', // Η η
  '\u0399': 'i', '\u03B9': 'i', // Ι ι
  '\u039A': 'k', '\u03BA': 'k', // Κ κ
  '\u039C': 'm',                 // Μ
  '\u039D': 'n',                 // Ν
  '\u039F': 'o', '\u03BF': 'o', // Ο ο
  '\u03A1': 'p', '\u03C1': 'p', // Ρ ρ
  '\u03A4': 't', '\u03C4': 't', // Τ τ
  '\u03A5': 'y', '\u03C5': 'y', // Υ υ
  '\u03A7': 'x', '\u03C7': 'x', // Χ χ
  // Common symbols
  '\u00D8': 'o', '\u00F8': 'o', // Ø ø
  '\u00C6': 'ae', '\u00E6': 'ae', // Æ æ
};

/**
 * Normalize text to defeat evasion.
 * Returns a lowercase ASCII-ish string with all tricks stripped.
 */
function normalizeForFilter(text) {
  if (!text) return '';

  let result = text;

  // 1. Remove zero-width / invisible characters
  result = result.replace(ZERO_WIDTH_RE, '');

  // 2. Lowercase
  result = result.toLowerCase();

  // 3. Replace homoglyphs
  let normalized = '';
  for (const ch of result) {
    if (HOMOGLYPH_MAP[ch]) {
      normalized += HOMOGLYPH_MAP[ch];
    } else {
      normalized += ch;
    }
  }
  result = normalized;

  // 4. Replace leet speak characters
  normalized = '';
  for (const ch of result) {
    if (LEET_MAP[ch]) {
      normalized += LEET_MAP[ch];
    } else {
      normalized += ch;
    }
  }
  result = normalized;

  // 5. Strip all non-alphanumeric characters (collapses spaces, punctuation, etc.)
  result = result.replace(/[^a-z0-9]/g, '');

  // 6. Collapse repeated characters (e.g. "niiiiggger" -> "niger" which will match "nigger" pattern)
  // We keep at most 2 of the same consecutive character to allow legitimate doubles
  result = result.replace(/(.)\1{2,}/g, '$1$1');

  return result;
}

/**
 * Check message content against a list of filter words.
 * Whitelisted words cause matches to be skipped when the filter word
 * appears only as part of a whitelisted word in the original content.
 *
 * @param {string} content - The raw message content
 * @param {Array<{word: string, tier: string}>} filterWords - Words to check against
 * @param {Array<{word: string}>} [whitelist] - Whitelisted words to skip
 * @returns {Array<{word: string, tier: string}>} - Matches found, ordered by severity (hard first)
 */
function checkMessage(content, filterWords, whitelist) {
  if (!content || !filterWords || filterWords.length === 0) return [];

  const normalizedContent = normalizeForFilter(content);
  if (!normalizedContent) return [];

  // Build set of normalized whitelist words
  const whitelistNormalized = (whitelist || []).map(w => normalizeForFilter(w.word || w)).filter(Boolean);

  const matches = [];
  const tierOrder = { hard: 0, soft: 1, auto_delete: 2 };

  for (const entry of filterWords) {
    const normalizedWord = normalizeForFilter(entry.word);
    if (!normalizedWord) continue;

    if (!normalizedContent.includes(normalizedWord)) continue;

    // Check if this match is a false positive due to a whitelisted word
    // e.g. "esp" inside "respawn" — if "respawn" is whitelisted, skip
    let isWhitelisted = false;
    for (const wl of whitelistNormalized) {
      if (wl.includes(normalizedWord) && normalizedContent.includes(wl)) {
        // The filter word appears inside a whitelisted word that's in the content
        // Check if the filter word ONLY appears as part of whitelisted words
        let remaining = normalizedContent;
        // Remove all occurrences of the whitelisted word
        while (remaining.includes(wl)) {
          remaining = remaining.replace(wl, ' '.repeat(wl.length));
        }
        // If the filter word no longer appears, it was only inside whitelisted words
        if (!remaining.includes(normalizedWord)) {
          isWhitelisted = true;
          break;
        }
      }
    }

    if (!isWhitelisted) {
      matches.push({ word: entry.word, tier: entry.tier });
    }
  }

  // Sort by severity: hard > soft > auto_delete
  matches.sort((a, b) => (tierOrder[a.tier] || 99) - (tierOrder[b.tier] || 99));

  return matches;
}

module.exports = {
  normalizeForFilter,
  checkMessage,
};
