// Incoming-call alerts (vegamix): the ring on its own is easy to miss when the
// Hubs tab is one of a hundred and there is music in the headphones, so a call
// also goes out through every channel a background tab still has — an OS
// notification, the tab's own title, and its favicon.
//
// The favicon is not decoration here, it is the channel that survives the case
// this exists for. Once a window holds enough tabs the browser shrinks them
// past the point where any title is drawn and leaves only the icon, so in a
// hundred-tab window the blinking title is invisible and the icon is the whole
// signal. The OS notification is the least dependable of the three: the browser
// can grant it and the operating system can still drop it without a trace,
// which is what happened on the first machine this was tried on.

// One tag for every call, so a second call replaces the first banner instead of
// stacking another one next to it.
const NOTIFICATION_TAG = "hubs-incoming-call";

// Background tabs have their timers clamped to a second, so this is as fast as
// the title can blink there anyway.
const BLINK_INTERVAL_MS = 1000;

// The blink stops the moment the tab is looked at. This cap is only for a call
// nobody ever comes back to, so the interval does not run for the rest of the
// session.
const BLINK_TIMEOUT_MS = 10 * 60 * 1000;

let blinkInterval = null;
let blinkTimeout = null;
let baseTitle = null;
let blinkTitle = null;
let lastSetTitle = null;
let activeNotification = null;
let listenersInstalled = false;
let faviconLink = null;
let baseFaviconHref = null;
let ringingFaviconHref = null;

function isLookingAtTab() {
  // Hidden covers another tab or a minimised window; unfocused covers the tab
  // being on screen behind some other application.
  return !document.hidden && document.hasFocus();
}

// A red disc with a handset on it, drawn rather than shipped as a file so the
// icon costs no build step and no request while the call is ringing. Where the
// platform has no colour emoji the glyph comes out blank and the bare disc is
// left, which still reads as "this tab wants you" at 16 px.
function buildRingingFavicon() {
  const canvas = document.createElement("canvas");
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#FF3464";
  ctx.beginPath();
  ctx.arc(16, 16, 16, 0, Math.PI * 2);
  ctx.fill();
  ctx.font = "19px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("📞", 16, 18);
  return canvas.toDataURL("image/png");
}

// Our own <link> laid on top rather than an edit to the page's own one: the
// last icon link wins, so restoring the original is a matter of removing ours
// and nothing has to remember what it said.
function startFaviconBlink() {
  if (faviconLink) return;
  if (!ringingFaviconHref) ringingFaviconHref = buildRingingFavicon();
  if (!ringingFaviconHref) return;
  const existing = document.querySelector('link[rel~="icon"]');
  baseFaviconHref = (existing && existing.href) || "/favicon.ico";
  faviconLink = document.createElement("link");
  faviconLink.rel = "icon";
  faviconLink.href = ringingFaviconHref;
  document.head.appendChild(faviconLink);
}

function stopFaviconBlink() {
  if (!faviconLink) return;
  faviconLink.remove();
  faviconLink = null;
  baseFaviconHref = null;
}

function blinkFaviconOnce() {
  if (!faviconLink) return;
  faviconLink.href = faviconLink.href === ringingFaviconHref ? baseFaviconHref : ringingFaviconHref;
}

function blinkOnce() {
  // Something else may have written the title since the last blink — a room
  // rename does. Adopt whatever it wrote, so that is what comes back rather
  // than the old name.
  if (document.title !== lastSetTitle) {
    baseTitle = document.title;
  }
  lastSetTitle = document.title === blinkTitle ? baseTitle : blinkTitle;
  document.title = lastSetTitle;
  blinkFaviconOnce();
}

function stopTitleBlink() {
  stopFaviconBlink();
  if (!blinkInterval) return;
  clearInterval(blinkInterval);
  clearTimeout(blinkTimeout);
  blinkInterval = null;
  blinkTimeout = null;
  if (document.title === blinkTitle) {
    document.title = baseTitle;
  }
  blinkTitle = null;
  lastSetTitle = null;
}

function startTitleBlink(title) {
  stopTitleBlink();
  baseTitle = document.title;
  blinkTitle = title;
  lastSetTitle = baseTitle;
  startFaviconBlink();
  blinkOnce();
  blinkInterval = setInterval(blinkOnce, BLINK_INTERVAL_MS);
  blinkTimeout = setTimeout(stopTitleBlink, BLINK_TIMEOUT_MS);
}

export function clearCallAlert() {
  stopTitleBlink();
  if (activeNotification) {
    activeNotification.close();
    activeNotification = null;
  }
}

function installReturnListeners() {
  if (listenersInstalled) return;
  listenersInstalled = true;
  const onBack = () => {
    if (isLookingAtTab()) clearCallAlert();
  };
  document.addEventListener("visibilitychange", onBack);
  window.addEventListener("focus", onBack);
}

// Asked for once on entering a room: that is right after the user clicked their
// way in, so the prompt has some context, and it is early enough that the first
// call already benefits. A "denied" or "granted" answer is final — the browser
// ignores any further asking — so we only ever prompt from "default".
export function requestCallAlertPermission() {
  if (typeof Notification === "undefined") return;
  if (Notification.permission !== "default") return;
  try {
    const result = Notification.requestPermission();
    // Older Safari takes a callback and returns nothing at all.
    if (result && result.catch) result.catch(() => {});
  } catch (error) {
    console.warn("Could not ask for notification permission", error);
  }
}

function showCallNotification(callerName) {
  // Logged rather than skipped quietly: when a call fails to reach someone the
  // only evidence is in their console, and "was the OS ever asked" is the first
  // thing worth knowing.
  if (typeof Notification === "undefined") {
    console.warn("call alert: this browser has no Notification API");
    return;
  }
  if (Notification.permission !== "granted") {
    console.warn(`call alert: no OS notification, permission is "${Notification.permission}"`);
    return;
  }

  const hubName = (window.APP.hub && window.APP.hub.name) || "the room";
  const title = `📞 ${callerName} is calling you`;
  const options = {
    body: `in ${hubName}`,
    icon: "/favicon.ico",
    badge: "/favicon.ico",
    tag: NOTIFICATION_TAG,
    // Replace the previous banner rather than sitting silently underneath it.
    renotify: true,
    // Chrome keeps the banner up until it is dismissed, which is the whole
    // point here. Firefox ignores the flag and hides it after a few seconds —
    // the blinking title is what covers that case.
    requireInteraction: true
    // Deliberately not silent. The in-room ring can be lost under whatever the
    // user is listening to, and it goes out of the tab's audio output, while
    // the notification sound is the system one on the default device — a second
    // chance at being heard, which is the whole problem being solved here.
  };

  try {
    const notification = new Notification(title, options);
    activeNotification = notification;
    // Handed over successfully. If nothing appears on screen past this line the
    // browser accepted it and the operating system dropped it — a per-app
    // notification switch and Focus Assist both do that without a word.
    console.log("call alert: OS notification handed over", title);
    notification.onerror = event => console.warn("call alert: OS rejected the notification", event);
    notification.onclick = () => {
      window.focus();
      clearCallAlert();
    };
  } catch (error) {
    console.warn("Falling back to a service worker notification", error);
    // Chrome on Android forbids the constructor outright and only shows
    // notifications through the service worker, whose own notificationclick
    // handler focuses the window named in data.hub_url.
    if (!navigator.serviceWorker) return;
    navigator.serviceWorker.ready
      .then(registration =>
        registration.showNotification(title, { ...options, data: { hub_url: window.location.href } })
      )
      .catch(() => {});
  }
}

export function alertIncomingCall(callerName) {
  // A call that arrives while the user is already looking at the room needs no
  // help — the ring and the chat line are both right in front of them.
  if (isLookingAtTab()) return;
  installReturnListeners();
  showCallNotification(callerName);
  startTitleBlink(`📞 ${callerName} is calling`);
}
