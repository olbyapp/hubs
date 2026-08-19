import React from "react";
import PropTypes from "prop-types";
import { FormattedMessage } from "react-intl";
import { Modal } from "../modal/Modal";
import { CloseButton } from "../input/CloseButton";
import { Button } from "../input/Button";
import { Column } from "../layout/Column";
import { STATUS_DISPLAY_NAMES } from "../../utils/user-status";

// Asked by status-nudge-system when someone moves while still marked Thinking
// or AFK. Both answers are one click and neither is destructive, so there is
// no confirmation step — the point is to be dismissed quickly.
export function StatusNudgeModal({ status, onResume, onClose }) {
  const statusName = <b>{STATUS_DISPLAY_NAMES[status] || status}</b>;

  return (
    <Modal
      title={<FormattedMessage id="status-nudge-modal.title" defaultMessage="Welcome back?" />}
      beforeTitle={<CloseButton onClick={onClose} />}
    >
      <Column padding center centerMd="both" grow>
        <p>
          <FormattedMessage
            id="status-nudge-modal.message"
            defaultMessage="You are moving around, but your status is still {status}.{linebreak}Everyone sees you as unavailable and your voice and media stay muted."
            values={{ status: statusName, linebreak: <br /> }}
          />
        </p>
        <Button preset="accept" onClick={onResume}>
          <FormattedMessage id="status-nudge-modal.resume" defaultMessage="I'm back — go Online" />
        </Button>
        <Button preset="cancel" onClick={onClose}>
          <FormattedMessage
            id="status-nudge-modal.keep"
            defaultMessage="Keep {status}"
            values={{ status: STATUS_DISPLAY_NAMES[status] || status }}
          />
        </Button>
      </Column>
    </Modal>
  );
}

StatusNudgeModal.propTypes = {
  status: PropTypes.string,
  onResume: PropTypes.func,
  onClose: PropTypes.func
};
