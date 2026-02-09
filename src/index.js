const config = require('./config');
const logger = require('./logger');
const { runMigrations } = require('./database/db');
const client = require('./bot/client');
const { createWebServer } = require('./web/server');
const fs = require('fs');
const path = require('path');
const { Collection } = require('discord.js');

// 1. Run database migrations
runMigrations();
logger.info('Database initialized');

// 2. Load commands
client.commands = new Collection();
const commandsPath = path.join(__dirname, 'bot', 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'));
for (const file of commandFiles) {
  const command = require(path.join(commandsPath, file));
  client.commands.set(command.data.name, command);
  logger.debug(`Loaded command: ${command.data.name}`);
}
logger.info(`Loaded ${client.commands.size} command(s)`);

// 3. Load events
const eventsPath = path.join(__dirname, 'bot', 'events');
const eventFiles = fs.readdirSync(eventsPath).filter(f => f.endsWith('.js'));
for (const file of eventFiles) {
  const event = require(path.join(eventsPath, file));
  if (event.once) {
    client.once(event.name, (...args) => event.execute(...args));
  } else {
    client.on(event.name, (...args) => event.execute(...args));
  }
  logger.debug(`Loaded event: ${event.name}`);
}
logger.info(`Loaded ${eventFiles.length} event handler(s)`);

// 4. Start web server
const app = createWebServer(client);
app.listen(config.web.port, () => {
  logger.info(`Web dashboard running on http://localhost:${config.web.port}`);
});

// 5. Login
client.login(config.discord.token);

// 6. Graceful shutdown
process.on('SIGINT', () => {
  logger.info('Shutting down...');
  client.destroy();
  const { db } = require('./database/db');
  db.close();
  process.exit(0);
});

process.on('unhandledRejection', (error) => {
  logger.error('Unhandled promise rejection:', error);
});
