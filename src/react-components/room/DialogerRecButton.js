import React, { useCallback } from "react";
import PropTypes from "prop-types";
import { ToolbarButton } from "../input/ToolbarButton";
import { ReactComponent as RecordIcon } from "../icons/Record.svg";
import { ToolTip } from "@mozilla/lilypad-ui";
import { useDialogerState } from "./useDialogerState";
import { DIALOGER_STATE } from "../../utils/dialoger-client";

function elapsed(startedAtMs) {
  if (!startedAtMs) return "";
  const sec = Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000));
  return ` ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

function errorText(code) {
  switch (code) {
    case "popup_blocked":
      return "bridge window was blocked — allow pop-ups for this site";
    case "bridge_closed":
      return "bridge window is closed";
    case "unauthorized":
      return "wrong token, check the settings";
    case "session_already_active":
      return "another session is already running";
    case "vram_busy":
      return "busy re-analysing on the GPU";
    default:
      return code || "unavailable";
  }
}

/**
 * The label is always "Rec".
 *
 * Toolbar buttons are 48px wide with `white-space: nowrap` on the caption, so
 * anything longer spills out of the button and lands askew over its
 * neighbours. State belongs in the icon colour, the status dot and the
 * tooltip, which is also how the rest of this toolbar behaves.
 */
function describe({ state, error, whisperLag, dropped, startedAtMs }) {
  const base = { label: "Rec" };
  switch (state) {
    case DIALOGER_STATE.OFFLINE:
      return { ...base, tooltip: "Record this meeting to Dialoger", preset: "accent4" };
    case DIALOGER_STATE.CONNECTING:
      return { ...base, tooltip: "Connecting to Dialoger…", preset: "accent4", disabled: true };
    case DIALOGER_STATE.READY:
      return { ...base, tooltip: "Start recording", preset: "accent4" };
    case DIALOGER_STATE.STARTING:
      // Dialoger loads Whisper onto the GPU when a session starts — 5–15
      // seconds during which nothing visible happens.
      return {
        ...base,
        tooltip: "Starting: Dialoger is loading speech recognition…",
        preset: "accent4",
        disabled: true
      };
    case DIALOGER_STATE.RECORDING: {
      const degraded = whisperLag > 40 || dropped > 0;
      return {
        ...base,
        tooltip: degraded
          ? `Recording${elapsed(startedAtMs)}, but Dialoger is falling behind: queue ${whisperLag}, dropped frames ${dropped}`
          : `Recording${elapsed(startedAtMs)} — click to stop`,
        preset: degraded ? "accent5" : "cancel",
        selected: true,
        statusColor: "recording"
      };
    }
    case DIALOGER_STATE.ERROR:
    default:
      return { ...base, tooltip: `Dialoger: ${errorText(error)}`, preset: "accent5" };
  }
}

/**
 * Toolbar button that records the meeting into the operator's local Dialoger.
 *
 * Only rendered when the `dialogerEnabled` preference is on. That is a
 * deliberate substitute for probing whether Dialoger is alive: through the
 * bridge transport there is no way to check without opening the popup, and
 * gating on a local preference gives the behaviour we want anyway — only the
 * person actually running Dialoger ever sees the button.
 */
export function DialogerRecButton({ scene }) {
  const dialoger = useDialogerState(scene);
  const enabled = !!window.APP?.store?.state?.preferences?.dialogerEnabled;

  const onClick = useCallback(() => {
    const system = scene.systems["hubs-systems"] && scene.systems["hubs-systems"].dialogerSystem;
    if (!system) return;
    // Synchronous on purpose: the bridge transport opens a window, and an
    // await here would spend the user activation the popup blocker checks for.
    // One press means "record" — the system remembers that through the
    // handshake rather than making the user press again once it lands.
    system.press();
  }, [scene]);

  if (!enabled || !dialoger.available) return null;

  const { label, tooltip, preset, disabled, selected, statusColor } = describe(dialoger);

  return (
    <ToolTip description={tooltip}>
      <ToolbarButton
        icon={<RecordIcon />}
        preset={preset}
        selected={!!selected}
        statusColor={statusColor}
        disabled={disabled}
        onClick={onClick}
        label={label}
      />
    </ToolTip>
  );
}

DialogerRecButton.propTypes = {
  scene: PropTypes.object.isRequired
};
