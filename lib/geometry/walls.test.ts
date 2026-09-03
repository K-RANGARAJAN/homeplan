/**
 * Tests for wall footprints and mitering.
 *
 * This is arithmetic, so it is tested numerically and headlessly — no renderer, no browser. Where
 * the geometry is exact, the expected coordinates are HAND-COMPUTED and written as literals. A test
 * that derives its expectation the way the implementation does would pass just as happily with the
 * implementation wrong, which is the failure mode that matters here: a mitre bug does not throw, it
 * quietly draws a slightly wrong building.
 */

import { describe, expect, test } from 'vitest';

import type { Level, Meta } from '../plan/schema';
import { sampleFlat } from '../plan/sample';
import { distance, signedArea, subtract, dot, type Point } from './plan-space';
import { MITER_LIMIT, wallFootprints } from './walls';

/* --- Fixtures --------------------------------------------------------------------------------- */

const meta: Meta = { source: 'user', confidence: 1 };

type NodeSpec = [id: string, x: number, y: number];
type WallSpec = [id: string, a: string, b: string, thicknessMm: number];

function makeLevel(nodes: NodeSpec[], walls: WallSpec[]): Level {
  return {
    id: 'l0',
    name: 'Test',
    elevationMm: 0,
    nodes: nodes.map(([id, x, y]) => ({ id, x, y, meta })),
    walls: walls.map(([id, a, b, thicknessMm]) => ({ id, a, b, thicknessMm, heightMm: 2900, meta })),
    openings: [],
    rooms: [],
    items: [],
    meta,
  };
}

/** Footprint of one wall, or a failing assertion if it is missing. */
function footprint(level: Level, wallId: string): Point[] {
  const found = wallFootprints(level).get(wallId);
  expect(found).toBeDefined();
  return found ?? [];
}

/* --- Test-only geometry helpers ----------------------------------------------------------------
 * Deliberately naive and independent of the implementation: this is the second opinion.
 * ---------------------------------------------------------------------------------------------- */

/** Ray casting. Points exactly on the boundary are undefined; the tests avoid sampling there. */
function contains(polygon: readonly Point[], p: Point): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    if (a.y > p.y !== b.y > p.y) {
      const crossingX = a.x + ((p.y - a.y) / (b.y - a.y)) * (b.x - a.x);
      if (p.x < crossingX) inside = !inside;
    }
  }
  return inside;
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const ab = subtract(b, a);
  const lengthSq = dot(ab, ab);
  if (lengthSq === 0) return distance(p, a);
  const t = Math.max(0, Math.min(1, dot(subtract(p, a), ab) / lengthSq));
  return distance(p, { x: a.x + ab.x * t, y: a.y + ab.y * t });
}

function distanceToBoundary(polygon: readonly Point[], p: Point): number {
  let best = Infinity;
  for (let i = 0; i < polygon.length; i += 1) {
    best = Math.min(best, distanceToSegment(p, polygon[i], polygon[(i + 1) % polygon.length]));
  }
  return best;
}

/** Inside, and not merely touching the edge. Shared edges between neighbours are not overlap. */
function deeplyInside(polygon: readonly Point[], p: Point, marginMm: number): boolean {
  return contains(polygon, p) && distanceToBoundary(polygon, p) > marginMm;
}

function segmentsCross(p1: Point, p2: Point, q1: Point, q2: Point): boolean {
  const orient = (a: Point, b: Point, c: Point): number =>
    Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
  const d1 = orient(p1, p2, q1);
  const d2 = orient(p1, p2, q2);
  const d3 = orient(q1, q2, p1);
  const d4 = orient(q1, q2, p2);
  return d1 !== d2 && d3 !== d4 && d1 !== 0 && d2 !== 0 && d3 !== 0 && d4 !== 0;
}

/** No two non-adjacent edges cross: the polygon does not fold over itself. */
function isSimple(polygon: readonly Point[]): boolean {
  const n = polygon.length;
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue; // adjacent edges share a vertex
      if (segmentsCross(polygon[i], polygon[(i + 1) % n], polygon[j], polygon[(j + 1) % n])) return false;
    }
  }
  return true;
}

const area = (polygon: readonly Point[]): number => Math.abs(signedArea(polygon));

/**
 * Sampled rather than clipped: take a grid over the two polygons' shared bounding box and require
 * no sample to be a millimetre inside BOTH. Touching along a shared edge is not overlap, which is
 * what the margin is for.
 */
function expectNoOverlap(idA: string, polyA: readonly Point[], idB: string, polyB: readonly Point[]): void {
  const marginMm = 1;
  const boxA = boundingBox(polyA);
  const boxB = boundingBox(polyB);
  const minX = Math.max(boxA.minX, boxB.minX);
  const maxX = Math.min(boxA.maxX, boxB.maxX);
  const minY = Math.max(boxA.minY, boxB.minY);
  const maxY = Math.min(boxA.maxY, boxB.maxY);
  if (minX >= maxX || minY >= maxY) return;

  const steps = 24;
  for (let sx = 0; sx <= steps; sx += 1) {
    for (let sy = 0; sy <= steps; sy += 1) {
      const p = { x: minX + ((maxX - minX) * sx) / steps, y: minY + ((maxY - minY) * sy) / steps };
      const both = deeplyInside(polyA, p, marginMm) && deeplyInside(polyB, p, marginMm);
      expect(both, `${idA} and ${idB} overlap at (${p.x}, ${p.y})`).toBe(false);
    }
  }
}

function boundingBox(points: readonly Point[]): { minX: number; maxX: number; minY: number; maxY: number } {
  return {
    minX: Math.min(...points.map((p) => p.x)),
    maxX: Math.max(...points.map((p) => p.x)),
    minY: Math.min(...points.map((p) => p.y)),
    maxY: Math.max(...points.map((p) => p.y)),
  };
}

/* --- One wall --------------------------------------------------------------------------------- */

test('a wall on its own is a plain rectangle with square ends', () => {
  const level = makeLevel(
    [
      ['n1', 0, 0],
      ['n2', 4000, 0],
    ],
    [['w1', 'n1', 'n2', 230]],
  );

  // 4000 long, 230 thick, centreline on y = 0, so 115 either side.
  expect(footprint(level, 'w1')).toEqual([
    { x: 0, y: -115 },
    { x: 4000, y: -115 },
    { x: 4000, y: 115 },
    { x: 0, y: 115 },
  ]);
  expect(area(footprint(level, 'w1'))).toBe(4000 * 230);
});

test('a dead end is cut square across the centreline', () => {
  const level = makeLevel(
    [
      ['n1', 0, 0],
      ['n2', 4000, 0],
      ['n3', 4000, 3000],
    ],
    [
      ['w1', 'n1', 'n2', 200],
      ['w2', 'n2', 'n3', 200],
    ],
  );
  const [freeLeft, , , freeRight] = footprint(level, 'w1');

  // The two points at the free end are 200 apart and the line between them is perpendicular to the
  // wall, which is what "square butt" means.
  expect(distance(freeLeft, freeRight)).toBe(200);
  expect(dot(subtract(freeLeft, freeRight), { x: 1, y: 0 })).toBe(0);
});

/* --- Corners ---------------------------------------------------------------------------------- */

describe('two walls at a corner', () => {
  test('90 degrees, equal thickness: both mitre points are exact', () => {
    const level = makeLevel(
      [
        ['n1', 0, 0],
        ['n2', 4000, 0],
        ['n3', 4000, 3000],
      ],
      [
        ['w1', 'n1', 'n2', 200],
        ['w2', 'n2', 'n3', 200],
      ],
    );

    // Hand-computed. w1 runs east and turns south at n2. The outside of the bend is the north-east
    // corner (4100, -100); the inside is (3900, 100). Each is 100 = half the thickness beyond the
    // node on both axes, which is what a 90 degree mitre of a 200mm wall comes to.
    expect(footprint(level, 'w1')).toEqual([
      { x: 0, y: -100 },
      { x: 4100, y: -100 },
      { x: 3900, y: 100 },
      { x: 0, y: 100 },
    ]);
    expect(footprint(level, 'w2')).toEqual([
      { x: 4100, y: -100 },
      { x: 4100, y: 3000 },
      { x: 3900, y: 3000 },
      { x: 3900, y: 100 },
    ]);
  });

  test('90 degrees, 230mm meeting 115mm: the mitre lands on half-millimetres', () => {
    const level = makeLevel(
      [
        ['n1', 0, 0],
        ['n2', 4000, 0],
        ['n3', 4000, 3000],
      ],
      [
        ['w1', 'n1', 'n2', 230],
        ['w2', 'n2', 'n3', 115],
      ],
    );

    // Hand-computed. The offsets differ — 115 for the external wall, 57.5 for the partition — so the
    // corner is not symmetric: outside at (4057.5, -115), inside at (3942.5, 115). Half-millimetres
    // in a derived coordinate are correct and expected (CLAUDE.md rule 7).
    expect(footprint(level, 'w1')).toEqual([
      { x: 0, y: -115 },
      { x: 4057.5, y: -115 },
      { x: 3942.5, y: 115 },
      { x: 0, y: 115 },
    ]);
    expect(footprint(level, 'w2')).toEqual([
      { x: 4057.5, y: -115 },
      { x: 4057.5, y: 3000 },
      { x: 3942.5, y: 3000 },
      { x: 3942.5, y: 115 },
    ]);
  });

  test('a 45 degree bend closes to one sharp point, not two with a gap', () => {
    const level = makeLevel(
      [
        ['n1', 0, 0],
        ['n2', 4000, 0],
        ['n3', 7000, 3000],
      ],
      [
        ['w1', 'n1', 'n2', 200],
        ['w2', 'n2', 'n3', 200],
      ],
    );
    const first = footprint(level, 'w1');
    const second = footprint(level, 'w2');

    // w1's outer point at the bend and w2's outer point at the bend are the SAME point. If they were
    // merely close, the render would show a hairline wedge of daylight at every corner.
    const outerOfFirst = first[1];
    const outerOfSecond = second[0];
    expect(outerOfFirst).toEqual(outerOfSecond);

    // For a 45 degree change of direction the mitre runs 100 / cos(22.5) = 108.24mm past the node.
    expect(outerOfFirst.x).toBeCloseTo(4000 + 100 * (Math.SQRT2 - 1), 6);
    expect(outerOfFirst.y).toBeCloseTo(-100, 6);
    expect(distance(outerOfFirst, { x: 4000, y: 0 })).toBeCloseTo(100 / Math.cos(Math.PI / 8), 6);

    // And the inner point likewise, retreating the same distance on the other side.
    expect(first[2]).toEqual(second[3]);
  });
});

/* --- Junctions of three and four ---------------------------------------------------------------
 * The coverage assertions below sample a grid across the junction and require every sample to be
 * inside at least one footprint. Sample coordinates are chosen to miss every boundary line in the
 * junction (x = 4000, x + y = 4000, x - y = 4000, y = +/-100), so no sample sits on an edge where
 * "inside" is a coin flip. That is what makes "no gaps" a real assertion rather than a tolerance.
 * ---------------------------------------------------------------------------------------------- */

const SAMPLE_X = [3903, 3937, 3971, 4005, 4039, 4073, 4096];
const SAMPLE_Y = [-98, -65, -32, 3, 36, 69, 98];

function expectCovered(polygons: Point[][], xs: number[], ys: number[], offset: Point): void {
  for (const x of xs) {
    for (const y of ys) {
      const p = { x: x + offset.x, y: y + offset.y };
      const covered = polygons.some((polygon) => contains(polygon, p));
      expect(covered, `(${p.x}, ${p.y}) is not inside any wall`).toBe(true);
    }
  }
}

test('a T-junction is filled: no notch where the third wall lands', () => {
  const level = makeLevel(
    [
      ['n1', 0, 0],
      ['n2', 4000, 0],
      ['n3', 8000, 0],
      ['n4', 4000, 3000],
    ],
    [
      ['w1', 'n1', 'n2', 200],
      ['w2', 'n2', 'n3', 200],
      ['w3', 'n2', 'n4', 200],
    ],
  );
  const map = wallFootprints(level);
  const walls = ['w1', 'w2', 'w3'].map((id) => map.get(id) ?? []);

  // The straight-through pair keeps a continuous north face at y = -100: the branch must not chip a
  // notch out of it.
  expect(footprint(level, 'w1')[1]).toEqual({ x: 4000, y: -100 });
  expect(footprint(level, 'w2')[0]).toEqual({ x: 4000, y: -100 });

  // Each wall takes a triangle of the junction, and the three tile it exactly.
  expect(footprint(level, 'w3')).toEqual([
    { x: 4100, y: 100 },
    { x: 4100, y: 3000 },
    { x: 3900, y: 3000 },
    { x: 3900, y: 100 },
    { x: 4000, y: 0 },
  ]);
  expectCovered(walls, SAMPLE_X, SAMPLE_Y, { x: 0, y: 0 });
});

test('a four-way junction is filled: the n16 case', () => {
  const level = makeLevel(
    [
      ['c', 4000, 4000],
      ['e', 8000, 4000],
      ['s', 4000, 8000],
      ['w', 0, 4000],
      ['n', 4000, 0],
    ],
    [
      ['wE', 'c', 'e', 200],
      ['wS', 'c', 's', 200],
      ['wW', 'c', 'w', 200],
      ['wN', 'c', 'n', 200],
    ],
  );
  const map = wallFootprints(level);
  const walls = ['wE', 'wS', 'wW', 'wN'].map((id) => map.get(id) ?? []);

  // Four walls at right angles put the four corners of a 200 x 200 square around the node, and each
  // wall fans one quarter of it from the node.
  expect(footprint(level, 'wE')).toEqual([
    { x: 4100, y: 3900 },
    { x: 8000, y: 3900 },
    { x: 8000, y: 4100 },
    { x: 4100, y: 4100 },
    { x: 4000, y: 4000 },
  ]);
  expectCovered(
    walls,
    SAMPLE_X.map((x) => x - 4000),
    SAMPLE_Y,
    { x: 4000, y: 4000 },
  );
});

/* --- Collinear and near-collinear --------------------------------------------------------------- */

test('two walls in a straight line continue with no notch and no runaway', () => {
  const level = makeLevel(
    [
      ['n1', 0, 0],
      ['n2', 4000, 0],
      ['n3', 8000, 0],
    ],
    [
      ['w1', 'n1', 'n2', 200],
      ['w2', 'n2', 'n3', 200],
    ],
  );

  // Exactly parallel offset lines have no intersection at all. Detected by the cross product being
  // zero, and answered with a square butt, so the two rectangles share an edge exactly.
  expect(footprint(level, 'w1')).toEqual([
    { x: 0, y: -100 },
    { x: 4000, y: -100 },
    { x: 4000, y: 100 },
    { x: 0, y: 100 },
  ]);
  expect(footprint(level, 'w2')).toEqual([
    { x: 4000, y: -100 },
    { x: 8000, y: -100 },
    { x: 8000, y: 100 },
    { x: 4000, y: 100 },
  ]);
});

test('a near-straight join of unequal walls hits the mitre limit and stays bounded', () => {
  // 10mm of rise over 4000mm is a 0.14 degree kink. With different thicknesses the two offset lines
  // are nearly parallel AND 57.5mm apart, so the true mitre point is about 23 METRES away — a spike
  // out of the side of the building. The limit must catch it.
  const level = makeLevel(
    [
      ['n1', 0, 0],
      ['n2', 4000, 0],
      ['n3', 8000, 10],
    ],
    [
      ['w1', 'n1', 'n2', 230],
      ['w2', 'n2', 'n3', 115],
    ],
  );
  const points = [...footprint(level, 'w1'), ...footprint(level, 'w2')];

  const limitMm = MITER_LIMIT * 230;
  expect(limitMm).toBe(920);
  for (const p of points) {
    expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
    // Every point stays within the walls' own extent plus the mitre limit. 23 metres would not.
    expect(p.x).toBeGreaterThanOrEqual(-limitMm);
    expect(p.x).toBeLessThanOrEqual(8000 + limitMm);
    expect(Math.abs(p.y)).toBeLessThanOrEqual(limitMm);
  }
});

/* --- The whole sample flat ---------------------------------------------------------------------- */

describe('the sample flat', () => {
  const level = sampleFlat().levels[0];
  const map = wallFootprints(level);

  test('every wall gets a footprint', () => {
    expect(map.size).toBe(level.walls.length);
    for (const wall of level.walls) expect(map.get(wall.id)).toBeDefined();
  });

  test('every footprint is a simple polygon with a sensible area', () => {
    for (const wall of level.walls) {
      const polygon = map.get(wall.id) ?? [];
      expect(polygon.length).toBeGreaterThanOrEqual(4);
      expect(isSimple(polygon), `${wall.id} folds over itself`).toBe(true);

      // Roughly length x thickness: the mitres add and remove slivers at the ends, so allow 20%.
      const nodeById = new Map(level.nodes.map((n) => [n.id, n]));
      const a = nodeById.get(wall.a);
      const b = nodeById.get(wall.b);
      const nominal = a && b ? distance(a, b) * wall.thicknessMm : 0;
      expect(area(polygon)).toBeGreaterThan(nominal * 0.8);
      expect(area(polygon)).toBeLessThan(nominal * 1.2);
    }
  });

  test('no footprint escapes the building: the runaway-mitre smoke test', () => {
    // Plan is 11400 x 9000 between centrelines. Nothing may sit more than one mitre limit outside.
    const slackMm = MITER_LIMIT * 230;
    for (const [wallId, polygon] of map) {
      const box = boundingBox(polygon);
      expect(box.minX, wallId).toBeGreaterThanOrEqual(-slackMm);
      expect(box.minY, wallId).toBeGreaterThanOrEqual(-slackMm);
      expect(box.maxX, wallId).toBeLessThanOrEqual(11400 + slackMm);
      expect(box.maxY, wallId).toBeLessThanOrEqual(9000 + slackMm);
    }
  });

  test('no two walls overlap: mitering exists to remove exactly this', () => {
    const entries = [...map.entries()];
    for (let i = 0; i < entries.length; i += 1) {
      for (let j = i + 1; j < entries.length; j += 1) {
        expectNoOverlap(entries[i][0], entries[i][1], entries[j][0], entries[j][1]);
      }
    }
  });
});

/* --- Awkward geometry the sample flat does not contain -------------------------------------------
 * The flat is all right angles and no wall shorter than 1400mm, so it exercises none of this. These
 * are the two shapes most likely to appear on a real extracted plan and break the mitre.
 * ---------------------------------------------------------------------------------------------- */

describe('a short wall between two T-junctions', () => {
  /**
   * A run of wall with two partitions branching off it very close together — a shallow cupboard
   * recess, or a duct. Both ends of the middle wall retreat, and if the two retreats add up to more
   * than the wall is long they cross over and the footprint folds into a bowtie.
   */
  function shortWallBetweenTees(lengthMm: number, runMm: number, branchMm: number): Level {
    return makeLevel(
      [
        ['nOut', -4000, 0],
        ['nA', 0, 0],
        ['nB', lengthMm, 0],
        ['nEnd', lengthMm + 4000, 0],
        ['nBranchA', 0, 3000],
        ['nBranchB', lengthMm, 3000],
      ],
      [
        ['wLeft', 'nOut', 'nA', runMm],
        ['wShort', 'nA', 'nB', runMm],
        ['wRight', 'nB', 'nEnd', runMm],
        ['wBranchA', 'nA', 'nBranchA', branchMm],
        ['wBranchB', 'nB', 'nBranchB', branchMm],
      ],
    );
  }

  for (const lengthMm of [300, 150]) {
    for (const runMm of [115, 230]) {
      for (const branchMm of [115, 230]) {
        test(`${lengthMm}mm wall, ${runMm}mm run, ${branchMm}mm branches`, () => {
          const level = shortWallBetweenTees(lengthMm, runMm, branchMm);
          const map = wallFootprints(level);
          expect(map.size).toBe(5);

          for (const [wallId, polygon] of map) {
            expect(isSimple(polygon), `${wallId} folds over itself`).toBe(true);
            expect(area(polygon), `${wallId} has no area`).toBeGreaterThan(0);
          }
        });
      }
    }
  }
});

describe('two walls leaving a node at a sharp angle', () => {
  /** A sliver: two walls setting off in almost the same direction, as a bad extraction produces. */
  function wallsAtAngle(degrees: number, firstMm: number, secondMm: number): Level {
    const radians = (degrees * Math.PI) / 180;
    return makeLevel(
      [
        ['n', 0, 0],
        ['a', 4000, 0],
        ['b', Math.round(4000 * Math.cos(radians)), Math.round(4000 * Math.sin(radians))],
      ],
      [
        ['wA', 'n', 'a', firstMm],
        ['wB', 'n', 'b', secondMm],
      ],
    );
  }

  for (const degrees of [15, 8]) {
    for (const [firstMm, secondMm] of [
      [200, 200],
      [230, 115],
    ]) {
      test(`${degrees} degrees, ${firstMm}mm and ${secondMm}mm`, () => {
        const map = wallFootprints(wallsAtAngle(degrees, firstMm, secondMm));
        const polyA = map.get('wA') ?? [];
        const polyB = map.get('wB') ?? [];

        for (const [wallId, polygon] of [
          ['wA', polyA],
          ['wB', polyB],
        ] as const) {
          expect(isSimple(polygon), `${wallId} folds over itself`).toBe(true);
          expect(area(polygon), `${wallId} has no area`).toBeGreaterThan(0);

          // Both walls are 4000 long. Nothing may land outside that by more than the mitre limit.
          for (const p of polygon) {
            expect(Math.abs(p.x), wallId).toBeLessThanOrEqual(4000 + MITER_LIMIT * 230);
            expect(Math.abs(p.y), wallId).toBeLessThanOrEqual(4000 + MITER_LIMIT * 230);
          }
        }

        // The whole point of mitring the inside of the wedge: without it the two walls occupy the
        // same brickwork for more than a metre out from the node.
        expectNoOverlap('wA', polyA, 'wB', polyB);
      });
    }
  }
});
