import { useEffect, useState } from "react";
import { DIALOGER_STATE } from "../../utils/dialoger-client";

/**
 * Mirrors the Dialoger system's state into React.
 *
 * The system is the source of truth (it owns the transport and the taps); this
 * hook only re-renders on its change event plus a slow tick for the elapsed
 * timer.
 */
export function useDialogerState(scene) {
  const system = scene && scene.systems["hubs-systems"] && scene.systems["hubs-systems"].dialogerSystem;
  const [, force] = useState(0);

  useEffect(() => {
    if (!scene) return;
    const onChanged = () => force(n => n + 1);
    scene.addEventListener("dialoger_state_changed", onChanged);
    // The label shows recording time, so tick even when nothing else changes.
    const timer = setInterval(onChanged, 1000);
    return () => {
      scene.removeEventListener("dialoger_state_changed", onChanged);
      clearInterval(timer);
    };
  }, [scene]);

  const client = system && system.client;
  return {
    system,
    available: !!system && system.available,
    state: client ? client.state : DIALOGER_STATE.OFFLINE,
    recording: !!client && client.recording,
    error: client ? client.error : null,
    whisperLag: client ? client.whisperLag : 0,
    dropped: client ? client.droppedFrames : 0,
    startedAtMs: client ? client.startedAtMs : null
  };
}
