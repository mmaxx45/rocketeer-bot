const { deleteMessage } = require('../../database/messages');

module.exports = {
  name: 'messageDelete',
  async execute(message) {
    // Remove from crosspost cache so deleted messages don't trigger false positives
    deleteMessage(message.id);
  },
};
