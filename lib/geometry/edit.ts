/**
 * lib/geometry/edit.ts — the two document edits that are really geometry.
 *
 * SPLITTING A WALL is what happens when you draw onto the middle of an existing one. It is the most
 * error-prone operation in the editor, because a wall is not just a line: openings sit along it at
 * absolute offsets from node `a`, items are anchored the same way, and room loops name it in a
 * specific position in a specific direction. Cut the line and every one of those has to be told
 * where it now lives. Get it wrong and a door quietly slides three metres down the flat, or a room
 * outline stops closing. So it is written once, here, as a pure function returning a description of
 * the change, and tested against a hand-built fixture that actually has openings on it — even though
 * openings are a later pass and nothing produces them yet. Retrofitting this later means retrofitting
 * it under a UI that is already relying on the wrong behaviour.
 *
 * SETTING A WALL'S LENGTH is the feature that makes the editor a measuring instrument rather than a
 * sketchpad — the eval harness records its ground truth by typing lengths in here. It is geometry
 * because the interesting part is not the arithmetic but the question of what moves; see
 * `chooseMovingEnd`.
 *
 * Both return a PLAN rather than a new document. The store applies it through immer so the change
 * comes out as a handful of small patches — an undo entry the size of the edit, not the size of the
 * flat. Both report failure as a structured result rather than throwing: every one of these
 * failures is something a user can cause by tapping in a slightly wrong place.
 *
 * Pure. No React, no store, no three.js.
 */

import type { Level, Opening, PlanNode, Wall } from '../plan/schema';
import { distance, normalise, subtract, type Point } from './plan-space';
import { indexNodes, projectOntoSegment, wallEnds } from './pick';

/* ------------------------------------------------------------------------------------------------
 * Splitting a wall
 * ---------------------------------------------------------------------------------------------- */

/** Where an opening or an item has to move to, with its offset already recomputed. */
export interface Reassignment {
  /** The element's own id. */
  id: string;
  /** The wall it now belongs to. */
  wall: string;
  /** Its new distance from that wall's node `a`. */
  offsetMm: number;
}

/** A room loop that must gain the new wall, and the index in `wallLoop` to insert it at. */
export interface RoomInsertion {
  room: string;
  index: number;
}

export interface WallSplit {
  /** The corner created at the cut. */
  node: PlanNode;
  /**
   * The original wall, which KEEPS ITS ID and is shortened to end at the new node.
   *
   * Reusing the id rather than replacing the wall with two new ones is what lets openings, items and
   * room loops on the near half stay exactly as they are. Giving both halves fresh ids would orphan
   * every reference to the wall at once, and the editor would be turning one tap into a document
   * full of errors.
   */
  shortenedWall: string;
  /** The far half: a brand new wall from the new node to the original `b`. */
  addedWall: Wall;
  /** Openings past the cut. Those before it keep their wall and their offset and are not listed. */
  movedOpenings: readonly Reassignment[];
  movedItems: readonly Reassignment[];
  roomInsertions: readonly RoomInsertion[];
  /** Distance from node `a` to the cut, which is also the amount every moved offset came down by. */
  cutMm: number;
}

export type SplitFailure =
  | { ok: false; reason: 'no-such-wall' }
  /** Endpoints missing or coincident: the wall has no direction, so "along it" means nothing. */
  | { ok: false; reason: 'unmeasurable' }
  /** The cut landed on an existing corner. There is nothing to split; attach to that corner instead. */
  | { ok: false; reason: 'at-end' }
  /** The cut runs through the middle of a doorway or window. */
  | { ok: false; reason: 'through-opening'; openings: readonly Opening[] };

export type SplitOutcome = { ok: true; split: WallSplit } | SplitFailure;

export interface SplitIds {
  /** Id for the new corner. */
  node: string;
  /** Id for the far half. The near half keeps the original wall's id. */
  wall: string;
}

/**
 * Cut `wallId` at (or nearest to) `at`, and work out where everything on it now lives.
 *
 * WHY A CUT THROUGH AN OPENING IS REFUSED rather than resolved. The spec's rule is that an opening
 * moves to "whichever half now contains it", and an opening the cut passes through is contained by
 * neither. The available repairs are all worse than refusing: assigning it to the larger half and
 * clamping its offset moves a door the user never touched, and shortening it changes a real width
 * that was measured off a real building. Refusing is the only outcome that does not silently
 * falsify a measurement, and the editor can say exactly which doorway is in the way — which is a
 * more useful thing to be told than watching a door jump. `Issue[]`-shaped results rather than
 * thrown exceptions, for the same reason: this is a user's tap, not a programmer's mistake.
 */
export function splitWall(level: Level, wallId: string, at: Point, ids: SplitIds): SplitOutcome {
  const wall = level.walls.find((w) => w.id === wallId);
  if (wall === undefined) return { ok: false, reason: 'no-such-wall' };

  const nodeById = indexNodes(level.nodes);
  const ends = wallEnds(nodeById, wall);
  if (ends === null) return { ok: false, reason: 'unmeasurable' };

  const lengthMm = distance(ends.a, ends.b);
  if (lengthMm === 0) return { ok: false, reason: 'unmeasurable' };

  const projection = projectOntoSegment(ends.a, ends.b, at);
  const cutMm = Math.round(projection.alongMm);
  // Rounded to integer millimetres because the new node's coordinates are, and the two must agree:
  // every offset recomputed below is measured from a corner that really is `cutMm` along.
  const direction = normalise(subtract(ends.b, ends.a));
  const position: Point = {
    x: Math.round(ends.a.x + direction.x * cutMm),
    y: Math.round(ends.a.y + direction.y * cutMm),
  };

  const wholeMm = Math.round(lengthMm);
  if (cutMm <= 0 || cutMm >= wholeMm) return { ok: false, reason: 'at-end' };
  // Belt and braces on a diagonal wall, where rounding the position can land it on an endpoint even
  // though `cutMm` did not. A zero-length wall is an error the validator would then have to report
  // about geometry we chose to create, which is the wrong way round.
  if ((position.x === ends.a.x && position.y === ends.a.y) || (position.x === ends.b.x && position.y === ends.b.y)) {
    return { ok: false, reason: 'at-end' };
  }

  const onWall = level.openings.filter((o) => o.wall === wall.id);
  // Touching the cut end-on is fine; a doorway that starts exactly where the new wall starts sits
  // wholly on one half. Only a genuine straddle is refused.
  const straddling = onWall.filter((o) => o.offsetMm < cutMm && o.offsetMm + o.widthMm > cutMm);
  if (straddling.length > 0) return { ok: false, reason: 'through-opening', openings: straddling };

  const movedOpenings: Reassignment[] = onWall
    .filter((o) => o.offsetMm >= cutMm)
    .map((o) => ({ id: o.id, wall: ids.wall, offsetMm: o.offsetMm - cutMm }));

  const movedItems: Reassignment[] = level.items.flatMap((item) => {
    if (item.anchor.on !== 'wall' || item.anchor.wall !== wall.id) return [];
    if (item.anchor.offsetMm < cutMm) return [];
    return [{ id: item.id, wall: ids.wall, offsetMm: item.anchor.offsetMm - cutMm }];
  });

  const node: PlanNode = {
    id: ids.node,
    x: position.x,
    y: position.y,
    // `derived`, not `user`: nobody chose this corner's coordinates, they fell out of where an
    // existing wall happened to run. Re-running extraction is free to move it; a corner the user
    // dragged by hand is not.
    meta: { source: 'derived', confidence: 1 },
  };

  const addedWall: Wall = {
    id: ids.wall,
    a: node.id,
    b: wall.b,
    thicknessMm: wall.thicknessMm,
    heightMm: wall.heightMm,
    // The far half is the same piece of building as the near half, so it inherits its provenance
    // rather than claiming to be something the user drew.
    meta: { ...wall.meta },
  };

  return {
    ok: true,
    split: {
      node,
      shortenedWall: wall.id,
      addedWall,
      movedOpenings,
      movedItems,
      roomInsertions: planRoomInsertions(level, wall),
      cutMm,
    },
  };
}

/**
 * Where the far half goes in each room loop that names this wall.
 *
 * A loop is an ordered list of walls in which consecutive entries share a node, and the order runs
 * the same way round for every room so derived polygons wind consistently. Splitting a wall must
 * therefore insert the new half on the correct SIDE of the old one — after it when the loop
 * traverses the wall from `a` to `b`, before it when the loop runs the other way. Insert on the
 * wrong side and the loop stops closing, which surfaces as `ROOM_LOOP_BROKEN` on a room the user
 * never touched.
 *
 * Traversal direction is read off the neighbours: whichever of the wall's own nodes it shares with
 * the previous entry is the end the loop arrives at.
 */
function planRoomInsertions(level: Level, wall: Wall): RoomInsertion[] {
  const wallById = new Map(level.walls.map((w) => [w.id, w]));
  const insertions: RoomInsertion[] = [];

  for (const room of level.rooms) {
    const index = room.wallLoop.indexOf(wall.id);
    if (index < 0) continue;

    const previous = wallById.get(room.wallLoop[(index - 1 + room.wallLoop.length) % room.wallLoop.length]);
    const next = wallById.get(room.wallLoop[(index + 1) % room.wallLoop.length]);

    const arrivesAtA = previous !== undefined && (previous.a === wall.a || previous.b === wall.a);
    const leavesFromB = next !== undefined && (next.a === wall.b || next.b === wall.b);

    // `a` -> `b` traversal puts the far half after the near half. Anything we cannot read — a loop
    // that is already broken, which `validate` is already shouting about — falls back to "after",
    // because that is right whenever the loop was written in the natural direction.
    const forwards = arrivesAtA || leavesFromB || !(previous !== undefined || next !== undefined);
    insertions.push({ room: room.id, index: forwards ? index + 1 : index });
  }

  return insertions;
}

/* ------------------------------------------------------------------------------------------------
 * Typed exact lengths
 * ---------------------------------------------------------------------------------------------- */

export type WallEnd = 'a' | 'b';

/**
 * Which end of a wall moves when its length is typed in.
 *
 * THE DECISION, and it is the one that decides whether the tool feels like an instrument or feels
 * possessed. Shared nodes mean that moving a corner drags every wall attached to it — that is the
 * entire point of the design, and it is also what makes this dangerous: retype one bedroom wall and
 * you can shove half the flat sideways.
 *
 * So: THE END WITH FEWER OTHER WALLS ATTACHED MOVES. It is the end whose movement disturbs least,
 * measured in the only unit that matters here, which is how many other pieces of the drawing change
 * shape. A free end (nothing else attached) moves in preference to a corner; a corner in preference
 * to a T-junction.
 *
 * Ties — and both ends of a wall in a finished flat are usually equally busy — go to `b`. `b` is the
 * end most recently placed when the wall was drawn, so on the fresh geometry where this is used most
 * it is the end the user is already thinking of as "the far one". Arbitrary tie-breaks are fine as
 * long as they are stated and stable; what is not fine is a rule the user cannot predict.
 *
 * The editor shows which end will move BEFORE the change is committed, and offers a control to
 * flip it, because "least disturbance" is a good default and not a law.
 */
export function chooseMovingEnd(level: Pick<Level, 'walls'>, wall: Wall): WallEnd {
  const attached = (nodeId: string): number =>
    level.walls.filter((w) => w.id !== wall.id && (w.a === nodeId || w.b === nodeId)).length;
  return attached(wall.a) < attached(wall.b) ? 'a' : 'b';
}

export interface LengthChange {
  wall: string;
  moving: WallEnd;
  /** The corner that moves. */
  node: string;
  from: Point;
  /** Where it moves to. Integer millimetres. */
  to: Point;
  /**
   * The length actually achieved, which is what the wall will measure afterwards.
   *
   * Equal to the requested length on any axis-aligned wall, and within half a millimetre of it on a
   * diagonal, because the moved corner has to land on integer millimetres. Reported rather than
   * hidden: this is a measuring instrument, and an instrument that quietly rounds is worse than one
   * that says what it did.
   */
  achievedLengthMm: number;
  /** The other walls sharing the moving corner. They follow it, and they will change shape. */
  followers: readonly string[];
}

export type LengthFailure =
  | { ok: false; reason: 'no-such-wall' }
  | { ok: false; reason: 'unmeasurable' }
  /** A wall must have a positive length; zero has no direction and nothing downstream is defined. */
  | { ok: false; reason: 'not-positive' };

export type LengthOutcome = { ok: true; change: LengthChange } | LengthFailure;

/**
 * Work out the corner move that would make `wallId` exactly `lengthMm` long.
 *
 * The wall keeps its DIRECTION and its fixed end; only the distance changes. Called both to preview
 * the edit and to apply it, so what the user is shown and what happens cannot drift apart.
 */
export function planLengthChange(
  level: Level,
  wallId: string,
  lengthMm: number,
  moving: WallEnd,
): LengthOutcome {
  const wall = level.walls.find((w) => w.id === wallId);
  if (wall === undefined) return { ok: false, reason: 'no-such-wall' };
  if (!Number.isFinite(lengthMm) || lengthMm <= 0) return { ok: false, reason: 'not-positive' };

  const nodeById = indexNodes(level.nodes);
  const ends = wallEnds(nodeById, wall);
  if (ends === null) return { ok: false, reason: 'unmeasurable' };

  const fixed = moving === 'a' ? ends.b : ends.a;
  const mover = moving === 'a' ? ends.a : ends.b;
  const along = subtract(mover, fixed);
  if (along.x === 0 && along.y === 0) return { ok: false, reason: 'unmeasurable' };

  const direction = normalise(along);
  const to: Point = {
    x: Math.round(fixed.x + direction.x * lengthMm),
    y: Math.round(fixed.y + direction.y * lengthMm),
  };

  const followers = level.walls
    .filter((w) => w.id !== wall.id && (w.a === mover.id || w.b === mover.id))
    .map((w) => w.id);

  return {
    ok: true,
    change: {
      wall: wall.id,
      moving,
      node: mover.id,
      from: { x: mover.x, y: mover.y },
      to,
      achievedLengthMm: Math.round(distance(fixed, to)),
      followers,
    },
  };
}
