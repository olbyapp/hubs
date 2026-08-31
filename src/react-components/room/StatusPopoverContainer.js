import React, { useCallback, useEffect, useState } from "react";
import PropTypes from "prop-types";
import { Popover } from "../popover/Popover";
import { ToolbarButton } from "../input/ToolbarButton";
import { Button } from "../input/Button";
import { Column } from "../layout/Column";
import { ReactComponent as AvatarIcon } from "../icons/Avatar.svg";
import { ToolTip } from "@mozilla/lilypad-ui";
import { defineMessage, defineMessages, useIntl } from "react-intl";
import { CustomStatusModal } from "./CustomStatusModal";
import { getOwnStatus, getOwnStatusText, setOwnStatus, USER_STATUSES } from "../../utils/user-status";

const statusPopoverTitle = defineMessage({
  id: "status-popover.title",
  defaultMessage: "Status"
});

const statusOptionLabels = defineMessages({
  none: { id: "status-popover.status-none", defaultMessage: "Online" },
  work: { id: "status-popover.status-work", defaultMessage: "Work" },
  eat: { id: "status-popover.status-eat", defaultMessage: "Eat" },
  thinking: { id: "status-popover.status-thinking", defaultMessage: "Thinking (silence, callable)" },
  afk: { id: "status-popover.status-afk", defaultMessage: "AFK (silence, no calls)" },
  custom: { id: "status-popover.status-custom", defaultMessage: "Custom…" }
});

// Short labels for the toolbar button — long ones overflow onto neighbors.
const statusShortLabels = defineMessages({
  none: { id: "status-popover.short-none", defaultMessage: "Online" },
  work: { id: "status-popover.short-work", defaultMessage: "Work" },
  eat: { id: "status-popover.short-eat", defaultMessage: "Eat" },
  thinking: { id: "status-popover.short-thinking", defaultMessage: "Thinking" },
  afk: { id: "status-popover.short-afk", defaultMessage: "AFK" },
  custom: { id: "status-popover.short-custom", defaultMessage: "Custom" }
});

// A custom status can run to 100 characters; the toolbar has room for about
// this many before the button starts shoving its neighbours along the bar. The
// whole text is on the nametag and in the People panel.
const TOOLBAR_LABEL_LENGTH = 12;

function toolbarLabel(intl, status, statusText) {
  if (status === "none") return intl.formatMessage(statusPopoverTitle);
  if (status !== "custom") return intl.formatMessage(statusShortLabels[status]);
  if (!statusText) return intl.formatMessage(statusShortLabels.custom);
  const trimmed = Array.from(statusText);
  return trimmed.length > TOOLBAR_LABEL_LENGTH ? `${trimmed.slice(0, TOOLBAR_LABEL_LENGTH).join("")}…` : statusText;
}

export function StatusPopoverContainer({ showNonHistoriedDialog }) {
  const intl = useIntl();
  const title = intl.formatMessage(statusPopoverTitle);
  const [current, setCurrent] = useState(getOwnStatus());
  const [customText, setCustomText] = useState(getOwnStatusText());

  // The popover is not the only thing that sets a status: the modal that
  // catches movement while away clears it, and so does switching the mic back
  // on. Read it off the store rather than remembering what was last picked
  // here, or the button goes on advertising a status the user has left.
  useEffect(() => {
    const store = window.APP.store;
    const onProfileChanged = () => {
      setCurrent(getOwnStatus());
      setCustomText(getOwnStatusText());
    };
    store.addEventListener("profilechanged", onProfileChanged);
    // Anything that landed between the first render and this effect.
    onProfileChanged();
    return () => store.removeEventListener("profilechanged", onProfileChanged);
  }, []);

  // Custom is the one entry that cannot be applied by picking it — it has no
  // meaning until there are words behind it, so it asks for them first and only
  // then becomes the status. Picking it again reopens the dialog on the last
  // text, which is how a custom status gets edited.
  const onSelect = useCallback(
    status => {
      if (status !== "custom") {
        setOwnStatus(status);
        return;
      }
      showNonHistoriedDialog(CustomStatusModal, {
        initialText: getOwnStatusText(),
        onSave: text => setOwnStatus("custom", text)
      });
    },
    [showNonHistoriedDialog]
  );

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
                // Closed first: the custom entry opens a dialog over the room,
                // and leaving the popover hanging behind it looks like a bug.
                closePopover();
                onSelect(status);
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
        <ToolTip description={current === "custom" && customText ? customText : title}>
          <ToolbarButton
            ref={triggerRef}
            icon={<AvatarIcon />}
            selected={popoverVisible}
            onClick={togglePopover}
            label={toolbarLabel(intl, current, customText)}
            preset="accent3"
          />
        </ToolTip>
      )}
    </Popover>
  );
}

StatusPopoverContainer.propTypes = {
  showNonHistoriedDialog: PropTypes.func.isRequired
};
