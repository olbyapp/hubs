import React from "react";
import className from "classnames";
import PropTypes from "prop-types";
import { joinChildren } from "../misc/joinChildren";
import styles from "./ContentMenu.scss";
import { ReactComponent as ObjectsIcon } from "../icons/Objects.svg";
import { ReactComponent as PeopleIcon } from "../icons/People.svg";
import { FormattedMessage } from "react-intl";

export function ContentMenuButton({ active, disabled, children, ...props }) {
  return (
    <button
      className={className(styles.contentMenuButton, { [styles.active]: active, [styles.disabled]: disabled })}
      {...props}
    >
      {children}
    </button>
  );
}

ContentMenuButton.propTypes = {
  children: PropTypes.node,
  active: PropTypes.bool,
  disabled: PropTypes.bool
};

export function ECSDebugMenuButton(props) {
  return (
    <ContentMenuButton {...props}>
      <ObjectsIcon />
      <span className={styles.label}>
        <FormattedMessage id="content-menu.ecs-debug-menu-button" defaultMessage="ECS Debug" />
      </span>
    </ContentMenuButton>
  );
}

export function ObjectsMenuButton(props) {
  return (
    <ContentMenuButton {...props}>
      <ObjectsIcon />
      <span className={styles.label}>
        <FormattedMessage id="content-menu.objects-menu-button" defaultMessage="Objects" />
      </span>
    </ContentMenuButton>
  );
}

export function PeopleMenuButton(props) {
  return (
    <ContentMenuButton {...props}>
      <PeopleIcon />
      {/* vegamix: the label is hidden in portrait, where the bar does not fit, so the
          count lives in its own element that survives - otherwise you lose the only
          place the participant count is visible without opening the sidebar. */}
      <span className={styles.label}>
        <FormattedMessage id="content-menu.people-menu-button" defaultMessage="People" />
      </span>
      <span className={styles.count}>{props.presencecount}</span>
    </ContentMenuButton>
  );
}
PeopleMenuButton.propTypes = {
  presencecount: PropTypes.number
};

export function ContentMenu({ children }) {
  return (
    <div className={styles.contentMenu}>
      {joinChildren(children, () => (
        <div className={styles.separator} />
      ))}
    </div>
  );
}

ContentMenu.propTypes = {
  children: PropTypes.node
};
