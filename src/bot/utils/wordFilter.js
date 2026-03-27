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
  'l': 'i',
  'j': 'i',
  'q': 'g',
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

  // 2.5. Strip diacritics (é→e, ï→i, ñ→n, etc.)
  result = result.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

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

  // 5. Convert fullwidth Latin characters to ASCII (Ｎ→n, ａ→a, etc.)
  normalized = '';
  for (const ch of result) {
    const code = ch.charCodeAt(0);
    // Fullwidth a-z: 0xFF41-0xFF5A → 0x61-0x7A
    // Fullwidth A-Z: 0xFF21-0xFF3A → 0x41-0x5A (already lowercased above)
    // Fullwidth 0-9: 0xFF10-0xFF19 → 0x30-0x39
    if (code >= 0xFF41 && code <= 0xFF5A) {
      normalized += String.fromCharCode(code - 0xFF41 + 0x61);
    } else if (code >= 0xFF21 && code <= 0xFF3A) {
      normalized += String.fromCharCode(code - 0xFF21 + 0x61);
    } else if (code >= 0xFF10 && code <= 0xFF19) {
      normalized += String.fromCharCode(code - 0xFF10 + 0x30);
    } else {
      normalized += ch;
    }
  }
  result = normalized;

  // 6. Strip all non-alphanumeric characters (collapses spaces, punctuation, etc.)
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

  // Split into words and normalize individually for word-boundary awareness
  const originalWords = content.split(/\s+/).filter(Boolean);
  const normalizedWords = originalWords.map(w => {
    const clean = w.replace(/[^a-zA-Z0-9\u00C0-\u024F\u0400-\u04FF\u0370-\u03FF]/g, '');
    return normalizeForFilter(clean);
  });

  // Build concatenated string with word boundary tracking
  const wordStarts = [];
  let concat = '';
  for (const nw of normalizedWords) {
    wordStarts.push(concat.length);
    concat += nw;
  }
  wordStarts.push(concat.length); // sentinel

  if (!concat) return [];

  // Build set of normalized whitelist words
  const whitelistNormalized = (whitelist || []).map(w => normalizeForFilter(w.word || w)).filter(Boolean);

  const matches = [];
  const tierOrder = { hard: 0, soft: 1, auto_delete: 2 };

  for (const entry of filterWords) {
    const normalizedWord = normalizeForFilter(entry.word);
    if (!normalizedWord) continue;

    // Check 1: Does the filter word appear in any individual word?
    let foundInWord = normalizedWords.some(nw => nw.includes(normalizedWord));

    // Check 2: If not found in individual words, check concatenated string
    // but only match across word boundaries if the spanned words are short
    // (likely a bypass attempt like "n i g g e r"), not real words like "thing as"
    if (!foundInWord && concat.includes(normalizedWord)) {
      const idx = concat.indexOf(normalizedWord);
      const matchEnd = idx + normalizedWord.length;

      // Find which original words the match spans
      const spannedWordLengths = [];
      for (let i = 0; i < normalizedWords.length; i++) {
        const wStart = wordStarts[i];
        const wEnd = wordStarts[i + 1];
        if (wEnd > idx && wStart < matchEnd) {
          spannedWordLengths.push(originalWords[i].replace(/[^a-zA-Z0-9]/g, '').length);
        }
      }

      if (spannedWordLengths.length <= 1) {
        // Within a single word — real match
        foundInWord = true;
      } else {
        // Spans multiple words — likely a bypass if the filter word is longer
        // than every individual spanned word (fragments of the full slur).
        // e.g. "nig ger" → filter "nigger"(6) > "nig"(3) and "ger"(3) → bypass
        // e.g. "thing as" → filter "nga"(3) < "thing"(5) → not bypass
        const filterLen = normalizedWord.length;
        const allShorter = spannedWordLengths.every(len => len < filterLen);
        if (allShorter) foundInWord = true;
      }
    }

    if (!foundInWord) continue;

    // Check if this match is a false positive due to a whitelisted word
    // e.g. "esp" inside "respawn" — if "respawn" is whitelisted, skip
    let isWhitelisted = false;
    for (const wl of whitelistNormalized) {
      if (wl.includes(normalizedWord) && concat.includes(wl)) {
        // The filter word appears inside a whitelisted word that's in the content
        // Check if the filter word ONLY appears as part of whitelisted words
        let remaining = concat;
        while (remaining.includes(wl)) {
          remaining = remaining.replace(wl, ' '.repeat(wl.length));
        }
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
  matches.sort((a, b) => (tierOrder[a.tier] ?? 99) - (tierOrder[b.tier] ?? 99));

  return matches;
}

module.exports = {
  normalizeForFilter,
  checkMessage,
};
