const { db } = require('./db');

let stmts;

function getStmts() {
  if (!stmts) {
    stmts = {
      create: db.prepare(`INSERT INTO license_tickets (guild_id, user_id, channel_id) VALUES (?, ?, ?)`),
      getOpenByUser: db.prepare(`SELECT * FROM license_tickets WHERE guild_id = ? AND user_id = ? AND status = 'open' LIMIT 1`),
      getOpenByChannel: db.prepare(`SELECT * FROM license_tickets WHERE channel_id = ? AND status = 'open' LIMIT 1`),
      close: db.prepare(`UPDATE license_tickets SET status = 'closed', closed_at = datetime('now'), closed_by = ? WHERE id = ?`),
      getById: db.prepare(`SELECT * FROM license_tickets WHERE id = ?`),
    };
  }
  return stmts;
}

function createTicket(guildId, userId, channelId) {
  const s = getStmts();
  s.create.run(guildId, userId, channelId);
  return s.getOpenByChannel.get(channelId);
}

function getOpenTicketByUser(guildId, userId) {
  return getStmts().getOpenByUser.get(guildId, userId);
}

function getOpenTicketByChannel(channelId) {
  return getStmts().getOpenByChannel.get(channelId);
}

function closeTicket(ticketId, closedBy) {
  return getStmts().close.run(closedBy, ticketId);
}

module.exports = { createTicket, getOpenTicketByUser, getOpenTicketByChannel, closeTicket };
