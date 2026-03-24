/**
 * Extracts URLs from message content and checks if any match banned domains.
 * Supports subdomain matching — if "badsite.com" is banned, "www.badsite.com"
 * and "sub.badsite.com" will also match.
 */

const URL_REGEX = /https?:\/\/([^\s<>)"']+)/gi;

/**
 * Parse the banned_domains JSON string from settings into an array.
 * Returns an empty array if null/invalid.
 */
function parseBannedDomains(bannedDomainsJson) {
  if (!bannedDomainsJson) return [];
  try {
    const domains = JSON.parse(bannedDomainsJson);
    if (Array.isArray(domains)) {
      return domains.map(d => d.toLowerCase().trim()).filter(Boolean);
    }
  } catch {
    // Invalid JSON
  }
  return [];
}

/**
 * Extract the hostname from a URL string.
 * Returns null if the URL cannot be parsed.
 */
function extractHostname(urlString) {
  try {
    const url = new URL(urlString);
    return url.hostname.toLowerCase();
  } catch {
    // Try adding protocol if missing
    try {
      const url = new URL('https://' + urlString);
      return url.hostname.toLowerCase();
    } catch {
      return null;
    }
  }
}

/**
 * Check if a hostname matches a banned domain (including subdomains).
 * For example, if "badsite.com" is banned:
 *   - "badsite.com" matches
 *   - "www.badsite.com" matches
 *   - "sub.badsite.com" matches
 *   - "notbadsite.com" does NOT match
 */
function domainMatches(hostname, bannedDomain) {
  if (hostname === bannedDomain) return true;
  if (hostname.endsWith('.' + bannedDomain)) return true;
  return false;
}

/**
 * Check message content for banned domain links.
 * Returns the first matched banned domain, or null if none found.
 */
function checkForBannedLinks(content, bannedDomains) {
  if (!content || !bannedDomains || bannedDomains.length === 0) return null;

  const matches = content.matchAll(URL_REGEX);
  for (const match of matches) {
    const fullUrl = match[0];
    const hostname = extractHostname(fullUrl);
    if (!hostname) continue;

    for (const banned of bannedDomains) {
      if (domainMatches(hostname, banned)) {
        return banned;
      }
    }
  }

  return null;
}

module.exports = { parseBannedDomains, checkForBannedLinks, extractHostname, domainMatches };
