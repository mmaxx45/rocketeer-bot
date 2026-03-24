const DEFAULT_BLOCKED_EXTENSIONS = [
  'exe', 'bat', 'cmd', 'msi', 'scr', 'pif', 'com', 'vbs', 'vbe',
  'js', 'jse', 'wsf', 'wsh', 'ps1', 'psm1', 'psd1', 'reg', 'inf',
  'hta', 'cpl', 'msp', 'mst', 'sct', 'ws', 'dll', 'sys', 'drv',
  'ocx', 'jar', 'apk', 'deb', 'rpm', 'dmg', 'iso', 'img', 'lnk',
  'url', 'desktop',
];

const IMAGE_CONTENT_TYPES = [
  'image/png', 'image/jpg', 'image/jpeg', 'image/gif', 'image/webp',
];

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp'];

const VIDEO_CONTENT_TYPES = [
  'video/mp4', 'video/webm', 'video/quicktime', 'video/x-msvideo', 'video/avi',
];

const VIDEO_EXTENSIONS = ['mp4', 'webm', 'mov', 'avi'];

const AUDIO_CONTENT_TYPES = [
  'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/flac', 'audio/aac', 'audio/mp4',
];

const AUDIO_EXTENSIONS = ['mp3', 'ogg', 'wav', 'flac', 'aac', 'm4a'];

/** Map of dangerous MIME types to their corresponding file extensions for content-type blocking. */
const BLOCKED_MIME_TO_EXTENSION = {
  'application/x-msdownload': 'exe',
  'application/x-msdos-program': 'exe',
  'application/x-dosexec': 'exe',
  'application/x-bat': 'bat',
  'application/x-msi': 'msi',
  'application/x-ms-shortcut': 'lnk',
  'application/x-java-archive': 'jar',
  'application/vnd.android.package-archive': 'apk',
  'application/x-apple-diskimage': 'dmg',
  'application/x-iso9660-image': 'iso',
  'application/x-debian-package': 'deb',
  'application/x-rpm': 'rpm',
};

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

/**
 * Checks if a filename has a blocked MIME type based on contentType.
 * This supplements extension-based checking for cases where the extension
 * doesn't match or is absent.
 */
function isBlockedByContentType(contentType, blockedExtensions) {
  if (!contentType || !blockedExtensions) return null;

  const lower = contentType.toLowerCase();
  const mappedExt = BLOCKED_MIME_TO_EXTENSION[lower];
  if (mappedExt && blockedExtensions.includes(mappedExt)) {
    return mappedExt;
  }

  return null;
}

/**
 * Gets the file extension from a filename (lowercase, no dot).
 */
function getFileExtension(filename) {
  if (!filename) return null;
  const parts = filename.toLowerCase().split('.');
  return parts.length >= 2 ? parts[parts.length - 1] : null;
}

/**
 * Checks if a Discord attachment is an image.
 * Checks both contentType (MIME) and file extension for reliability.
 */
function isImageAttachment(attachment) {
  if (!attachment) return false;

  // Check contentType first (most reliable)
  if (attachment.contentType) {
    const ct = attachment.contentType.toLowerCase().split(';')[0].trim();
    if (IMAGE_CONTENT_TYPES.includes(ct)) return true;
  }

  // Fall back to extension check
  const ext = getFileExtension(attachment.name);
  if (ext && IMAGE_EXTENSIONS.includes(ext)) return true;

  return false;
}

/**
 * Checks if a Discord attachment is a video.
 * Checks both contentType (MIME) and file extension.
 */
function isVideoAttachment(attachment) {
  if (!attachment) return false;

  // Check contentType first
  if (attachment.contentType) {
    const ct = attachment.contentType.toLowerCase().split(';')[0].trim();
    if (VIDEO_CONTENT_TYPES.includes(ct)) return true;
  }

  // Fall back to extension check
  const ext = getFileExtension(attachment.name);
  if (ext && VIDEO_EXTENSIONS.includes(ext)) return true;

  return false;
}

/**
 * Checks if a Discord attachment is audio.
 * Checks both contentType (MIME) and file extension.
 */
function isAudioAttachment(attachment) {
  if (!attachment) return false;

  if (attachment.contentType) {
    const ct = attachment.contentType.toLowerCase().split(';')[0].trim();
    if (AUDIO_CONTENT_TYPES.includes(ct)) return true;
  }

  const ext = getFileExtension(attachment.name);
  if (ext && AUDIO_EXTENSIONS.includes(ext)) return true;

  return false;
}

/**
 * Returns the media type of a Discord attachment.
 * @returns {'image' | 'video' | 'audio' | 'other'}
 */
function getMediaType(attachment) {
  if (isImageAttachment(attachment)) return 'image';
  if (isVideoAttachment(attachment)) return 'video';
  if (isAudioAttachment(attachment)) return 'audio';
  return 'other';
}

/**
 * Checks if a message has any image or video attachments.
 */
function hasMediaAttachments(attachments) {
  if (!attachments || attachments.size === 0) return false;
  for (const [, attachment] of attachments) {
    if (isImageAttachment(attachment) || isVideoAttachment(attachment)) {
      return true;
    }
  }
  return false;
}

module.exports = {
  DEFAULT_BLOCKED_EXTENSIONS,
  IMAGE_CONTENT_TYPES,
  IMAGE_EXTENSIONS,
  VIDEO_CONTENT_TYPES,
  VIDEO_EXTENSIONS,
  AUDIO_CONTENT_TYPES,
  AUDIO_EXTENSIONS,
  BLOCKED_MIME_TO_EXTENSION,
  getBlockedExtensions,
  isBlockedFile,
  isBlockedByContentType,
  getFileExtension,
  isImageAttachment,
  isVideoAttachment,
  isAudioAttachment,
  getMediaType,
  hasMediaAttachments,
};
