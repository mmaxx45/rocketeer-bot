const { PermissionFlagsBits } = require('discord.js');

function isExempt(member, settings) {
  if (!member) return false;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  if (!settings) return false;

  // Exempt if at or above moderator role
  if (settings.moderator_role_id) {
    const modRole = member.guild.roles.cache.get(settings.moderator_role_id);
    if (modRole && member.roles.cache.some(role => role.position >= modRole.position)) {
      return true;
    }
  }

  // Exempt if they have the warn role (trial mods are staff too)
  if (settings.warn_role_id) {
    if (member.roles.cache.has(settings.warn_role_id)) return true;
  }

  return false;
}

function isModerator(member, settings) {
  if (!member) return false;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  if (!settings || !settings.moderator_role_id) {
    return member.permissions.has(PermissionFlagsBits.ModerateMembers);
  }

  const modRole = member.guild.roles.cache.get(settings.moderator_role_id);
  if (!modRole) return member.permissions.has(PermissionFlagsBits.ModerateMembers);

  return member.roles.cache.some(role => role.position >= modRole.position);
}

function canWarn(member, settings) {
  if (!member) return false;
  // Full moderators can always warn
  if (isModerator(member, settings)) return true;
  // Warn role holders (trial mods) can warn
  if (settings && settings.warn_role_id) {
    return member.roles.cache.has(settings.warn_role_id);
  }
  return false;
}

module.exports = { isExempt, isModerator, canWarn };
