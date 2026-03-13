const { EmbedBuilder } = require('discord.js');
const { getSettings, getLicenseRequiredRoles } = require('../../database/settings');
const { addModAction } = require('../../database/modactions');
const config = require('../../config');
const logger = require('../../logger');

module.exports = {
  name: 'guildMemberUpdate',
  once: false,
  async execute(oldMember, newMember) {
    // Only care about role changes
    if (oldMember.roles.cache.size === newMember.roles.cache.size &&
        oldMember.roles.cache.every(r => newMember.roles.cache.has(r.id))) {
      return;
    }

    const guildId = newMember.guild.id;
    const requiredRoles = getLicenseRequiredRoles(guildId);
    if (requiredRoles.length === 0) return;

    // Check if user still has at least one required role
    const hasAnyRequired = requiredRoles.some(roleId => newMember.roles.cache.has(roleId));
    if (hasAnyRequired) return;

    // Check the user actually had at least one before (don't revoke on unrelated changes)
    const hadAnyBefore = requiredRoles.some(roleId => oldMember.roles.cache.has(roleId));
    if (!hadAnyBefore) return;

    const lostRoles = requiredRoles.filter(
      roleId => oldMember.roles.cache.has(roleId) && !newMember.roles.cache.has(roleId)
    );

    // User lost a required role — revoke their license
    if (!config.licensing.apiUrl || !config.licensing.apiKey) {
      logger.warn(`License revocation skipped for ${newMember.user.username}: licensing API not configured`);
      return;
    }

    try {
      // Look up the user's license
      const searchRes = await fetch(
        `${config.licensing.apiUrl}/api/v1/licenses?search=${encodeURIComponent(newMember.user.username)}`,
        { headers: { 'Authorization': `Bearer ${config.licensing.apiKey}` } }
      );

      if (!searchRes.ok) {
        logger.error(`License search API error during revocation: ${searchRes.status}`);
        return;
      }

      const searchData = await searchRes.json();
      const licenses = searchData.licenses || searchData.data || searchData;
      const list = Array.isArray(licenses) ? licenses : [];

      const activeLicense = list.find(l => l.status === 'active' || l.status === 'suspended');
      if (!activeLicense) {
        logger.debug(`No active license found for ${newMember.user.username}, skipping revocation`);
        return;
      }

      // Revoke the license via DELETE /api/v1/licenses/:id
      const revokeRes = await fetch(`${config.licensing.apiUrl}/api/v1/licenses/${activeLicense.id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${config.licensing.apiKey}` },
      });

      const revokeData = await revokeRes.json();

      const lostRoleNames = lostRoles
        .map(id => newMember.guild.roles.cache.get(id)?.name || id)
        .join(', ');

      if (revokeRes.ok) {
        logger.info(`License auto-revoked for ${newMember.user.username} (lost roles: ${lostRoleNames})`);
        addModAction(guildId, newMember.client.user.id, 'license_revoke', newMember.id, `Auto-revoked: lost role(s) ${lostRoleNames}`);
      } else {
        const errorMsg = revokeData.error || revokeData.message || 'Unknown error';
        logger.error(`License revocation API error for ${newMember.user.username}: ${errorMsg}`);
      }

      // Log to ticket log channel
      const settings = getSettings(guildId);
      if (settings.ticket_log_channel_id) {
        try {
          const logChannel = await newMember.guild.channels.fetch(settings.ticket_log_channel_id);
          if (logChannel) {
            const logEmbed = new EmbedBuilder()
              .setTitle('License Auto-Revoked')
              .setColor(0xE74C3C)
              .addFields(
                { name: 'User', value: `<@${newMember.id}> (${newMember.user.username})`, inline: true },
                { name: 'Lost Role(s)', value: lostRoleNames, inline: true },
                { name: 'Status', value: revokeRes.ok ? 'Revoked' : 'API Error', inline: true },
              )
              .setTimestamp();

            if (!revokeRes.ok) {
              const errorMsg = revokeData.error || revokeData.message || 'Unknown error';
              logEmbed.addFields({ name: 'Error', value: errorMsg });
            }

            await logChannel.send({ embeds: [logEmbed] });
          }
        } catch (err) {
          logger.warn(`Failed to log license revocation: ${err.message}`);
        }
      }
    } catch (err) {
      logger.error(`License revocation failed for ${newMember.user.username}: ${err.message}`);
    }
  },
};
