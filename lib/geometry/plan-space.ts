/**
 * lib/geometry/plan-space.ts — the shared vocabulary for plan space.
 *
 * Plan space is the coordinate system the document lives in: x increases east, y increases
 * DOWNWARD (south), matching SVG and screen coordinates so the 2D editor needs no flip. Distances
 * here are millimetres. The three.js boundary maps plan (x, y) to world (x, z) and is the only
 * place that changes.
 *
 * Pure arithmetic. No three.js, no React — this file must run in a plain Node test.
 *
 * A NOTE ON EXACTNESS, because it is the thing most likely to be misunderstood later. Every value
 * *stored in the document* is an integer number of millimetres. Values *derived* here are not:
 * a mitred corner is the intersection of two offset lines and lands wherever it lands, usually on
 * a fraction of a millimetre, and a node centreline offset by half a 115mm partition lands on a
 * half-millimetre. That is correct and expected. What follows from it is a rule: a derived
 * coordinate must never be used as a map key, an equality test or an identity. Node IDs are the
 * identity; coordinates are just numbers that come out of them.
 */

/** A point in plan space, in millimetres. Integer only when it came straight from the document. */
export interface Point {
  x: number;
  y: number;
}

export function add(p: Point, q: Point): Point {
  return { x: p.x + q.x, y: p.y + q.y };
}

export function subtract(p: Point, q: Point): Point {
  return { x: p.x - q.x, y: p.y - q.y };
}

export function scale(p: Point, k: number): Point {
  return { x: p.x * k, y: p.y * k };
}

export function dot(p: Point, q: Point): number {
  return p.x * q.x + p.y * q.y;
}

/**
 * The 2D cross product: the z component of the 3D cross product of two vectors in this plane.
 *
 * Zero exactly when the two vectors are parallel, which is how parallel-ness is detected in this
 * codebase — never by catching a division by zero, which conflates "these lines are parallel" with
 * "this arithmetic went wrong".
 */
export function cross(p: Point, q: Point): number {
  return p.x * q.y - p.y * q.x;
}

export function length(p: Point): number {
  return Math.hypot(p.x, p.y);
}

export function distance(p: Point, q: Point): number {
  return Math.hypot(p.x - q.x, p.y - q.y);
}

/** Unit vector in the same direction. Returns (0, 0) for a zero vector — callers must check first. */
export function normalise(p: Point): Point {
  const len = length(p);
  return len === 0 ? { x: 0, y: 0 } : { x: p.x / len, y: p.y / len };
}

/**
 * The left side of a direction, as a person walking along it would experience it, looking down at
 * the plan: for direction (dx, dy), left is (dy, -dx). Walking east, north is on your left.
 *
 * This is CLAUDE.md's rule 6, and this is the one place it is implemented. Every door swing, every
 * item anchor and every wall face in the app resolves through this function. Getting it backwards
 * would not produce an obvious failure — it would mirror the entire building consistently, which is
 * far harder to notice than a loud error.
 */
export function leftNormal(direction: Point): Point {
  return { x: direction.y, y: -direction.x };
}

/**
 * Twice the signed area of the triangle p -> q -> r. Positive means the same winding as a footprint
 * polygon produced by `wallFootprints`. Used for orientation questions; the doubling is kept
 * because halving it adds nothing and loses a little precision.
 */
export function turn(p: Point, q: Point, r: Point): number {
  return cross(subtract(q, p), subtract(r, p));
}

/** Signed area of a closed polygon, by the shoelace formula. Sign follows the winding. */
export function signedArea(polygon: readonly Point[]): number {
  let total = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const p = polygon[i];
    const q = polygon[(i + 1) % polygon.length];
    total += p.x * q.y - q.x * p.y;
  }
  return total / 2;
}

/** Millimetres per metre. */
export const MM_PER_M = 1000;

/**
 * The one conversion in the codebase.
 *
 * Everything upstream of the renderer — the document, the validator, the solver, the furniture
 * kernel — is integer millimetres. Only the three.js boundary calls this. If a second conversion
 * appears somewhere else, two parts of the app will disagree about how big the flat is, and the
 * disagreement will be a factor of 1000, which is unmistakable exactly once and baffling forever
 * after.
 */
export function toMetres(millimetres: number): number {
  return millimetres / MM_PER_M;
}
