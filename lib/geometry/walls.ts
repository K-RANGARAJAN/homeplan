/**
 * lib/geometry/walls.ts — turning centrelines into wall footprints, mitred at the junctions.
 *
 * THE PROBLEM. A wall is a centreline from node `a` to node `b` with a thickness, so the obvious
 * footprint is a rectangle: the centreline offset by half the thickness each way. Do that and every
 * junction is wrong. Two walls meeting at a corner overlap on the inside of the bend and leave a
 * wedge of nothing on the outside. A wall passing a T-junction leaves a notch. At any angle other
 * than 90 degrees the gap is worse. All of it is plainly visible the moment the walls stand up in
 * 3D, and no amount of later polish covers it.
 *
 * THE APPROACH. Junctions are solved per NODE, not per wall, because a wall cannot know where to
 * stop without knowing what it meets. At each node, every attached wall is sorted by the angle of
 * its direction *away* from that node. Each adjacent pair in that angular order brackets one corner
 * of the junction, and that corner is the intersection of two offset lines: the first wall's edge on
 * the side facing the gap, and the second wall's edge facing back. Walk the whole angular order and
 * every wall end comes away with two points, one per side — in general neither perpendicular to the
 * centreline nor symmetric about it.
 *
 * WHAT FILLS THE MIDDLE. Those corner points, taken in order, form a small polygon around the node.
 * At a corner (two walls) it collapses to a line and there is nothing to fill. At a T-junction or a
 * crossing it has real area, and it belongs to no wall — leave it and you have swapped a notch for a
 * triangular hole. So each wall meeting a junction of three or more also takes the node point itself
 * into its footprint, which fans that polygon into one triangle per wall: they tile it exactly, with
 * no overlap and no gap. This is why a footprint is a `Point[]` and not a quad — a wall between two
 * T-junctions has six points.
 *
 * Pure. No three.js, no React. Extrusion lives at the renderer boundary, not here.
 */

import type { Level, Wall } from '../plan/schema';
import {
  add,
  cross,
  dot,
  leftNormal,
  length,
  normalise,
  scale,
  subtract,
  turn,
  type Point,
} from './plan-space';

/**
 * How far a mitre may stick OUT past the node, as a multiple of the thicker wall at that junction.
 *
 * What this protects against: two walls that are nearly, but not exactly, in line with each other.
 * Their offset lines are then nearly parallel, and if the walls differ in thickness those lines are
 * also a little apart, so the point where they cross races off toward infinity — a 0.15 degree kink
 * between a 230mm wall and a 115mm one puts it 23 metres away. Rendered, that is a spike shooting
 * out of the building. Past the limit we stop mitring and let both walls end square (a bevel); the
 * sliver left between them is smaller than the limit permits and invisible.
 *
 * 4 is SVG's default stroke-miterlimit, and this is the same quantity: how long a spike is allowed
 * to get before it stops being a corner.
 *
 * It deliberately does NOT apply to a corner that cuts BACK into both walls. See `solveCorner`.
 */
export const MITER_LIMIT = 4;

/** One wall as seen from one of its nodes: which way it leaves, and how wide it is. */
interface Incident {
  wallId: string;
  /** Unit vector pointing away from this node, along the wall. */
  dir: Point;
  halfMm: number;
  thicknessMm: number;
  angle: number;
}

/** The two points where one wall end meets the junction, named for the wall's own left and right. */
interface WallEnd {
  left: Point;
  right: Point;
}

/**
 * Keys for the per-(wall, node) results.
 *
 * Composed from two document IDs, never from coordinates — a derived coordinate is a fraction of a
 * millimetre and must never be an identity.
 */
const endKey = (wallId: string, nodeId: string): string => `${wallId}|${nodeId}`;

/**
 * Footprints for every wall on a level, keyed by wall ID.
 *
 * Walls whose nodes are missing from the level, and walls with no length or direction, are skipped
 * rather than throwing: `validate` already reports both as errors, and a document with one broken
 * wall must still show the other twenty-four. A viewport that refuses to draw anything because one
 * reference is dangling is a viewport you cannot use to fix the dangling reference.
 */
export function wallFootprints(level: Level): Map<string, Point[]> {
  const nodeById = new Map(level.nodes.map((n) => [n.id, n]));

  const usable: Wall[] = [];
  const incidentsByNode = new Map<string, Incident[]>();

  for (const wall of level.walls) {
    const a = nodeById.get(wall.a);
    const b = nodeById.get(wall.b);
    if (a === undefined || b === undefined) continue;

    const along = subtract(b, a);
    if (along.x === 0 && along.y === 0) continue; // No direction: nothing here is defined.

    const dir = normalise(along);
    const halfMm = wall.thicknessMm / 2;

    usable.push(wall);
    pushIncident(incidentsByNode, wall.a, {
      wallId: wall.id,
      dir,
      halfMm,
      thicknessMm: wall.thicknessMm,
      angle: Math.atan2(dir.y, dir.x),
    });
    const back = scale(dir, -1);
    pushIncident(incidentsByNode, wall.b, {
      wallId: wall.id,
      dir: back,
      halfMm,
      thicknessMm: wall.thicknessMm,
      angle: Math.atan2(back.y, back.x),
    });
  }

  // Solve every junction, then hand the results back to the walls that meet there.
  const ends = new Map<string, WallEnd>();
  const degreeByNode = new Map<string, number>();

  for (const [nodeId, incidents] of incidentsByNode) {
    const node = nodeById.get(nodeId);
    if (node === undefined) continue;
    degreeByNode.set(nodeId, incidents.length);

    // Angular order is what makes "adjacent pair" mean anything. With one wall the pair is the wall
    // with itself, whose edges are parallel, so a dead end falls out of the same code as a square
    // butt end rather than needing a case of its own.
    const ordered = [...incidents].sort((p, q) => p.angle - q.angle);

    for (let i = 0; i < ordered.length; i += 1) {
      const first = ordered[i];
      const second = ordered[(i + 1) % ordered.length];
      const corner = solveCorner(node, first, second);

      // The gap runs from `first` towards `second` in increasing angle. Increasing angle is a wall's
      // right side and decreasing is its left, so this corner is the right end of `first` and the
      // left end of `second`.
      setEnd(ends, first.wallId, nodeId, 'right', corner.forFirst);
      setEnd(ends, second.wallId, nodeId, 'left', corner.forSecond);
    }
  }

  const footprints = new Map<string, Point[]>();
  for (const wall of usable) {
    const rawA = ends.get(endKey(wall.id, wall.a));
    const rawB = ends.get(endKey(wall.id, wall.b));
    const a = nodeById.get(wall.a);
    const b = nodeById.get(wall.b);
    if (rawA === undefined || rawB === undefined || a === undefined || b === undefined) continue;

    // Neither end may eat past the middle of the wall. This is the only thing stopping a short wall
    // between two junctions from turning inside out, and it has to happen here rather than in
    // `solveCorner`, because a corner is shared by two walls of different lengths and each one's
    // limit is its own.
    const towardsB = normalise(subtract(b, a));
    const halfLengthMm = length(subtract(b, a)) / 2;
    const atA = clampRetreat(rawA, a, towardsB, halfLengthMm);
    const atB = clampRetreat(rawB, b, scale(towardsB, -1), halfLengthMm);

    // Round the wall: down its left side, across the far end, back up its right side, across the
    // near end. At node `b` the wall's left side is that end's `right` field, because "left" there
    // is measured against the direction pointing back towards `a`.
    const polygon: Point[] = [atA.left];
    polygon.push(atB.right);
    if (fills(degreeByNode.get(wall.b) ?? 0, atB, b)) polygon.push({ x: b.x, y: b.y });
    polygon.push(atB.left);
    polygon.push(atA.right);
    if (fills(degreeByNode.get(wall.a) ?? 0, atA, a)) polygon.push({ x: a.x, y: a.y });

    footprints.set(wall.id, polygon);
  }

  return footprints;
}

function pushIncident(map: Map<string, Incident[]>, nodeId: string, incident: Incident): void {
  const list = map.get(nodeId) ?? [];
  list.push(incident);
  map.set(nodeId, list);
}

function setEnd(ends: Map<string, WallEnd>, wallId: string, nodeId: string, side: 'left' | 'right', point: Point): void {
  const key = endKey(wallId, nodeId);
  const existing = ends.get(key) ?? { left: point, right: point };
  ends.set(key, { ...existing, [side]: point });
}

/**
 * Pull an end's points back so neither cuts more than half way along the wall.
 *
 * A junction retreats the wall it meets: a 230mm partition branching off makes the wall beside it
 * end 115mm short on that side. Put two of those on a 150mm wall and the two ends have each eaten
 * 115mm of a 150mm wall — they cross, and the footprint folds into a bowtie, which renders as a
 * wall with a twist in it. Meeting exactly in the middle is the worst this can now do, and the
 * small wedge it leaves against the neighbouring wall is invisible at that scale.
 *
 * `away` points from this node along the wall, so a positive component means "into the wall".
 * Points that stick out past the node are left alone; those are the mitre limit's business.
 */
function clampRetreat(end: WallEnd, node: Point, away: Point, halfLengthMm: number): WallEnd {
  const pull = (point: Point): Point => {
    const into = dot(subtract(point, node), away);
    return into > halfLengthMm ? subtract(point, scale(away, into - halfLengthMm)) : point;
  };
  return { left: pull(end.left), right: pull(end.right) };
}

/**
 * Should this wall also swallow the node point itself?
 *
 * Only at a junction of three or more, where the corner points leave a polygon around the node with
 * real area. Below that the node already sits on the line between the wall's two end points — it is
 * their exact midpoint — so adding it would insert a collinear vertex for nothing.
 *
 * The `turn` guard is the safety catch: it asks whether the node actually lies beyond the end, on
 * the outward side. In a lopsided junction it might not, and fanning to a point behind the end would
 * fold the polygon over itself.
 */
function fills(degree: number, end: WallEnd, node: Point): boolean {
  return degree >= 3 && turn(end.right, node, end.left) > 0;
}

/**
 * One corner of a junction: where the right edge of `first` meets the left edge of `second`.
 *
 * Both walls normally share the single point, which is what makes a mitre a mitre. They get separate
 * square-cut points when the offset lines are exactly parallel — collinear walls, detected by the
 * cross product being zero, never by a division blowing up — or when the mitre limit rejects the
 * intersection.
 *
 * THE LIMIT ONLY APPLIES TO CORNERS THAT STICK OUT. A corner point sits either past the node, on
 * the far side from the wall's body, or back inside the wall. Those two look identical to a
 * distance-from-the-node test and are opposite problems:
 *
 *   - Sticking out is the spike. Two walls that nearly continue each other but differ in thickness
 *     throw their intersection tens of metres clear of the building. Reject it.
 *   - Cutting back in is a sliver: two walls leaving one node 8 degrees apart genuinely occupy the
 *     same brickwork for the first metre and a half, and the far-away intersection is exactly where
 *     they stop doing that. Reject it and both walls end square, sitting inside one another — the
 *     overlap the mitre existed to remove. Accept it; `clampRetreat` bounds it by the wall's own
 *     length, which is the right bound for a cut, as the limit is for a spike.
 *
 * A corner that runs backwards for one wall and forwards for the other is the near-collinear case,
 * and it is the spike.
 */
function solveCorner(node: Point, first: Incident, second: Incident): { forFirst: Point; forSecond: Point } {
  const rightOfFirst = add(node, scale(leftNormal(first.dir), -first.halfMm));
  const leftOfSecond = add(node, scale(leftNormal(second.dir), second.halfMm));
  const butt = { forFirst: rightOfFirst, forSecond: leftOfSecond };

  const denominator = cross(first.dir, second.dir);
  if (denominator === 0) return butt;

  const along = cross(subtract(leftOfSecond, rightOfFirst), second.dir) / denominator;
  const point = add(rightOfFirst, scale(first.dir, along));
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return butt;

  const fromNode = subtract(point, node);
  const sticksOut = dot(fromNode, first.dir) < 0 || dot(fromNode, second.dir) < 0;
  const limitMm = MITER_LIMIT * Math.max(first.thicknessMm, second.thicknessMm);
  if (sticksOut && length(fromNode) > limitMm) return butt;

  return { forFirst: point, forSecond: point };
}
