// Keeps name tags off each other in the 2D view.
//
// Seen from straight overhead every tag is a flat, screen-aligned rectangle, so
// world XZ is screen space up to a single scale factor: two plates overlap on
// screen exactly when their world rectangles do. That turns label placement into
// plain 1-D stacking — a plate that lands on one already placed is pushed north
// (up the screen), the direction tags already sit relative to their owner, so a
// moved tag still reads as belonging to the person below it.
//
// Only the offset is computed here. The tags apply it themselves on the next
// frame, because A-Frame ticks components before systems and this pass needs the
// whole frame's placements at once; a frame of lag on a label nobody can see.

// Left between a plate and the one it was pushed off, as a fraction of the
// smaller plate's depth — so the gap grows with the zoom, like the plates do.
const GAP_RATIO = 0.25;
// How much of the remaining distance a tag covers per frame on its way to a new
// slot. Positions drift smoothly as people walk, but the stacking order can swap
// between two frames, and without this the pair would jump past each other.
const SLIDE = 0.25;
// Below this the slide is finished; carrying the last fraction of a millimetre
// forever would keep every tag marked as moving.
const SETTLED = 0.001;
// The furthest a plate is pushed from its owner, in plate heights. Six people
// standing on the same spot cannot all be given a clear slot without the top of
// the stack ending up halfway across the screen from the head it belongs to, at
// which point the tag has stopped being that person's label. Past this the
// crowd goes back to overlapping, which is at least honest about being a crowd.
const MAX_SHIFT_IN_PLATES = 3;

const tags = [];
// Rectangles already placed this frame, pooled: this runs every frame with one
// entry per person in the room.
const placed = [];
let placedCount = 0;

function place(x, z, halfWidth, halfDepth) {
  const rect = placed[placedCount] || (placed[placedCount] = { x: 0, z: 0, halfWidth: 0, halfDepth: 0 });
  rect.x = x;
  rect.z = z;
  rect.halfWidth = halfWidth;
  rect.halfDepth = halfDepth;
  placedCount++;
}

export function layoutTopDownNameTags(components) {
  tags.length = 0;
  for (let i = 0; i < components.length; i++) {
    const tag = components[i];
    // A tag that has not been through the top-down branch of its own tick yet
    // has no size to place, and a hidden one takes no room.
    if (tag.nametag.visible && tag.topDownHalfWidth > 0) {
      tags.push(tag);
    }
  }
  // South to north: the stack grows away from the bottom of the screen, so each
  // pushed tag ends up over its own owner rather than over the next person.
  tags.sort((a, b) => b.topDownPreferred.z - a.topDownPreferred.z);

  placedCount = 0;
  for (let i = 0; i < tags.length; i++) {
    const tag = tags[i];
    const x = tag.topDownPreferred.x;
    const halfWidth = tag.topDownHalfWidth;
    const halfDepth = tag.topDownHalfDepth;
    let z = tag.topDownPreferred.z;

    // One sweep is not enough: clearing the nearest neighbour can push a plate
    // into another one further north. Bounded by the number of plates already
    // down, since every sweep that moves at all clears at least one of them.
    for (let sweep = 0; sweep <= placedCount; sweep++) {
      let moved = false;
      for (let j = 0; j < placedCount; j++) {
        const other = placed[j];
        if (Math.abs(x - other.x) >= halfWidth + other.halfWidth) continue;
        const separation = halfDepth + other.halfDepth + GAP_RATIO * Math.min(halfDepth, other.halfDepth);
        if (Math.abs(z - other.z) >= separation) continue;
        z = other.z - separation;
        moved = true;
      }
      if (!moved) break;
    }
    z = Math.max(z, tag.topDownPreferred.z - MAX_SHIFT_IN_PLATES * 2 * halfDepth);
    // Placed where it actually ends up, capped included, so the next plate is
    // stacked on what is on screen rather than on where this one wanted to go.
    place(x, z, halfWidth, halfDepth);

    const target = tag.topDownPreferred.z - z;
    const offset = tag.topDownStackOffset;
    tag.topDownStackOffset = Math.abs(target - offset) < SETTLED ? target : offset + (target - offset) * SLIDE;
  }
}

// Leaving 2D has to hand the offsets back, or a tag keeps a nudge that only
// made sense against a stack that is no longer on screen.
export function clearTopDownNameTagLayout(components) {
  for (let i = 0; i < components.length; i++) {
    components[i].topDownStackOffset = 0;
    components[i].topDownHalfWidth = 0;
  }
}
