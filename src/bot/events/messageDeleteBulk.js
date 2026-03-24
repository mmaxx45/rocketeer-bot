const { deleteMessage } = require('../../database/messages');

module.exports = {
  name: 'messageDeleteBulk',
  async execute(messages) {
    // Remove all deleted messages from crosspost cache
    for (const [id] of messages) {
      deleteMessage(id);
    }
  },
};
