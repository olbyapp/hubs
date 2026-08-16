import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import PropTypes from "prop-types";
import classNames from "classnames";
import { FormattedMessage } from "react-intl";
import styles from "./VideoTilesPanel.scss";
import { collectVideoTiles, sameTiles } from "../../utils/video-tiles";
import { useTopDownActive } from "./useTopDownActive";

const ROSTER_POLL_MS = 500;

const tileShape = PropTypes.shape({
  key: PropTypes.string.isRequired,
  name: PropTypes.string,
  isLocal: PropTypes.bool,
  isScreen: PropTypes.bool,
  track: PropTypes.object.isRequired
});

function VideoTile({ tile, size, onClick }) {
  const videoRef = useRef(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = new MediaStream([tile.track]);
    // Autoplay can still be refused; the tile then shows the first frame only.
    video.play().catch(() => {});
    return () => {
      video.srcObject = null;
    };
  }, [tile.track]);

  return (
    <button className={classNames(styles.tile, styles[size])} onClick={onClick} type="button">
      {/* Muted on purpose: voice already arrives through the spatial audio mix. */}
      <video ref={videoRef} className={styles.video} muted playsInline autoPlay />
      <span className={styles.label}>
        {tile.isLocal ? (
          tile.isScreen ? (
            <FormattedMessage id="video-tiles.your-screen" defaultMessage="Your screen" />
          ) : (
            <FormattedMessage id="video-tiles.you" defaultMessage="You" />
          )
        ) : (
          tile.name
        )}
      </span>
    </button>
  );
}

VideoTile.propTypes = {
  tile: tileShape.isRequired,
  size: PropTypes.oneOf(["small", "large"]).isRequired,
  onClick: PropTypes.func
};

// Zoom-style video surface for the top-down view: everyone within earshot who
// is sharing a camera or screen, as a column on the left, with one tile at a
// time promoted to the centre or the whole set expanded into a grid.
export function VideoTilesPanel({ scene, presences, sessionId }) {
  const active = useTopDownActive(scene);
  const [tiles, setTiles] = useState([]);
  const [spotlightKey, setSpotlightKey] = useState(null);
  const [showGrid, setShowGrid] = useState(false);

  // Who is nearby and who is producing both change without an event we can
  // subscribe to (avatars move every frame), so the roster is polled.
  useEffect(() => {
    if (!active) {
      setTiles([]);
      return;
    }
    const update = () => {
      const next = collectVideoTiles(presences, sessionId);
      setTiles(prev => (sameTiles(prev, next) ? prev : next));
    };
    update();
    const interval = setInterval(update, ROSTER_POLL_MS);
    return () => clearInterval(interval);
  }, [active, presences, sessionId]);

  const spotlight = useMemo(() => tiles.find(tile => tile.key === spotlightKey) || null, [tiles, spotlightKey]);
  const listed = useMemo(
    () => (spotlight ? tiles.filter(tile => tile.key !== spotlight.key) : tiles),
    [tiles, spotlight]
  );

  const openInCentre = useCallback(key => {
    setSpotlightKey(key);
    setShowGrid(false);
  }, []);

  const toggleGrid = useCallback(() => {
    setShowGrid(grid => !grid);
    setSpotlightKey(null);
  }, []);

  if (!active || !tiles.length) return null;

  // Each block is placed straight into the room viewport rather than wrapped in
  // a full-bleed container, which would sit over the canvas and eat scene clicks.
  return (
    <>
      {showGrid ? (
        <div className={styles.grid}>
          {tiles.map(tile => (
            <VideoTile key={tile.key} tile={tile} size="large" onClick={() => openInCentre(tile.key)} />
          ))}
        </div>
      ) : (
        spotlight && (
          <div className={styles.spotlight}>
            <VideoTile tile={spotlight} size="large" onClick={() => setSpotlightKey(null)} />
          </div>
        )
      )}
      <div className={styles.column}>
        {tiles.length > 1 && (
          <button className={styles.expandButton} onClick={toggleGrid} type="button">
            {showGrid ? (
              <FormattedMessage id="video-tiles.collapse" defaultMessage="Close tiles" />
            ) : (
              <FormattedMessage id="video-tiles.expand" defaultMessage="Show all tiles" />
            )}
          </button>
        )}
        {!showGrid &&
          listed.map(tile => (
            <VideoTile key={tile.key} tile={tile} size="small" onClick={() => openInCentre(tile.key)} />
          ))}
      </div>
    </>
  );
}

VideoTilesPanel.propTypes = {
  scene: PropTypes.object.isRequired,
  presences: PropTypes.object,
  sessionId: PropTypes.string
};