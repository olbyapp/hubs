import React, { useCallback } from "react";
import PropTypes from "prop-types";
import { ToolbarButton } from "../input/ToolbarButton";
import { ReactComponent as ShowIcon } from "../icons/Show.svg";
import { FormattedMessage } from "react-intl";
import { useTopDownActive } from "./useTopDownActive";

// Toolbar toggle between the first-person view and the Gather-style top-down
// ("2D") view. Only mounted for admins / ?2d — see canUseTopDown().
export function TopDownToggleButton({ scene }) {
  const active = useTopDownActive(scene);

  const onClick = useCallback(() => {
    scene.systems["hubs-systems"].cameraSystem.toggleTopDown();
  }, [scene]);

  return (
    <ToolbarButton
      icon={<ShowIcon />}
      preset="accent2"
      selected={active}
      onClick={onClick}
      label={
        active ? (
          <FormattedMessage id="top-down-toggle.to-3d" defaultMessage="3D View" />
        ) : (
          <FormattedMessage id="top-down-toggle.to-2d" defaultMessage="2D View" />
        )
      }
    />
  );
}

TopDownToggleButton.propTypes = {
  scene: PropTypes.object.isRequired
};