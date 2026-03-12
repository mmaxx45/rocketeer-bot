const MANAGE_GUILD = BigInt(0x20);

function userCanManageGuild(user, guildId) {
  if (!user || !user.guilds) return false;
  const guild = user.guilds.find(g => g.id === guildId);
  if (!guild) return false;
  const permissions = BigInt(guild.permissions);
  return (permissions & MANAGE_GUILD) === MANAGE_GUILD;
}

module.exports = { MANAGE_GUILD, userCanManageGuild };
