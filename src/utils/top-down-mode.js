import qsTruthy from "./qs_truthy";

// The 2D view is open to everyone; the admin-only gate it launched behind is
// gone. ?2d still exists as a shortcut: it enters the mode straight after
// joining instead of making you press the toolbar toggle.
const requestedByQueryParam = qsTruthy("2d");

let requestedOnEntry = requestedByQueryParam;

export function requestTopDownOnEntry() {
  requestedOnEntry = true;
}

export function isTopDownRequestedOnEntry() {
  return requestedOnEntry;
}
