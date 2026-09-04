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

/**
 * The provenance every element touched by a user's action takes on.
 *
 * ONE RULE, AND IT IS THE ONLY ONE THAT MAKES THE MERGE GUARANTEE WORK: what a user's action creates
 * or changes becomes theirs. `meta.source` exists so that re-running extraction can refuse to
 * overwrite `user` elements, and that promise is worth exactly as much as the set of elements it
 * covers.
 *
 * WHY NOT `derived` FOR A SPLIT CORNER, which is the tempting reading — the coordinates were
 * computed, by projecting a tap onto a wall centreline, so surely code decided them? No: code
 * decided the coordinates, but the USER decided that there is a corner there at all. Every corner in
 * this editor is snapped and rounded on its way in, and none of that makes it less the user's. The
 * test is not "did arithmetic touch this value" but "would regenerating it destroy a decision
 * somebody made", and here it plainly would: a later extraction pass that felt free to move or
 * delete this corner would take the partition wall hanging off it along too.
 *
 * `derived` is for an element the app can recompute from scratch and that embodies no decision of
 * anyone's. Nothing in the editor produces one.
 *
 * The same rule applies to BOTH HALVES of a split wall, including the original, and that is the part
 * worth spelling out. Leaving them `auto` would let extraction replace them with the uncut wall it
 * originally found — undoing the split, and stranding the `user` corner between two walls that no
 * longer meet it. A `user` corner between `auto` walls is not a consistent document; it is the
 * clobbering this field exists to prevent, arriving one indirection later. The cost is that a wall
 * the user split stops being shaded as doubtful even though they never checked its thickness, and
 * that is the right trade: they have looked at it and acted on it, so it is no longer a place they
 * need to be sent back to.
 */
const AUTHORED: Meta = { source: 'user', confidence: 1 };

import type { Level, Meta, Opening, PlanNode, Wall } from '../plan/schema';
import { distance, normalise, subtract, type Point } from './plan-space';
import { NODE_MERGE_TOLERANCE_MM } from '../plan/validate';
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
   *
   * `meta` is carried here rather than left to the caller because provenance is part of the edit,
   * not part of applying it — see `AUTHORED`.
   */
  shortened: { wall: string; b: string; meta: Meta };
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
    meta: { ...AUTHORED },
  };

  const addedWall: Wall = {
    id: ids.wall,
    a: node.id,
    b: wall.b,
    // The far half is the same piece of building as the near half: same thickness, same height. Its
    // PROVENANCE is not inherited, though — see `AUTHORED`.
    thicknessMm: wall.thicknessMm,
    heightMm: wall.heightMm,
    meta: { ...AUTHORED },
  };

  return {
    ok: true,
    split: {
      node,
      shortened: { wall: wall.id, b: node.id, meta: { ...AUTHORED } },
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
  /**
   * Followers that this move would leave with NO LENGTH AT ALL, because their far corner is already
   * sitting exactly where the moving one is headed.
   *
   * Reported rather than discovered afterwards. `validate` would of course catch it — it is
   * `WALL_ZERO_LENGTH`, an error — but catching it afterwards defeats the entire point of previewing
   * the change: the user would type a length, watch a wall silently vanish, and then be told about
   * it by a panel somewhere else on screen. A preview that only shows the good outcome is not a
   * preview.
   *
   * It does not make the change impossible, and it deliberately does not. A broken document is a
   * normal, repairable input everywhere else in this editor, refusing would leave no way to say "yes,
   * I know, that stub is going anyway", and the collapsed wall stays reachable — tapping its issue
   * selects it, which is how it gets deleted.
   */
  collapsing: readonly string[];
  /**
   * Other corners the moved one would land within `NODE_MERGE_TOLERANCE_MM` of — the
   * `NODES_NEARLY_COINCIDENT` case.
   *
   * Two corners a few millimetres apart are one corner that failed to merge, and no amount of mitring
   * repairs it because the walls genuinely do not meet. It is the quietest bug in the whole document:
   * invisible at any sane zoom in the 2D plan, and a hairline gap in the 3D shell.
   *
   * Exact coincidence is NOT reported, matching the validator: two corners at exactly the same point
   * do meet, so the geometry is redundant rather than wrong.
   *
   * WALL_TOO_SHORT is deliberately not previewed alongside these two. Someone typing 90mm into a
   * length field usually means 90mm, and a warning that fires on a deliberate act is how people are
   * trained to dismiss warnings without reading them — which would cost us the two above, where the
   * user really did not mean it.
   */
  nearlyCoincident: readonly { node: string; distanceMm: number }[];
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

  // The resized wall itself can never come out zero-length, and it is worth knowing why rather than
  // guarding for it: `to` would have to round onto `fixed`, which needs both components of
  // `direction * lengthMm` to be under half a millimetre. The longer component of a unit vector is
  // at least 0.707, so that needs a length below 0.71mm — and lengths at or below zero are already
  // refused above, while the field only ever produces whole millimetres.
  const direction = normalise(along);
  const to: Point = {
    x: Math.round(fixed.x + direction.x * lengthMm),
    y: Math.round(fixed.y + direction.y * lengthMm),
  };

  const followers: string[] = [];
  const collapsing: string[] = [];
  for (const other of level.walls) {
    if (other.id === wall.id) continue;
    const farId = other.a === mover.id ? other.b : other.b === mover.id ? other.a : null;
    if (farId === null) continue;
    followers.push(other.id);

    // Exact integer comparison, not a distance under some epsilon. Both the far corner's stored
    // coordinates and `to` are whole millimetres, so "lands on the same point" is a question with a
    // yes-or-no answer, the same way every comparison in `validate` is.
    const far = nodeById.get(farId);
    if (far !== undefined && far.x === to.x && far.y === to.y) collapsing.push(other.id);
  }

  const nearlyCoincident: { node: string; distanceMm: number }[] = [];
  const toleranceSq = NODE_MERGE_TOLERANCE_MM * NODE_MERGE_TOLERANCE_MM;
  for (const other of level.nodes) {
    // The moving corner is excluded against ITSELF: its stored coordinates are still where it is
    // now, so a small length change would otherwise have it report itself as its own near neighbour.
    // The fixed end is NOT excluded — a wall short enough for its own two ends to land within 5mm of
    // each other is exactly the mistake worth catching.
    if (other.id === mover.id) continue;
    const dx = other.x - to.x;
    const dy = other.y - to.y;
    const dSq = dx * dx + dy * dy;
    if (dSq === 0 || dSq >= toleranceSq) continue;
    // Integers in, integers squared: the decision is exact. The square root is display only, and
    // rounded, because "3.606mm" helps nobody.
    nearlyCoincident.push({ node: other.id, distanceMm: Math.round(Math.sqrt(dSq)) });
  }

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
      collapsing,
      nearlyCoincident,
    },
  };
}
