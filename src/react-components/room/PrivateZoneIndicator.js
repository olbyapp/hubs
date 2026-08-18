import React, { useEffect, useState } from "react";
import { useIntl, defineMessage } from "react-intl";
import styles from "./PrivateZoneIndicator.scss";
import { ReactComponent as EarIcon } from "../icons/Ear.svg";
import { isPrivateZoneActive, onPrivateZoneChanged } from "../../utils/private-zone";

const privateZoneLabel = defineMessage({
  id: "private-zone-indicator.label",
  defaultMessage: "Private zone on"
});

// Standing reminder in the corner of the view that the private zone is on. The
// toolbar button says so too, but it is one of a dozen and is easy to stop
// seeing; forgetting you are in a bubble means wondering why the room has gone
// quiet.
export function PrivateZoneIndicator() {
  const intl = useIntl();
  const [active, setActive] = useState(isPrivateZoneActive());

  useEffect(() => onPrivateZoneChanged(state => setActive(state.active)), []);

  if (!active) return null;

  const label = intl.formatMessage(privateZoneLabel);

  return (
    <div className={styles.indicator} title={label} aria-label={label}>
      <EarIcon />
    </div>
  );
}
