import React, { useCallback, useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import { FormattedMessage, useIntl, defineMessages } from "react-intl";
import styles from "./SpeakingWhileMutedNotification.scss";
import { ReactComponent as CloseIcon } from "../icons/Close.svg";
import { useMicrophoneStatus } from "./hooks/useMicrophoneStatus";
import { SOUND_CHAT_MESSAGE } from "../../systems/sound-effects-system";
import { SPEAKING_WHILE_MUTED_EVENT } from "../../systems/speaking-while-muted-system";

const messages = defineMessages({
  close: {
    id: "speaking-while-muted.close",
    defaultMessage: "Dismiss"
  }
});

// Raised by speaking-while-muted-system when it hears voiced audio on a muted
// mic. It stays up until answered: the whole failure it exists to catch is
// someone not looking at the screen while they talk, and a notice that times
// out is one more thing to miss.
export function SpeakingWhileMutedNotification({ scene }) {
  const intl = useIntl();
  const { isMicMuted, toggleMute } = useMicrophoneStatus(scene);
  const [visible, setVisible] = useState(false);
  // The system keeps reporting for as long as someone talks. Once the notice is
  // up those reports have nothing left to say, and acting on them would pop and
  // shake over a notice the user is already reading.
  const visibleRef = useRef(false);

  useEffect(() => {
    const onSpeakingWhileMuted = () => {
      if (visibleRef.current) return;
      visibleRef.current = true;
      setVisible(true);
      scene.systems["hubs-systems"].soundEffectsSystem.playSoundOneShot(SOUND_CHAT_MESSAGE);
    };
    window.addEventListener(SPEAKING_WHILE_MUTED_EVENT, onSpeakingWhileMuted);
    return () => window.removeEventListener(SPEAKING_WHILE_MUTED_EVENT, onSpeakingWhileMuted);
  }, [scene]);

  const hide = useCallback(() => {
    visibleRef.current = false;
    setVisible(false);
  }, []);

  // Unmuting from anywhere -- this button, the toolbar, the M key -- answers the
  // notice, so it should not sit there afterwards contradicting a live mic.
  useEffect(() => {
    if (!isMicMuted) hide();
  }, [isMicMuted, hide]);

  const onUnmute = useCallback(() => {
    hide();
    toggleMute();
  }, [hide, toggleMute]);

  if (!visible) return null;

  return (
    <div className={styles.notification}>
      <div className={styles.message}>
        <FormattedMessage
          id="speaking-while-muted.message"
          defaultMessage="Your microphone is off — nobody can hear you."
        />
      </div>
      <button className={styles.unmuteButton} onClick={onUnmute}>
        <FormattedMessage id="speaking-while-muted.unmute" defaultMessage="Unmute" />
      </button>
      <button className={styles.closeButton} onClick={hide} aria-label={intl.formatMessage(messages.close)}>
        <CloseIcon width={16} height={16} />
      </button>
    </div>
  );
}

SpeakingWhileMutedNotification.propTypes = {
  scene: PropTypes.object.isRequired
};
