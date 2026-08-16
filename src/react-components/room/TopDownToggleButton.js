import React, { useCallback, useEffect, useState } from "react";
import PropTypes from "prop-types";
import { ToolbarButton } from "../input/ToolbarButton";
import { ReactComponent as ShowIcon } from "../icons/Show.svg";
import { FormattedMessage } from "react-intl";
import { CAMERA_MODE_TOP_DOWN } from "../../systems/camera-system";

// Toolbar toggle between the first-person view and the Gather-style top-down
// ("2D") view. Only mounted for admins / ?2d — see canUseTopDown().
export function TopDownToggleButton({ scene }) {
  const cameraSystem = scene.systems["hubs-systems"].cameraSystem;
  const [active, setActive] = useState(cameraSystem.mode === CAMERA_MODE_TOP_DOWN);

  useEffect(() => {
    const onChanged = e => setActive(e.detail.active);
    scene.addEventListener("top_down_mode_changed", onChanged);
    return () => scene.removeEventListener("top_down_mode_changed", onChanged);
  }, [scene]);

  const onClick = useCallback(() => {
    cameraSystem.toggleTopDown();
  }, [cameraSystem]);

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