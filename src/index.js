const config = require('./config');
const logger = require('./logger');
const { db, runMigrations } = require('./database/db');
const client = require('./bot/client');
const { createWebServer } = require('./web/server');
const fs = require('fs');
const path = require('path');
const { Collection } = require('discord.js');

let server = null;
let shuttingDown = false;

async function main() {
  // 1. Run database migrations
  await runMigrations();
  logger.info(`Database initialized (${db.client})`);

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
    const handler = (...args) => Promise.resolve(event.execute(...args))
      .catch(err => logger.error(`Unhandled error in ${event.name} handler:`, err));
    if (event.once) {
      client.once(event.name, handler);
    } else {
      client.on(event.name, handler);
    }
    logger.debug(`Loaded event: ${event.name}`);
  }
  logger.info(`Loaded ${eventFiles.length} event handler(s)`);

  // 4. Start web server
  const app = createWebServer(client);
  server = app.listen(config.web.port, () => {
    logger.info(`Web dashboard running on http://localhost:${config.web.port}`);
  });

  // 5. Login
  await client.login(config.discord.token);
}

// 6. Graceful shutdown (SIGINT from a terminal, SIGTERM from systemd / docker)
const SHUTDOWN_TIMEOUT_MS = 10000;

async function shutdown(signal) {
  if (shuttingDown) {
    // A second Ctrl+C / SIGTERM while a shutdown hangs: stop waiting.
    logger.warn(`Received ${signal} again, exiting immediately`);
    process.exit(1);
  }
  shuttingDown = true;
  logger.info(`Shutting down (${signal})...`);
  // Don't let a stuck query or gateway close keep the process alive forever.
  setTimeout(() => {
    logger.error(`Shutdown did not finish within ${SHUTDOWN_TIMEOUT_MS / 1000}s, exiting`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();

  let exitCode = 0;
  try {
    if (server) server.close();
    const readyHandler = require('./bot/events/ready');
    if (readyHandler.cleanup) readyHandler.cleanup();
    await client.destroy();
    const { stopCleanup } = require('./database/messages');
    stopCleanup();
    await db.close();
  } catch (err) {
    logger.error(`Error during shutdown: ${err.message}`);
    exitCode = 1;
  }
  process.exit(exitCode);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (error) => {
  logger.error('Unhandled promise rejection:', error);
});

main().catch(async (err) => {
  logger.error(`Fatal error during startup: ${err.message}`, err);
  await db.close().catch(() => {});
  process.exit(1);
});
