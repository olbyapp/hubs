import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import PropTypes from "prop-types";
import classNames from "classnames";
import { FormattedMessage } from "react-intl";
// ResizeObserver not currently supported in Firefox Android
import ResizeObserver from "resize-observer-polyfill";
import styles from "./VideoTilesPanel.scss";
import { collectVideoTiles, sameTiles } from "../../utils/video-tiles";
import { useTopDownActive } from "./useTopDownActive";

const ROSTER_POLL_MS = 500;

// Tiles are laid out in script rather than by the grid/flex algorithms alone:
// both the column and the gallery have a fixed box to fill and a tile count that
// changes as people join, and only the caller knows that a tile is 16:9. Left to
// `1fr` rows the gallery stretched each tile vertically instead of scaling it,
// and the column simply ran off the bottom of the screen.
const TILE_ASPECT = 16 / 9;
const TILE_GAP = 8;
const STRIP_TILE_MAX_WIDTH = 160;
// Below this a tile is too small to recognise anyone in, so a long strip wraps
// into a second line instead of shrinking further.
const STRIP_TILE_MIN_WIDTH = 88;

// Inline rather than imported: the icon set has no expand/collapse glyph.
const ExpandIcon = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
    <path d="M1 1h6v2H3v4H1V1zm14 0v6h-2V3H9V1h6zM3 9v4h4v2H1V9h2zm12 0v6H9v-2h4V9h2z" />
  </svg>
);

const CollapseIcon = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
    <path d="M7 1v6H1V5h4V1h2zm8 4v2H9V1h2v4h4zM7 9v6H5v-4H1V9h6zm8 0v2h-4v4H9V9h6z" />
  </svg>
);

const tileShape = PropTypes.shape({
  key: PropTypes.string.isRequired,
  name: PropTypes.string,
  isLocal: PropTypes.bool,
  isScreen: PropTypes.bool,
  track: PropTypes.object.isRequired
});

// Reports the content box of a node, tracking it as the viewport changes. Takes
// the node itself, not a ref: these blocks mount and unmount as people start and
// stop sharing, and a ref object would not tell us when that happened.
function useElementSize(node) {
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const report = (width, height) =>
      setSize(prev => (prev.width === width && prev.height === height ? prev : { width, height }));
    if (!node) {
      report(0, 0);
      return;
    }
    const observer = new ResizeObserver(entries => {
      const { width, height } = entries[entries.length - 1].contentRect;
      report(width, height);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);

  return size;
}

function VideoTile({ tile, size, style, onClick, onToggleFullscreen, fullscreen }) {
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
    <div className={classNames(styles.tile, styles[size])} style={style} onClick={onClick} role="presentation">
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
      {onToggleFullscreen && (
        <button
          className={styles.fullscreenButton}
          type="button"
          title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
          onClick={event => {
            event.stopPropagation();
            onToggleFullscreen();
          }}
        >
          {fullscreen ? <CollapseIcon /> : <ExpandIcon />}
        </button>
      )}
    </div>
  );
}

VideoTile.propTypes = {
  tile: tileShape.isRequired,
  // "fixed" takes the size given to it, "fill" takes the size of its container.
  size: PropTypes.oneOf(["fixed", "fill"]).isRequired,
  style: PropTypes.object,
  onClick: PropTypes.func,
  onToggleFullscreen: PropTypes.func,
  fullscreen: PropTypes.bool
};

// Widest tile that lets `count` of them stack inside `height`, the button above
// them included. Clamped: never bigger than in the original design, and never so
// small that the column turns into a strip of thumbnails.
function columnTileWidth(count, height, buttonHeight) {
  if (!count || !height) return STRIP_TILE_MAX_WIDTH;
  const buttonSpace = buttonHeight ? buttonHeight + TILE_GAP : 0;
  const perTile = (height - buttonSpace - TILE_GAP * (count - 1)) / count;
  return Math.max(STRIP_TILE_MIN_WIDTH, Math.min(STRIP_TILE_MAX_WIDTH, Math.floor(perTile * TILE_ASPECT)));
}

// Same idea lying down: the 3D view puts the strip across the top, so the tiles
// share the width and the button sits beside them rather than above.
function rowTileWidth(count, width, buttonWidth) {
  if (!count || !width) return STRIP_TILE_MAX_WIDTH;
  const buttonSpace = buttonWidth ? buttonWidth + TILE_GAP : 0;
  const perTile = (width - buttonSpace - TILE_GAP * (count - 1)) / count;
  return Math.max(STRIP_TILE_MIN_WIDTH, Math.min(STRIP_TILE_MAX_WIDTH, Math.floor(perTile)));
}

// Biggest tile that fits `count` of them into the box at 16:9, trying every row
// and column split. Whichever split leaves the tiles largest wins, which is what
// makes a 6-person gallery come out as 3x2 rather than one flat row.
function galleryTileWidth(count, width, height) {
  if (!count || !width || !height) return 0;
  let best = 0;
  for (let columns = 1; columns <= count; columns++) {
    const rows = Math.ceil(count / columns);
    const boxWidth = (width - TILE_GAP * (columns - 1)) / columns;
    const boxHeight = (height - TILE_GAP * (rows - 1)) / rows;
    best = Math.max(best, Math.min(boxWidth, boxHeight * TILE_ASPECT));
  }
  return Math.floor(best);
}

// Zoom-style video surface, and the only place webcams and screenshares are
// shown in either view: everyone within earshot who is sharing, as a strip of
// tiles, with one tile at a time promoted to the centre or the whole set
// expanded into a gallery. The strip runs down the left in 2D, where the middle
// of the screen is the map, and across the top in 3D, where the middle is what
// you are looking at.
export function VideoTilesPanel({ scene, presences, sessionId }) {
  const topDown = useTopDownActive(scene);
  const [tiles, setTiles] = useState([]);
  const [spotlightKey, setSpotlightKey] = useState(null);
  const [showGrid, setShowGrid] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [stripNode, setStripNode] = useState(null);
  const [buttonNode, setButtonNode] = useState(null);
  const [gridNode, setGridNode] = useState(null);

  // Who is nearby and who is producing both change without an event we can
  // subscribe to (avatars move every frame), so the roster is polled.
  useEffect(() => {
    const update = () => {
      const next = collectVideoTiles(presences, sessionId);
      setTiles(prev => (sameTiles(prev, next) ? prev : next));
    };
    update();
    const interval = setInterval(update, ROSTER_POLL_MS);
    return () => clearInterval(interval);
  }, [presences, sessionId]);

  const spotlight = useMemo(() => tiles.find(tile => tile.key === spotlightKey) || null, [tiles, spotlightKey]);
  const listed = useMemo(
    () => (spotlight ? tiles.filter(tile => tile.key !== spotlight.key) : tiles),
    [tiles, spotlight]
  );

  const stripSize = useElementSize(stripNode);
  const buttonSize = useElementSize(buttonNode);
  const gridSize = useElementSize(gridNode);

  const stripTileStyle = useMemo(
    () => ({
      width: topDown
        ? columnTileWidth(listed.length, stripSize.height, buttonSize.height)
        : rowTileWidth(listed.length, stripSize.width, buttonSize.width)
    }),
    [topDown, listed.length, stripSize.height, stripSize.width, buttonSize.height, buttonSize.width]
  );

  const gridTileStyle = useMemo(() => {
    const width = galleryTileWidth(tiles.length, gridSize.width, gridSize.height);
    return width ? { width, height: Math.floor(width / TILE_ASPECT) } : { visibility: "hidden" };
  }, [tiles.length, gridSize.width, gridSize.height]);

  const openInCentre = useCallback(key => {
    setSpotlightKey(key);
    setShowGrid(false);
  }, []);

  const closeSpotlight = useCallback(() => {
    setSpotlightKey(null);
    setFullscreen(false);
  }, []);

  const toggleGrid = useCallback(() => {
    setShowGrid(grid => !grid);
    setSpotlightKey(null);
    setFullscreen(false);
  }, []);

  if (!tiles.length) return null;

  // Each block is placed straight into the room viewport rather than wrapped in
  // a full-bleed container, which would sit over the canvas and eat scene clicks.
  // The blocks themselves let clicks through (pointer-events land on the tiles),
  // so they can cover as much of the view as the layout needs.
  return (
    <>
      {showGrid ? (
        <div className={styles.grid} ref={setGridNode}>
          {tiles.map(tile => (
            <VideoTile
              key={tile.key}
              tile={tile}
              size="fixed"
              style={gridTileStyle}
              onClick={() => openInCentre(tile.key)}
            />
          ))}
        </div>
      ) : (
        spotlight && (
          <div className={classNames(styles.spotlight, { [styles.fullscreen]: fullscreen })}>
            <VideoTile
              tile={spotlight}
              size="fill"
              onClick={closeSpotlight}
              fullscreen={fullscreen}
              onToggleFullscreen={() => setFullscreen(value => !value)}
            />
          </div>
        )
      )}
      <div
        className={classNames(topDown ? styles.column : styles.row, { [styles.hidden]: fullscreen })}
        ref={setStripNode}
      >
        {tiles.length > 1 && (
          <button className={styles.expandButton} onClick={toggleGrid} type="button" ref={setButtonNode}>
            {showGrid ? (
              <FormattedMessage id="video-tiles.collapse" defaultMessage="Close tiles" />
            ) : (
              <FormattedMessage id="video-tiles.expand" defaultMessage="Show all tiles" />
            )}
          </button>
        )}
        {!showGrid &&
          listed.map(tile => (
            <VideoTile
              key={tile.key}
              tile={tile}
              size="fixed"
              style={stripTileStyle}
              onClick={() => openInCentre(tile.key)}
            />
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
