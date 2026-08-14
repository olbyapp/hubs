import React, { useCallback, useState } from "react";
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

const statusLabels = defineMessages({
  none: { id: "status-popover.status-none", defaultMessage: "Online" },
  work: { id: "status-popover.status-work", defaultMessage: "Work" },
  eat: { id: "status-popover.status-eat", defaultMessage: "Eat" },
  thinking: { id: "status-popover.status-thinking", defaultMessage: "Thinking (silence, callable)" },
  afk: { id: "status-popover.status-afk", defaultMessage: "AFK (silence, no calls)" }
});

export function StatusPopoverContainer() {
  const intl = useIntl();
  const title = intl.formatMessage(statusPopoverTitle);
  const [current, setCurrent] = useState(getOwnStatus());

  const onSelect = useCallback(status => {
    setOwnStatus(status);
    setCurrent(status);
  }, []);

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
              {intl.formatMessage(statusLabels[status])}
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
            label={current !== "none" ? intl.formatMessage(statusLabels[current]) : title}
            preset="accent3"
          />
        </ToolTip>
      )}
    </Popover>
  );
}
