const { REST, Routes } = require('discord.js');
const config = require('./src/config');
const fs = require('fs');
const path = require('path');

const commands = [];
const commandsPath = path.join(__dirname, 'src', 'bot', 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
  const command = require(path.join(commandsPath, file));
  commands.push(command.data.toJSON());
  console.log(`Loaded command: ${command.data.name}`);
}

const rest = new REST({ version: '10' }).setToken(config.discord.token);

(async () => {
  try {
    const arg = process.argv[2];

    // node deploy-commands.js --clear-global  → wipes all global commands
    if (arg === '--clear-global') {
      console.log('Clearing all global commands...');
      await rest.put(
        Routes.applicationCommands(config.discord.clientId),
        { body: [] }
      );
      console.log('Global commands cleared.');
      return;
    }

    const guildId = arg;

    if (guildId) {
      console.log(`Registering ${commands.length} commands to guild ${guildId} (instant)...`);
      await rest.put(
        Routes.applicationGuildCommands(config.discord.clientId, guildId),
        { body: commands }
      );
      console.log('Successfully registered guild commands.');
    } else {
      console.log(`Registering ${commands.length} commands globally (may take up to 1 hour)...`);
      await rest.put(
        Routes.applicationCommands(config.discord.clientId),
        { body: commands }
      );
      console.log('Successfully registered global commands.');
    }
  } catch (error) {
    console.error('Failed to register commands:', error);
    process.exit(1);
  }
})();
