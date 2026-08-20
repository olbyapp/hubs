import React, { useCallback, useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import { FormattedMessage } from "react-intl";
import { Tip } from "./Tip";
import { useMicrophoneStatus } from "./hooks/useMicrophoneStatus";
import { SPEAKING_WHILE_MUTED_EVENT } from "../../systems/speaking-while-muted-system";

// Long enough to read a line and reach for the button, short enough that it is
// gone before it becomes part of the furniture.
const SHOW_MS = 5000;

// Raised by speaking-while-muted-system when it hears voiced audio on a muted
// mic. The dismiss button unmutes rather than only closing: what the user
// wanted was to be heard, and in a quiet status unmuting also puts them back
// Online, so the one click settles the whole thing.
export function SpeakingWhileMutedNotification({ scene }) {
  const { isMicMuted, toggleMute } = useMicrophoneStatus(scene);
  const [visible, setVisible] = useState(false);
  const timeoutRef = useRef(null);

  useEffect(() => {
    const onSpeakingWhileMuted = () => {
      setVisible(true);
      clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setVisible(false), SHOW_MS);
    };
    window.addEventListener(SPEAKING_WHILE_MUTED_EVENT, onSpeakingWhileMuted);
    return () => {
      window.removeEventListener(SPEAKING_WHILE_MUTED_EVENT, onSpeakingWhileMuted);
      clearTimeout(timeoutRef.current);
    };
  }, []);

  // Unmuting from anywhere -- this button, the toolbar, the M key -- answers
  // the notification, so it should not sit there afterwards contradicting a
  // live mic.
  useEffect(() => {
    if (!isMicMuted) setVisible(false);
  }, [isMicMuted]);

  const onUnmute = useCallback(() => {
    setVisible(false);
    toggleMute();
  }, [toggleMute]);

  if (!visible) return null;

  return (
    <Tip
      onDismiss={onUnmute}
      dismissLabel={<FormattedMessage id="speaking-while-muted.unmute" defaultMessage="Unmute" />}
    >
      <FormattedMessage
        id="speaking-while-muted.message"
        defaultMessage="Your microphone is off — nobody can hear you."
      />
    </Tip>
  );
}

SpeakingWhileMutedNotification.propTypes = {
  scene: PropTypes.object.isRequired
};
