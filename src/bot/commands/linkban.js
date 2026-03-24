const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { getSettings, getBannedDomains, addBannedDomain, removeBannedDomain } = require('../../database/settings');
const { isModerator } = require('../utils/permissions');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('linkban')
    .setDescription('Manage the banned domain list for automatic link deletion')
    .addSubcommand(sub =>
      sub.setName('add')
        .setDescription('Add a domain to the ban list')
        .addStringOption(opt =>
          opt.setName('domain').setDescription('The domain to ban (e.g. badsite.com)').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('remove')
        .setDescription('Remove a domain from the ban list')
        .addStringOption(opt =>
          opt.setName('domain').setDescription('The domain to unban').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('list')
        .setDescription('Show all banned domains')
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  async execute(interaction) {
    const settings = getSettings(interaction.guild.id);

    if (!isModerator(interaction.member, settings)) {
      return interaction.reply({ content: 'You do not have permission to use this command.', flags: MessageFlags.Ephemeral });
    }

    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'add') {
      const domain = interaction.options.getString('domain').toLowerCase().trim()
        .replace(/^https?:\/\//, '')  // Strip protocol if provided
        .replace(/\/.*$/, '')          // Strip path if provided
        .replace(/^www\./, '');        // Strip www. prefix for cleaner storage

      if (!domain || domain.length < 3 || !domain.includes('.')) {
        return interaction.reply({ content: 'Please provide a valid domain (e.g. `badsite.com`).', flags: MessageFlags.Ephemeral });
      }

      const domains = addBannedDomain(interaction.guild.id, domain);
      return interaction.reply({
        content: `Domain \`${domain}\` has been added to the ban list. Messages containing links to this domain (including subdomains) will be automatically deleted.\n\n**Current banned domains (${domains.length}):** ${domains.map(d => `\`${d}\``).join(', ')}`,
        flags: MessageFlags.Ephemeral,
      });
    }

    if (subcommand === 'remove') {
      const domain = interaction.options.getString('domain').toLowerCase().trim()
        .replace(/^https?:\/\//, '')
        .replace(/\/.*$/, '')
        .replace(/^www\./, '');

      const existingDomains = getBannedDomains(interaction.guild.id);
      if (!existingDomains.includes(domain)) {
        return interaction.reply({
          content: `Domain \`${domain}\` is not in the ban list.\n\n**Current banned domains (${existingDomains.length}):** ${existingDomains.length > 0 ? existingDomains.map(d => `\`${d}\``).join(', ') : '*None*'}`,
          flags: MessageFlags.Ephemeral,
        });
      }

      const domains = removeBannedDomain(interaction.guild.id, domain);
      return interaction.reply({
        content: `Domain \`${domain}\` has been removed from the ban list.\n\n**Current banned domains (${domains.length}):** ${domains.length > 0 ? domains.map(d => `\`${d}\``).join(', ') : '*None*'}`,
        flags: MessageFlags.Ephemeral,
      });
    }

    if (subcommand === 'list') {
      const domains = getBannedDomains(interaction.guild.id);

      if (domains.length === 0) {
        return interaction.reply({
          content: 'No domains are currently banned. Use `/linkban add <domain>` to add one.',
          flags: MessageFlags.Ephemeral,
        });
      }

      const domainList = domains.map((d, i) => `${i + 1}. \`${d}\``).join('\n');
      return interaction.reply({
        content: `**Banned Domains (${domains.length}):**\n${domainList}\n\nMessages containing links to these domains (including subdomains) will be automatically deleted. Moderators are exempt.`,
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
