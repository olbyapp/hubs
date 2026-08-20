// Call state (vegamix): one call at a time.
//
// A call rings on the other end for CALL_RING_MS and there is no way to cancel
// it, so hammering the button just stacks rings on someone who is already being
// rung. Until the one in flight has finished, the caller cannot place another —
// to anyone, not just to the same person: "let the first call go through".
//
// Held here rather than in either button because there are two of them (the
// People panel and the avatar's hover menu) and they must share one answer. The
// rule itself is enforced where they meet, in the scene's action_call_client
// handler, so no future third entry point can slip past it.

export const CALL_RING_MS = 10000;

const listeners = new Set();
let ringingUntil = 0;
let timer = null;

export function isCallRinging() {
  return Date.now() < ringingUntil;
}

function notify() {
  for (const listener of listeners) listener(isCallRinging());
}

export function startCallRinging() {
  ringingUntil = Date.now() + CALL_RING_MS;
  notify();
  // The timer only exists to tell the UI when to come back to life; the guard
  // itself reads the clock, so a missed or late timer cannot unlock anything
  // early.
  clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    notify();
  }, CALL_RING_MS);
}

// Returns an unsubscribe function, so React effects can just return it.
export function onCallRingingChanged(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
