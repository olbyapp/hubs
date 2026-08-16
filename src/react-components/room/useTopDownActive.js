import { useEffect, useState } from "react";
import { CAMERA_MODE_TOP_DOWN } from "../../systems/camera-system";

// Tracks whether the 2D top-down view is currently on.
export function useTopDownActive(scene) {
  const [active, setActive] = useState(
    () => scene.systems["hubs-systems"].cameraSystem.mode === CAMERA_MODE_TOP_DOWN
  );

  useEffect(() => {
    const onChanged = e => setActive(e.detail.active);
    scene.addEventListener("top_down_mode_changed", onChanged);
    return () => scene.removeEventListener("top_down_mode_changed", onChanged);
  }, [scene]);

  return active;
}