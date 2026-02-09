const { EmbedBuilder } = require('discord.js');

function buildWarningsEmbed(warnings, user, guild) {
  const displayName = user.tag || user.username || `User ${user.id}`;
  const embed = new EmbedBuilder()
    .setTitle(`Warnings for ${displayName}`)
    .setColor(0xFFA500)
    .setTimestamp();

  if (warnings.length === 0) {
    embed.setDescription('No warnings on record.');
    return embed;
  }

  const lines = warnings.map((w, i) => {
    const date = new Date(w.created_at + 'Z').toLocaleDateString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric',
    });
    const type = w.type === 'crosspost' ? 'Crosspost' : 'Manual';
    return `**${i + 1}.** ${date} | ${type} | By <@${w.moderator_id}> | ${w.reason}`;
  });

  const chunk = lines.join('\n');
  if (chunk.length <= 4096) {
    embed.setDescription(chunk);
  } else {
    embed.setDescription(lines.slice(0, 20).join('\n') + `\n\n*...and ${lines.length - 20} more*`);
  }

  embed.setFooter({ text: `Total: ${warnings.length} warning(s)` });
  return embed;
}

module.exports = { buildWarningsEmbed };
