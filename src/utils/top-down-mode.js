import qsTruthy from "./qs_truthy";

// The 2D view is open to everyone; the admin-only gate it launched behind is
// gone. ?2d still exists as a shortcut: it enters the mode straight after
// joining instead of making you press the toolbar toggle.
const requestedByQueryParam = qsTruthy("2d");

let requestedOnEntry = requestedByQueryParam;

// Anything meant to stay readable in the 2D view is scaled by the camera height
// over one of these distances, so it keeps the size it would have when looked at
// from that far away in 3D no matter how far the view is zoomed out.
export const TOP_DOWN_READING_DISTANCE = 3;
// In-world menus are set in smaller type than name tags (0.075 against 0.1, and
// several buttons are scaled down again on top of that), so they need the closer
// of the two distances to come out the same size on screen.
export const TOP_DOWN_MENU_READING_DISTANCE = 2.5;

export function requestTopDownOnEntry() {
  requestedOnEntry = true;
}

export function isTopDownRequestedOnEntry() {
  return requestedOnEntry;
}
