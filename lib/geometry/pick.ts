/**
 * lib/geometry/pick.ts — what is under the pointer, and where the pointer actually meant.
 *
 * Two jobs, and they are the same job seen from both ends. HIT TESTING answers "the user touched
 * here; which corner or which wall did they mean?". SNAPPING answers "the user is placing a point
 * here; where does it really belong?". Both are pure arithmetic over plan millimetres, both are
 * tested headlessly, and neither knows that React or an SVG exists.
 *
 * EVERY RADIUS ARRIVES IN MILLIMETRES, and the caller is responsible for converting it from screen
 * pixels using the current zoom. That is deliberate: a fixed millimetre radius feels broken at both
 * ends of the zoom range — zoomed out, a 200mm radius covers half a room and every tap grabs
 * something; zoomed in, it is a tenth of a pixel and nothing is ever grabbable. A fixed *pixel*
 * radius is the thing that stays constant under the user's hand. Converting here rather than in the
 * caller would mean this file has to know about the camera, which is editor state, which is exactly
 * the coupling that keeps geometry untestable.
 *
 * Pure. No React, no three.js, no document mutation.
 */

import type { Level, PlanNode, Wall } from '../plan/schema';
import { distance, dot, subtract, type Point } from './plan-space';

/* ------------------------------------------------------------------------------------------------
 * Indexing
 * ---------------------------------------------------------------------------------------------- */

/** Node id -> node. Built once per pointer event rather than once per candidate wall. */
export function indexNodes(nodes: readonly PlanNode[]): Map<string, PlanNode> {
  return new Map(nodes.map((n) => [n.id, n]));
}

/** The two ends of a wall, or `null` if either reference dangles. `validate` reports the dangle. */
export function wallEnds(
  nodeById: ReadonlyMap<string, PlanNode>,
  wall: Wall,
): { a: PlanNode; b: PlanNode } | null {
  const a = nodeById.get(wall.a);
  const b = nodeById.get(wall.b);
  return a === undefined || b === undefined ? null : { a, b };
}

/**
 * Length of a wall in millimetres, rounded.
 *
 * ROUNDED, and only ever for display or for a length the user is about to type over. Anything that
 * DECIDES something compares squared distances, which for integer millimetre coordinates is exact
 * integer arithmetic — the same rule `validate` follows, for the same reason.
 */
export function wallLengthMm(nodeById: ReadonlyMap<string, PlanNode>, wall: Wall): number | null {
  const ends = wallEnds(nodeById, wall);
  return ends === null ? null : Math.round(distance(ends.a, ends.b));
}

/* ------------------------------------------------------------------------------------------------
 * Hit testing
 * ---------------------------------------------------------------------------------------------- */

export interface NodeHit {
  node: PlanNode;
  distanceMm: number;
}

export interface WallHit {
  wall: Wall;
  /** Perpendicular distance from the query point to the wall's centreline. */
  distanceMm: number;
  /** Distance along the wall from node `a` to the closest point. Clamped into [0, length]. */
  alongMm: number;
  /** The closest point on the centreline itself. Not rounded — callers that store it must round. */
  point: Point;
}

/**
 * The nearest corner to `at`, if one is within `radiusMm`.
 *
 * Linear over the level's corners. A flat has tens to low hundreds of them and this runs on
 * pointermove; rbush is already a dependency for the solver's broad phase and is the answer if a
 * plan ever appears where this is measurable, but the indirection is not worth it before then.
 */
export function nearestNode(
  nodes: readonly PlanNode[],
  at: Point,
  radiusMm: number,
): NodeHit | null {
  let best: NodeHit | null = null;
  const radiusSq = radiusMm * radiusMm;

  for (const node of nodes) {
    const dx = node.x - at.x;
    const dy = node.y - at.y;
    const dSq = dx * dx + dy * dy;
    if (dSq > radiusSq) continue;
    if (best !== null && dSq >= best.distanceMm * best.distanceMm) continue;
    best = { node, distanceMm: Math.sqrt(dSq) };
  }
  return best;
}

/**
 * The closest point on the segment `a` -> `b` to `at`.
 *
 * Clamped to the segment, so a point off the end of a wall reports the end rather than a position
 * on the infinite line — otherwise "draw onto this wall" would split it at a node 3 metres past its
 * own corner.
 */
export interface Projection {
  /** The closest point on the segment. Not rounded — a caller that stores it must round it. */
  point: Point;
  /** Distance along the segment from `a`, in millimetres. */
  alongMm: number;
  /** Perpendicular distance from the query point. */
  distanceMm: number;
}

export function projectOntoSegment(a: Point, b: Point, at: Point): Projection {
  const along = subtract(b, a);
  const lengthSq = dot(along, along);
  if (lengthSq === 0) return { point: { x: a.x, y: a.y }, alongMm: 0, distanceMm: distance(at, a) };

  const t = Math.max(0, Math.min(1, dot(subtract(at, a), along) / lengthSq));
  const point = { x: a.x + along.x * t, y: a.y + along.y * t };
  return { point, alongMm: t * Math.sqrt(lengthSq), distanceMm: distance(at, point) };
}

/** The nearest wall centreline to `at`, if one passes within `radiusMm`. */
export function nearestWall(
  level: Pick<Level, 'walls' | 'nodes'>,
  at: Point,
  radiusMm: number,
  nodeById: ReadonlyMap<string, PlanNode> = indexNodes(level.nodes),
  ignoreNodes?: ReadonlySet<string>,
): WallHit | null {
  let best: WallHit | null = null;

  for (const wall of level.walls) {
    if (ignoreNodes?.has(wall.a) === true || ignoreNodes?.has(wall.b) === true) continue;
    const ends = wallEnds(nodeById, wall);
    if (ends === null) continue;

    const hit = projectOntoSegment(ends.a, ends.b, at);
    if (hit.distanceMm > radiusMm) continue;
    if (best !== null && hit.distanceMm >= best.distanceMm) continue;
    best = { wall, distanceMm: hit.distanceMm, alongMm: hit.alongMm, point: hit.point };
  }
  return best;
}

/* ------------------------------------------------------------------------------------------------
 * Angle snapping
 * ---------------------------------------------------------------------------------------------- */

export type Axis = 'horizontal' | 'vertical';

/**
 * How far off square a segment may be and still be pulled square.
 *
 * Generous, because near-axis is nearly always what was intended in a flat, and because the snap
 * announces itself with a guide line — an invisible snap would be indistinguishable from a bug, but
 * a visible one that is occasionally unwanted costs a toggle press.
 */
export const ANGLE_SNAP_TOLERANCE_DEG = 5;

export interface AxisSnap {
  point: Point;
  /** The axis that was applied, or `null` if the raw point was too far off square to snap. */
  axis: Axis | null;
}

/**
 * Pull `raw` onto the nearest multiple of 90 degrees from `anchor`, if it is close enough.
 *
 * PROJECTION, not rotation: the point slides sideways onto the guide and keeps its distance ALONG
 * the guide. Rotating it — keeping the length and changing the angle — would slide the point up and
 * down the guide as well, which reads as the drawing fighting back.
 *
 * With only four axes the projection is exact and needs no trigonometry: onto a horizontal guide,
 * the snapped point is simply (raw.x, anchor.y). Integers in, integers out, which matters because
 * this result becomes a node coordinate.
 *
 * The tolerance test is the same idea. The deviation from the nearer axis is
 * atan(shorter / longer), so "within `toleranceDeg`" is `shorter <= longer * tan(tolerance)` — one
 * multiplication, no atan2, and no ambiguity at the 45 degree tie where neither axis wins.
 */
export function snapToAxis(
  anchor: Point,
  raw: Point,
  toleranceDeg: number = ANGLE_SNAP_TOLERANCE_DEG,
): AxisSnap {
  const dx = raw.x - anchor.x;
  const dy = raw.y - anchor.y;
  if (dx === 0 && dy === 0) return { point: raw, axis: null };

  const acrossX = Math.abs(dx);
  const acrossY = Math.abs(dy);
  const tolerance = Math.tan((toleranceDeg * Math.PI) / 180);

  if (acrossX >= acrossY) {
    if (acrossY > acrossX * tolerance) return { point: raw, axis: null };
    return { point: { x: raw.x, y: anchor.y }, axis: 'horizontal' };
  }
  if (acrossX > acrossY * tolerance) return { point: raw, axis: null };
  return { point: { x: anchor.x, y: raw.y }, axis: 'vertical' };
}

/**
 * Where an axis guide through `anchor` crosses the segment `a` -> `b`, or `null` if it misses.
 *
 * Exported because it is the interesting half of `snapPointer`: when the user is drawing square
 * onto an existing wall, the honest answer is the point where the guide meets that wall, not "on
 * the wall, roughly square" or "square, roughly on the wall". Both approximations are wrong by up
 * to the snap radius, and this is exact.
 */
export function axisGuideCrossing(anchor: Point, axis: Axis, a: Point, b: Point): Point | null {
  if (axis === 'horizontal') {
    if (a.y === b.y) return null; // Guide is parallel to the wall: no single crossing.
    const t = (anchor.y - a.y) / (b.y - a.y);
    if (t < 0 || t > 1) return null;
    return { x: a.x + (b.x - a.x) * t, y: anchor.y };
  }
  if (a.x === b.x) return null;
  const t = (anchor.x - a.x) / (b.x - a.x);
  if (t < 0 || t > 1) return null;
  return { x: anchor.x, y: a.y + (b.y - a.y) * t };
}

/* ------------------------------------------------------------------------------------------------
 * The one call the editor makes
 * ---------------------------------------------------------------------------------------------- */

/**
 * The corners at the far ends of every wall attached to `nodeId`.
 *
 * These are the anchors a corner being DRAGGED squares up against: dragging a corner is exactly the
 * operation "make this wall horizontal", and the wall in question is any of the ones attached.
 */
export function neighbourPoints(
  level: Pick<Level, 'walls' | 'nodes'>,
  nodeId: string,
): Point[] {
  const nodeById = indexNodes(level.nodes);
  const points: Point[] = [];
  for (const wall of level.walls) {
    const otherId = wall.a === nodeId ? wall.b : wall.b === nodeId ? wall.a : null;
    if (otherId === null) continue;
    const other = nodeById.get(otherId);
    if (other !== undefined) points.push({ x: other.x, y: other.y });
  }
  return points;
}

export interface SnapSettings {
  /** Grab radius, in plan millimetres. Convert from screen pixels at the call site. */
  radiusMm: number;
  /** Snap to existing corners. */
  nodes: boolean;
  /** Snap to 90 degrees from `anchor`. Needs an anchor; ignored while there is none. */
  angle: boolean;
  /**
   * Land exactly on a wall centreline when one passes under the finger.
   *
   * Strictly this is not one of the two snaps the editor's toggle names — it is how "draw onto this
   * wall and split it" is expressed. It is switched by the same toggle anyway, because the promise
   * of turning snapping off is that the point goes precisely where it was put, and a point silently
   * pulled onto a wall it was merely near breaks that promise as thoroughly as a corner snap would.
   * With snapping off, nothing joins to anything.
   */
  walls: boolean;
  toleranceDeg?: number;
  /**
   * Corners to pretend are not there, and walls to ignore for having an end among them.
   *
   * This is what a DRAG needs. The corner being dragged has already been moved to the pointer, so
   * without this it is the nearest corner to itself, snaps to where it already is, and the drag
   * jams — the corner sticks at the first position it reached and no amount of further movement
   * frees it. Its own walls have to go too: their centrelines run under the pointer for the whole
   * drag, so the corner would be pulled onto the wall it is an end of.
   */
  ignoreNodes?: ReadonlySet<string>;
}

export interface Snapped {
  /** Integer millimetres, ready to become a node coordinate. */
  point: Point;
  /** The exact corner the point became, if it snapped to one. */
  node: PlanNode | null;
  /** The wall the point lies on, when it did not land on a corner. */
  wall: WallHit | null;
  /** The guide that was applied, for the editor to draw. `null` means no angle snap happened. */
  axis: Axis | null;
  /** Which anchor the guide runs through, so the editor draws it in the right place. */
  guideFrom: Point | null;
}

/**
 * Resolve a raw pointer position in plan millimetres into the point the user meant.
 *
 * PRIORITY, and the order is the whole design:
 *
 *   1. An existing corner wins outright, and the result is that corner's EXACT coordinates. This is
 *      what stops two corners landing 3mm apart and silently breaking a room loop — the
 *      `NODES_NEARLY_COINCIDENT` warning the validator already reports is the symptom of not doing
 *      this, and no amount of mitring repairs it, because the two walls genuinely do not meet.
 *   2. Otherwise, square up against `anchor` if it is close to square.
 *   3. Otherwise (and as well), if a wall passes under the finger, land exactly on its centreline —
 *      because the caller is about to split that wall there, and a split node that is 4mm off the
 *      line it was cut from puts a visible kink in a straight wall.
 *
 * 2 and 3 can both apply, and then the answer is where the guide crosses the wall, which satisfies
 * both exactly. When the guide misses the wall — it runs parallel to it, or crosses beyond its end
 * — being ON the wall matters more than being square to the last corner, so the guide is dropped
 * and reported as dropped. Silently keeping the flag would draw a guide line the point is not on.
 */
export function snapPointer(
  level: Pick<Level, 'walls' | 'nodes'>,
  at: Point,
  anchors: readonly Point[],
  settings: SnapSettings,
): Snapped {
  const nodeById = indexNodes(level.nodes);
  const ignore = settings.ignoreNodes;

  if (settings.nodes) {
    const candidates =
      ignore === undefined ? level.nodes : level.nodes.filter((n) => !ignore.has(n.id));
    const hit = nearestNode(candidates, at, settings.radiusMm);
    if (hit !== null) {
      return {
        point: { x: hit.node.x, y: hit.node.y },
        node: hit.node,
        wall: null,
        axis: null,
        guideFrom: null,
      };
    }
  }

  const squared = settings.angle ? bestAxisSnap(anchors, at, settings.toleranceDeg) : null;
  const squaredPoint = squared?.point ?? at;

  // The wall search uses the RAW point: that is where the finger is, and it is what the user is
  // pointing at. Searching from the squared point would let a long guide reach out and grab a wall
  // metres away from anything they touched.
  const wall = settings.walls ? nearestWall(level, at, settings.radiusMm, nodeById, ignore) : null;
  if (wall === null) {
    return {
      point: round(squaredPoint),
      node: null,
      wall: null,
      axis: squared?.axis ?? null,
      guideFrom: squared?.from ?? null,
    };
  }

  const ends = wallEnds(nodeById, wall.wall);
  if (squared !== null && ends !== null) {
    const crossing = axisGuideCrossing(squared.from, squared.axis, ends.a, ends.b);
    if (crossing !== null && distance(crossing, at) <= settings.radiusMm) {
      const along = projectOntoSegment(ends.a, ends.b, crossing);
      return {
        point: round(crossing),
        node: null,
        wall: { ...wall, alongMm: along.alongMm, distanceMm: 0, point: crossing },
        axis: squared.axis,
        guideFrom: squared.from,
      };
    }
  }

  return { point: round(wall.point), node: null, wall, axis: null, guideFrom: null };
}

/**
 * The best 90 degree snap across several anchors.
 *
 * Drawing has one anchor — the last corner placed. DRAGGING has as many as the corner has walls,
 * because "square this corner up" means squaring it against any one of them, and the user is
 * thinking of whichever wall they are watching. Best is the one that moves the point LEAST: the
 * nearest guide is the one being aimed at.
 */
function bestAxisSnap(
  anchors: readonly Point[],
  at: Point,
  toleranceDeg?: number,
): { point: Point; axis: Axis; from: Point } | null {
  let best: { point: Point; axis: Axis; from: Point } | null = null;
  let bestMoved = Infinity;

  for (const anchor of anchors) {
    const snapped = snapToAxis(anchor, at, toleranceDeg);
    if (snapped.axis === null) continue;
    const moved = distance(snapped.point, at);
    if (moved >= bestMoved) continue;
    bestMoved = moved;
    best = { point: snapped.point, axis: snapped.axis, from: anchor };
  }
  return best;
}

/**
 * To integer millimetres, the only coordinates the document can hold.
 *
 * Note what this costs on a diagonal wall: a point rounded off a sloping centreline lands up to half
 * a millimetre beside it. That is correct and expected — the document is integers by construction —
 * and it is below anything a carpenter acts on. On the axis-aligned walls that make up almost every
 * flat, nothing is lost at all.
 */
function round(p: Point): Point {
  return { x: Math.round(p.x), y: Math.round(p.y) };
}
