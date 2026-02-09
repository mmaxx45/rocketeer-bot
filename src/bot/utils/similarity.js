const { distance } = require('fastest-levenshtein');

function normalizeMessage(content) {
  if (!content) return '';
  return content
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, '')     // remove code blocks
    .replace(/`[^`]+`/g, '')            // remove inline code
    .replace(/\*\*([^*]+)\*\*/g, '$1')  // remove bold
    .replace(/\*([^*]+)\*/g, '$1')      // remove italic
    .replace(/__([^_]+)__/g, '$1')      // remove underline
    .replace(/~~([^~]+)~~/g, '$1')      // remove strikethrough
    .replace(/https?:\/\/\S+/g, '')     // remove URLs
    .replace(/<@!?\d+>/g, '')           // remove user mentions
    .replace(/<#\d+>/g, '')             // remove channel mentions
    .replace(/<@&\d+>/g, '')            // remove role mentions
    .replace(/<a?:\w+:\d+>/g, '')       // remove custom emoji
    .replace(/\s+/g, ' ')              // collapse whitespace
    .trim();
}

function getSimilarity(str1, str2) {
  const a = normalizeMessage(str1);
  const b = normalizeMessage(str2);

  if (!a || !b) return 0;
  if (a === b) return 100;

  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 0;

  const dist = distance(a, b);
  return ((1 - dist / maxLen) * 100);
}

function isAboveThreshold(str1, str2, threshold = 80) {
  return getSimilarity(str1, str2) >= threshold;
}

const MIN_MESSAGE_LENGTH = 10;

module.exports = { getSimilarity, normalizeMessage, isAboveThreshold, MIN_MESSAGE_LENGTH };
