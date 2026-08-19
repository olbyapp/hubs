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

function describe({ state, error, whisperLag, dropped, startedAtMs }) {
  switch (state) {
    case DIALOGER_STATE.OFFLINE:
      return { label: "Rec", tooltip: "Record this meeting to Dialoger", preset: "accent4" };
    case DIALOGER_STATE.CONNECTING:
      return { label: "…", tooltip: "Connecting to Dialoger", preset: "accent4", disabled: true };
    case DIALOGER_STATE.READY:
      return { label: "Rec", tooltip: "Start recording", preset: "accent4" };
    case DIALOGER_STATE.STARTING:
      // Dialoger loads Whisper onto the GPU when a session starts — 5–15
      // seconds during which nothing visible happens. Without this state the
      // button just looks dead.
      return {
        label: "Starting…",
        tooltip: "Dialoger is loading speech recognition",
        preset: "accent4",
        disabled: true
      };
    case DIALOGER_STATE.RECORDING: {
      const degraded = whisperLag > 40 || dropped > 0;
      return {
        label: `Rec${elapsed(startedAtMs)}`,
        tooltip: degraded
          ? `Recording, but Dialoger is falling behind: queue ${whisperLag}, dropped frames ${dropped}`
          : "Recording — click to stop",
        preset: degraded ? "accent5" : "cancel",
        statusColor: "recording"
      };
    }
    case DIALOGER_STATE.ERROR:
    default:
      return { label: "Rec", tooltip: `Dialoger: ${errorText(error)}`, preset: "accent5" };
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
    const system = scene.systems["hubs-systems"].dialogerSystem;
    // Synchronous on purpose: the bridge transport opens a window, and an
    // await here would spend the user activation the popup blocker checks for.
    if (!system.client) {
      system.connect();
      return;
    }
    system.toggleRecording();
  }, [scene]);

  if (!enabled || !dialoger.available) return null;

  const { label, tooltip, preset, disabled, statusColor } = describe(dialoger);

  return (
    <ToolTip description={tooltip}>
      <ToolbarButton
        icon={<RecordIcon />}
        preset={preset}
        selected={dialoger.recording}
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
