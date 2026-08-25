const SYNC_DURATION_MS = 5000;

// HACK this is a hacky component that is used to mitigate the situation where a first sync is missed on critical
// networked elements. (At the time of this writing, specifically just the user's avatar.) The motivation
// is that there have been a variety of issues resulting in missed avatar instantiation messages, and
// this is meant to ensure we recover from those in the cases where they occur.
//
// This component, when added, will re-send a isFirstSync message for the networked object is it attached to
// every SYNC_DURATION_MS milliseconds.
//
// tick() rides the animation loop, which browsers stop in hidden tabs — and a hidden tab is exactly the
// client whose avatar most needs re-announcing, since its owner is not around to notice they are missing
// for someone. The interval keeps the re-broadcast going back there; hidden tabs throttle timers to about
// once a minute, which is still enough for anyone who joined after our first sync got lost.
AFRAME.registerComponent("periodic-full-syncs", {
  init() {
    this.lastSync = 0;
    this.maybeSync = this.maybeSync.bind(this);
    this.intervalId = setInterval(this.maybeSync, SYNC_DURATION_MS);
  },

  remove() {
    clearInterval(this.intervalId);
  },

  tick() {
    this.maybeSync();
  },

  maybeSync() {
    // Unlike tick, the interval also fires before the room is entered.
    if (!window.NAF || !NAF.connection.isConnected()) return;

    const now = performance.now();

    if (now - this.lastSync >= SYNC_DURATION_MS && this.el.components && this.el.components.networked) {
      this.lastSync = now;

      // Sends an undirected first sync message.
      this.el.components.networked.syncAll(null, true);
    }
  }
});
