const crypto = require('crypto');

const pendingActions = new Map();

function storePendingAction(data) {
  const actionId = crypto.randomUUID().slice(0, 16);
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

// Atomic get-and-delete to prevent double-click races
function consumePendingAction(actionId) {
  const data = pendingActions.get(actionId);
  if (data) pendingActions.delete(actionId);
  return data;
}

module.exports = { storePendingAction, getPendingAction, deletePendingAction, consumePendingAction };
