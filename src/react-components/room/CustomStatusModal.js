import React, { useCallback, useState } from "react";
import PropTypes from "prop-types";
import { defineMessage, FormattedMessage, useIntl } from "react-intl";
import { Modal } from "../modal/Modal";
import { CloseButton } from "../input/CloseButton";
import { Button } from "../input/Button";
import { Column } from "../layout/Column";
import { TextInputField } from "../input/TextInputField";
import { CUSTOM_STATUS_MAX_LENGTH, sanitizeStatusText } from "../../utils/user-status";

const placeholder = defineMessage({
  id: "custom-status-modal.placeholder",
  defaultMessage: "e.g. In a meeting until 15:00"
});

// Asked for by the Custom entry in the status picker (vegamix). One line of
// free text, capped at CUSTOM_STATUS_MAX_LENGTH, which then rides presence to
// everyone exactly the way the fixed statuses do.
export function CustomStatusModal({ initialText, onSave, onClose }) {
  const intl = useIntl();
  const [text, setText] = useState(initialText || "");

  // What would actually be published, which is also what decides whether there
  // is anything to publish: a field holding nothing but spaces is an empty one.
  const cleaned = sanitizeStatusText(text);
  // Counted the way the input's own maxLength counts, so the number under the
  // field agrees with the point at which it stops accepting keystrokes.
  const used = text.length;

  const onSubmit = useCallback(
    event => {
      event.preventDefault();
      if (!cleaned) return;
      onSave(cleaned);
      onClose();
    },
    [cleaned, onSave, onClose]
  );

  return (
    <Modal
      title={<FormattedMessage id="custom-status-modal.title" defaultMessage="Custom status" />}
      beforeTitle={<CloseButton onClick={onClose} />}
    >
      {/* A form rather than a click handler, so Enter submits — this dialog is
          one field and one button, and reaching for the mouse to finish typing
          a sentence is the wrong shape. */}
      <Column as="form" padding center centerMd="both" grow onSubmit={onSubmit}>
        <TextInputField
          autoFocus
          fullWidth
          label={<FormattedMessage id="custom-status-modal.label" defaultMessage="What should everyone see?" />}
          description={`${used} / ${CUSTOM_STATUS_MAX_LENGTH}`}
          maxLength={CUSTOM_STATUS_MAX_LENGTH}
          value={text}
          placeholder={intl.formatMessage(placeholder)}
          onChange={event => setText(event.target.value)}
        />
        <Button type="submit" preset="accept" disabled={!cleaned}>
          <FormattedMessage id="custom-status-modal.confirm" defaultMessage="OK" />
        </Button>
        <Button type="button" preset="cancel" onClick={onClose}>
          <FormattedMessage id="custom-status-modal.cancel" defaultMessage="Cancel" />
        </Button>
      </Column>
    </Modal>
  );
}

CustomStatusModal.propTypes = {
  initialText: PropTypes.string,
  onSave: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired
};
