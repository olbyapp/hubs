import React, { useCallback, useEffect, useState } from "react";
import { ToolbarButton } from "../input/ToolbarButton";
import { ReactComponent as EarIcon } from "../icons/Ear.svg";
import { ToolTip } from "@mozilla/lilypad-ui";
import { defineMessage, FormattedMessage, useIntl } from "react-intl";
import {
  isPrivateZoneActive,
  isPrivateZoneLocked,
  onPrivateZoneChanged,
  PRIVATE_ZONE_RADIUS,
  toggleOwnPrivateZone
} from "../../utils/private-zone";

const privateZoneDescription = defineMessage({
  id: "private-zone-toggle.description",
  defaultMessage: "Private zone: only people within {radius} m hear you, and you hear only them. Off by default."
});

const privateZoneLockedDescription = defineMessage({
  id: "private-zone-toggle.locked-description",
  defaultMessage: "You are inside someone else's private zone. It ends when one of you walks away."
});

// Toolbar toggle for the private bubble. Unpressed, the room hears you
// normally; pressed, only the people standing with you do — and they are pulled
// in with you, which is why the button locks for them and not for you.
export function PrivateZoneToggleButton() {
  const intl = useIntl();
  const [state, setState] = useState(() => ({ active: isPrivateZoneActive(), locked: isPrivateZoneLocked() }));

  useEffect(() => onPrivateZoneChanged(({ active, locked }) => setState({ active, locked })), []);

  const onClick = useCallback(() => toggleOwnPrivateZone(), []);

  return (
    <ToolTip
      description={intl.formatMessage(state.locked ? privateZoneLockedDescription : privateZoneDescription, {
        radius: PRIVATE_ZONE_RADIUS
      })}
    >
      <ToolbarButton
        icon={<EarIcon />}
        // Filled while the zone is on and plain while it is off, rather than
        // the toolbar's usual inversion: a lit button should mean "this is
        // running".
        preset={state.active ? "accent4" : "basic"}
        disabled={state.locked}
        onClick={onClick}
        label={<FormattedMessage id="private-zone-toggle.label" defaultMessage="Private" />}
      />
    </ToolTip>
  );
}
