import React, { useCallback, useEffect, useState } from "react";
import { ToolbarButton } from "../input/ToolbarButton";
import { ReactComponent as EarIcon } from "../icons/Ear.svg";
import { ToolTip } from "@mozilla/lilypad-ui";
import { defineMessage, FormattedMessage, useIntl } from "react-intl";
import {
  isPrivateZoneOn,
  onPrivateZoneChanged,
  PRIVATE_ZONE_RADIUS,
  togglePrivateZone
} from "../../utils/private-zone";

const privateZoneDescription = defineMessage({
  id: "private-zone-toggle.description",
  defaultMessage: "Private zone: you only hear, and are only heard by, people within {radius} m. Off by default."
});

// Toolbar toggle for the narrow "whisper" radius. Unpressed means the room hears
// you normally; pressed means only the people standing with you do.
export function PrivateZoneToggleButton() {
  const intl = useIntl();
  const [active, setActive] = useState(isPrivateZoneOn());

  useEffect(() => onPrivateZoneChanged(setActive), []);

  const onClick = useCallback(() => togglePrivateZone(), []);

  return (
    <ToolTip description={intl.formatMessage(privateZoneDescription, { radius: PRIVATE_ZONE_RADIUS })}>
      <ToolbarButton
        icon={<EarIcon />}
        preset="accent4"
        selected={active}
        onClick={onClick}
        label={<FormattedMessage id="private-zone-toggle.label" defaultMessage="Private" />}
      />
    </ToolTip>
  );
}
