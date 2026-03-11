const DEFAULT_BLOCKED_EXTENSIONS = [
  'exe', 'bat', 'cmd', 'msi', 'scr', 'pif', 'com', 'vbs', 'vbe',
  'js', 'jse', 'wsf', 'wsh', 'ps1', 'psm1', 'psd1', 'reg', 'inf',
  'hta', 'cpl', 'msp', 'mst', 'sct', 'ws', 'dll', 'sys', 'drv',
  'ocx', 'jar', 'apk', 'deb', 'rpm', 'dmg', 'iso', 'img', 'lnk',
  'url', 'desktop',
];

/**
 * Returns the list of blocked extensions for a guild.
 * If the guild has custom blocked_extensions set, parse and return those.
 * Otherwise return the defaults.
 */
function getBlockedExtensions(settings) {
  if (settings && settings.blocked_extensions) {
    try {
      const custom = JSON.parse(settings.blocked_extensions);
      if (Array.isArray(custom) && custom.length > 0) {
        return custom.map(ext => ext.toLowerCase().replace(/^\./, ''));
      }
    } catch {
      // Invalid JSON, fall through to defaults
    }
  }
  return DEFAULT_BLOCKED_EXTENSIONS;
}

/**
 * Checks if a filename has a blocked extension.
 * Case-insensitive. Checks all extensions in the filename to catch
 * tricks like "malware.exe.jpg" (both .jpg and .exe are checked).
 */
function isBlockedFile(filename, blockedExtensions) {
  if (!filename || !blockedExtensions || blockedExtensions.length === 0) return null;

  const lower = filename.toLowerCase();
  // Split on dots to get all possible extensions
  const parts = lower.split('.');

  // Need at least a name and one extension
  if (parts.length < 2) return null;

  // Check each extension segment (skip the first part which is the filename)
  for (let i = 1; i < parts.length; i++) {
    const ext = parts[i];
    if (ext && blockedExtensions.includes(ext)) {
      return ext;
    }
  }

  return null;
}

module.exports = { DEFAULT_BLOCKED_EXTENSIONS, getBlockedExtensions, isBlockedFile };
