import React, { useCallback, useEffect, useState } from "react";
import { Popover } from "../popover/Popover";
import { ToolbarButton } from "../input/ToolbarButton";
import { Button } from "../input/Button";
import { Column } from "../layout/Column";
import { ReactComponent as AvatarIcon } from "../icons/Avatar.svg";
import { ToolTip } from "@mozilla/lilypad-ui";
import { defineMessage, defineMessages, useIntl } from "react-intl";
import { getOwnStatus, setOwnStatus, USER_STATUSES } from "../../utils/user-status";

const statusPopoverTitle = defineMessage({
  id: "status-popover.title",
  defaultMessage: "Status"
});

const statusOptionLabels = defineMessages({
  none: { id: "status-popover.status-none", defaultMessage: "Online" },
  work: { id: "status-popover.status-work", defaultMessage: "Work" },
  eat: { id: "status-popover.status-eat", defaultMessage: "Eat" },
  thinking: { id: "status-popover.status-thinking", defaultMessage: "Thinking (silence, callable)" },
  afk: { id: "status-popover.status-afk", defaultMessage: "AFK (silence, no calls)" }
});

// Short labels for the toolbar button — long ones overflow onto neighbors.
const statusShortLabels = defineMessages({
  none: { id: "status-popover.short-none", defaultMessage: "Online" },
  work: { id: "status-popover.short-work", defaultMessage: "Work" },
  eat: { id: "status-popover.short-eat", defaultMessage: "Eat" },
  thinking: { id: "status-popover.short-thinking", defaultMessage: "Thinking" },
  afk: { id: "status-popover.short-afk", defaultMessage: "AFK" }
});

export function StatusPopoverContainer() {
  const intl = useIntl();
  const title = intl.formatMessage(statusPopoverTitle);
  const [current, setCurrent] = useState(getOwnStatus());

  // The popover is not the only thing that sets a status: the modal that
  // catches movement while away clears it, and so does switching the mic back
  // on. Read it off the store rather than remembering what was last picked
  // here, or the button goes on advertising a status the user has left.
  useEffect(() => {
    const store = window.APP.store;
    const onProfileChanged = () => setCurrent(getOwnStatus());
    store.addEventListener("profilechanged", onProfileChanged);
    // Anything that landed between the first render and this effect.
    onProfileChanged();
    return () => store.removeEventListener("profilechanged", onProfileChanged);
  }, []);

  const onSelect = useCallback(status => setOwnStatus(status), []);

  return (
    <Popover
      title={title}
      content={({ closePopover }) => (
        <Column padding="sm" grow gap="xs">
          {USER_STATUSES.map(status => (
            <Button
              key={status}
              sm
              thin
              preset={status === current ? "primary" : "basic"}
              onClick={() => {
                onSelect(status);
                closePopover();
              }}
            >
              {intl.formatMessage(statusOptionLabels[status])}
            </Button>
          ))}
        </Column>
      )}
      placement="top"
      offsetDistance={28}
    >
      {({ togglePopover, popoverVisible, triggerRef }) => (
        <ToolTip description={title}>
          <ToolbarButton
            ref={triggerRef}
            icon={<AvatarIcon />}
            selected={popoverVisible}
            onClick={togglePopover}
            label={current !== "none" ? intl.formatMessage(statusShortLabels[current]) : title}
            preset="accent3"
          />
        </ToolTip>
      )}
    </Popover>
  );
}
