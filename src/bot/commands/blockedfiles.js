const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { getSettings } = require('../../database/settings');
const { isModerator } = require('../utils/permissions');
const { getBlockedExtensions, DEFAULT_BLOCKED_EXTENSIONS } = require('../utils/fileFilter');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('blockedfiles')
    .setDescription('Show the current list of blocked file extensions')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  async execute(interaction) {
    const settings = getSettings(interaction.guild.id);

    if (!isModerator(interaction.member, settings)) {
      return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
    }

    const enabled = settings.file_block_enabled;
    const extensions = getBlockedExtensions(settings);
    const isCustom = settings.blocked_extensions !== null && settings.blocked_extensions !== undefined;

    const extList = extensions.map(ext => `.${ext}`).join(', ');

    let content = `**File Upload Blocking:** ${enabled ? 'Enabled' : 'Disabled'}\n`;
    content += `**Extension list:** ${isCustom ? 'Custom' : 'Default'}\n\n`;
    content += `\`\`\`\n${extList}\n\`\`\``;

    return interaction.reply({ content, ephemeral: true });
  },
};
