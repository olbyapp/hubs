import qsTruthy from "./qs_truthy";
import configs from "./configs";

// The ?2d query param force-enables the feature (for testing without an admin
// account) and also pre-requests top-down on entry.
const qsForced = qsTruthy("2d");

let requestedOnEntry = qsForced;

// Feature gate: admins only while the mode is being tested, or anyone with ?2d.
export function canUseTopDown() {
  return qsForced || configs.isAdmin();
}

export function requestTopDownOnEntry() {
  requestedOnEntry = true;
}

export function isTopDownRequestedOnEntry() {
  return requestedOnEntry;
}