const crypto = require('crypto');

const pendingActions = new Map();

function storePendingAction(data) {
  const actionId = crypto.randomUUID().slice(0, 8);
  pendingActions.set(actionId, data);
  setTimeout(() => pendingActions.delete(actionId), 15 * 60 * 1000);
  return actionId;
}

function getPendingAction(actionId) {
  return pendingActions.get(actionId);
}

function deletePendingAction(actionId) {
  pendingActions.delete(actionId);
}

module.exports = { storePendingAction, getPendingAction, deletePendingAction };
