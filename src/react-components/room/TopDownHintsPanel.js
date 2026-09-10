import React, { useCallback, useEffect, useState } from "react";
import PropTypes from "prop-types";
import { FormattedMessage, useIntl } from "react-intl";
import styles from "./TopDownHintsPanel.scss";
import { ReactComponent as CloseIcon } from "../icons/Close.svg";
import { useTopDownActive } from "./useTopDownActive";

// The 2D view answers to a different set of controls than the 3D one — walking
// to the cursor, zooming, holding the middle button to look around — and none of
// them are written down anywhere else in the room. This card says so in the
// corner, and stays out of the way for good once somebody says they have read it.
const HINTS = [
  {
    id: "walk",
    control: <FormattedMessage id="top-down-hints.walk.control" defaultMessage="Hold left mouse" />,
    action: <FormattedMessage id="top-down-hints.walk.action" defaultMessage="walk to the cursor" />
  },
  {
    id: "teleport",
    control: <FormattedMessage id="top-down-hints.teleport.control" defaultMessage="Double click" />,
    action: <FormattedMessage id="top-down-hints.teleport.action" defaultMessage="jump to that spot" />
  },
  {
    id: "keys",
    control: <FormattedMessage id="top-down-hints.keys.control" defaultMessage="WASD" />,
    action: <FormattedMessage id="top-down-hints.keys.action" defaultMessage="walk, relative to the screen" />
  },
  {
    id: "zoom",
    control: <FormattedMessage id="top-down-hints.zoom.control" defaultMessage="Mouse wheel" />,
    action: <FormattedMessage id="top-down-hints.zoom.action" defaultMessage="zoom in and out" />
  },
  {
    id: "pan",
    control: <FormattedMessage id="top-down-hints.pan.control" defaultMessage="Hold middle mouse" />,
    action: (
      <FormattedMessage
        id="top-down-hints.pan.action"
        defaultMessage="look around the room; walking brings the view back"
      />
    )
  }
];

export function TopDownHintsPanel({ scene, store }) {
  const intl = useIntl();
  const active = useTopDownActive(scene);
  const [dismissed, setDismissed] = useState(() => !!store.state.activity.hasDismissedTopDownHints);
  // Closing hides the card for this visit to 2D only; the checkbox is what makes
  // it stay away.
  const [closed, setClosed] = useState(false);

  useEffect(() => {
    if (active) setClosed(false);
  }, [active]);

  const onDismissForever = useCallback(
    event => {
      if (!event.target.checked) return;
      store.update({ activity: { hasDismissedTopDownHints: true } });
      setDismissed(true);
    },
    [store]
  );

  if (!active || dismissed || closed) return null;

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.title}>
          <FormattedMessage id="top-down-hints.title" defaultMessage="2D view controls" />
        </span>
        <button
          className={styles.close}
          onClick={() => setClosed(true)}
          aria-label={intl.formatMessage({ id: "top-down-hints.close", defaultMessage: "Close" })}
        >
          <CloseIcon width={12} height={12} />
        </button>
      </div>
      <dl className={styles.hints}>
        {HINTS.map(hint => (
          <React.Fragment key={hint.id}>
            <dt className={styles.control}>{hint.control}</dt>
            <dd className={styles.action}>{hint.action}</dd>
          </React.Fragment>
        ))}
      </dl>
      <label className={styles.dismiss}>
        <input type="checkbox" checked={false} onChange={onDismissForever} />
        <FormattedMessage id="top-down-hints.dismiss" defaultMessage="Don't show again" />
      </label>
    </div>
  );
}

TopDownHintsPanel.propTypes = {
  scene: PropTypes.object.isRequired,
  store: PropTypes.object.isRequired
};
