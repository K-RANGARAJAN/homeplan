/**
 * Tests for hit testing and snapping.
 *
 * The interesting cases are all boundaries: exactly on the snap radius, exactly on the angle
 * tolerance, exactly at 45 degrees where neither axis wins, and a guide that runs parallel to the
 * wall it is supposed to meet. Everything here is arithmetic and runs headlessly.
 */

import { describe, expect, test } from 'vitest';

import type { Level, Meta } from '../plan/schema';
import {
  ANGLE_SNAP_TOLERANCE_DEG,
  axisGuideCrossing,
  nearestNode,
  nearestWall,
  neighbourPoints,
  projectOntoSegment,
  snapPointer,
  snapToAxis,
  wallLengthMm,
  indexNodes,
} from './pick';

const meta: Meta = { source: 'user', confidence: 1 };

type NodeSpec = [id: string, x: number, y: number];
type WallSpec = [id: string, a: string, b: string];

function makeLevel(nodes: NodeSpec[], walls: WallSpec[]): Level {
  return {
    id: 'l0',
    name: 'Test',
    elevationMm: 0,
    nodes: nodes.map(([id, x, y]) => ({ id, x, y, meta })),
    walls: walls.map(([id, a, b]) => ({ id, a, b, thicknessMm: 115, heightMm: 2900, meta })),
    openings: [],
    rooms: [],
    items: [],
    meta,
  };
}

/** A 4m x 3m box, drawn clockwise from the origin. */
const box = makeLevel(
  [
    ['n1', 0, 0],
    ['n2', 4000, 0],
    ['n3', 4000, 3000],
    ['n4', 0, 3000],
  ],
  [
    ['w1', 'n1', 'n2'],
    ['w2', 'n2', 'n3'],
    ['w3', 'n3', 'n4'],
    ['w4', 'n4', 'n1'],
  ],
);

/* --- Corners ---------------------------------------------------------------------------------- */

describe('nearestNode', () => {
  test('finds a corner inside the radius', () => {
    const hit = nearestNode(box.nodes, { x: 30, y: 40 }, 100);
    expect(hit?.node.id).toBe('n1');
    expect(hit?.distanceMm).toBeCloseTo(50, 9);
  });

  test('exactly on the radius counts as a hit; a millimetre past it does not', () => {
    expect(nearestNode(box.nodes, { x: 100, y: 0 }, 100)?.node.id).toBe('n1');
    expect(nearestNode(box.nodes, { x: 101, y: 0 }, 100)).toBeNull();
  });

  test('picks the closer of two corners in range', () => {
    const level = makeLevel(
      [
        ['a', 0, 0],
        ['b', 60, 0],
      ],
      [],
    );
    expect(nearestNode(level.nodes, { x: 40, y: 0 }, 100)?.node.id).toBe('b');
  });

  test('an empty plan has nothing to hit', () => {
    expect(nearestNode([], { x: 0, y: 0 }, 1000)).toBeNull();
  });
});

/* --- Walls ------------------------------------------------------------------------------------ */

describe('projectOntoSegment', () => {
  test('drops a perpendicular onto the segment', () => {
    const p = projectOntoSegment({ x: 0, y: 0 }, { x: 4000, y: 0 }, { x: 1200, y: 250 });
    expect(p.point).toEqual({ x: 1200, y: 0 });
    expect(p.alongMm).toBeCloseTo(1200, 9);
    expect(p.distanceMm).toBeCloseTo(250, 9);
  });

  test('clamps past the ends rather than running off down the infinite line', () => {
    const p = projectOntoSegment({ x: 0, y: 0 }, { x: 4000, y: 0 }, { x: 9000, y: 0 });
    expect(p.point).toEqual({ x: 4000, y: 0 });
    expect(p.alongMm).toBeCloseTo(4000, 9);
    expect(p.distanceMm).toBeCloseTo(5000, 9);
  });

  test('a zero-length segment reports its own point', () => {
    const p = projectOntoSegment({ x: 10, y: 10 }, { x: 10, y: 10 }, { x: 13, y: 14 });
    expect(p.point).toEqual({ x: 10, y: 10 });
    expect(p.distanceMm).toBeCloseTo(5, 9);
  });
});

describe('nearestWall', () => {
  test('finds the wall under the point, with the distance along it', () => {
    const hit = nearestWall(box, { x: 1500, y: 40 }, 100);
    expect(hit?.wall.id).toBe('w1');
    expect(hit?.alongMm).toBeCloseTo(1500, 9);
    expect(hit?.point).toEqual({ x: 1500, y: 0 });
  });

  test('reports nothing when every wall is outside the radius', () => {
    expect(nearestWall(box, { x: 2000, y: 1500 }, 100)).toBeNull();
  });

  test('prefers the closer wall near a corner', () => {
    // 30mm below the north wall, 200mm left of the east wall.
    expect(nearestWall(box, { x: 3800, y: 30 }, 400)?.wall.id).toBe('w1');
  });

  test('skips a wall whose corner reference dangles instead of throwing', () => {
    const broken = makeLevel([['n1', 0, 0]], [['w1', 'n1', 'ghost']]);
    expect(nearestWall(broken, { x: 0, y: 0 }, 1000)).toBeNull();
  });

  test('alongMm is measured from node a, not from whichever end is nearer', () => {
    const hit = nearestWall(box, { x: 4000, y: 2900 }, 200);
    expect(hit?.wall.id).toBe('w2');
    expect(hit?.alongMm).toBeCloseTo(2900, 9);
  });
});

describe('wallLengthMm', () => {
  test('rounds to the nearest millimetre', () => {
    const level = makeLevel(
      [
        ['a', 0, 0],
        ['b', 1000, 1000],
      ],
      [['w', 'a', 'b']],
    );
    expect(wallLengthMm(indexNodes(level.nodes), level.walls[0])).toBe(1414);
  });

  test('is null when an end is missing', () => {
    const broken = makeLevel([['a', 0, 0]], [['w', 'a', 'ghost']]);
    expect(wallLengthMm(indexNodes(broken.nodes), broken.walls[0])).toBeNull();
  });
});

/* --- Angle snapping --------------------------------------------------------------------------- */

describe('snapToAxis', () => {
  const anchor = { x: 0, y: 0 };
  const tolerance = Math.tan((ANGLE_SNAP_TOLERANCE_DEG * Math.PI) / 180);

  test('projects sideways onto a horizontal guide and keeps the distance along it', () => {
    const snapped = snapToAxis(anchor, { x: 1000, y: 50 });
    expect(snapped).toEqual({ point: { x: 1000, y: 0 }, axis: 'horizontal' });
  });

  test('projects onto a vertical guide', () => {
    const snapped = snapToAxis(anchor, { x: -50, y: 1000 });
    expect(snapped).toEqual({ point: { x: 0, y: 1000 }, axis: 'vertical' });
  });

  test('snaps on the tolerance boundary and not a millimetre past it', () => {
    const boundary = Math.floor(1000 * tolerance); // 87mm at 5 degrees
    expect(snapToAxis(anchor, { x: 1000, y: boundary }).axis).toBe('horizontal');
    expect(snapToAxis(anchor, { x: 1000, y: Math.ceil(1000 * tolerance) + 1 }).axis).toBeNull();
  });

  test('leaves a 45 degree segment alone — neither axis is nearer', () => {
    expect(snapToAxis(anchor, { x: 1000, y: 1000 })).toEqual({
      point: { x: 1000, y: 1000 },
      axis: null,
    });
  });

  test('a point on top of the anchor has no direction to square up', () => {
    expect(snapToAxis(anchor, { x: 0, y: 0 }).axis).toBeNull();
  });

  test('works away from the origin, and southward, which is +y in plan space', () => {
    expect(snapToAxis({ x: 4000, y: 2500 }, { x: 4030, y: 6000 })).toEqual({
      point: { x: 4000, y: 6000 },
      axis: 'vertical',
    });
  });
});

describe('axisGuideCrossing', () => {
  test('finds where a horizontal guide crosses a wall', () => {
    const crossing = axisGuideCrossing({ x: 0, y: 1000 }, 'horizontal', { x: 5000, y: 0 }, { x: 5000, y: 4000 });
    expect(crossing).toEqual({ x: 5000, y: 1000 });
  });

  test('misses a wall that is parallel to the guide', () => {
    expect(
      axisGuideCrossing({ x: 0, y: 1000 }, 'horizontal', { x: 0, y: 3000 }, { x: 5000, y: 3000 }),
    ).toBeNull();
  });

  test('misses a wall that ends before the guide reaches it', () => {
    expect(
      axisGuideCrossing({ x: 0, y: 9000 }, 'horizontal', { x: 5000, y: 0 }, { x: 5000, y: 4000 }),
    ).toBeNull();
  });
});

/* --- The one call the editor makes ------------------------------------------------------------ */

describe('snapPointer', () => {
  const settings = { radiusMm: 200, nodes: true, angle: true, walls: true };

  test('a corner in range wins outright, and the result is that corner exactly', () => {
    const snapped = snapPointer(box, { x: 4003, y: 7 }, [{ x: 0, y: 0 }], settings);
    expect(snapped.node?.id).toBe('n2');
    expect(snapped.point).toEqual({ x: 4000, y: 0 });
    expect(snapped.axis).toBeNull();
  });

  test('with snapping off, a point beside a corner stays where it was put', () => {
    const snapped = snapPointer(box, { x: 4003, y: 7 }, [{ x: 0, y: 0 }], { ...settings, nodes: false, angle: false, walls: false });
    expect(snapped.node).toBeNull();
    expect(snapped.point).toEqual({ x: 4003, y: 7 });
  });

  test('squares up against the anchor when nothing else is nearby', () => {
    const snapped = snapPointer(box, { x: 2000, y: 1490 }, [{ x: 2000, y: 1500 }], settings);
    expect(snapped.axis).toBe('vertical');
    expect(snapped.point).toEqual({ x: 2000, y: 1490 });
  });

  test('lands exactly on a wall centreline so the split does not kink it', () => {
    const snapped = snapPointer(box, { x: 1500, y: 60 }, [], settings);
    expect(snapped.wall?.wall.id).toBe('w1');
    expect(snapped.point).toEqual({ x: 1500, y: 0 });
    expect(snapped.wall?.alongMm).toBeCloseTo(1500, 9);
  });

  test('square AND on the wall: the answer is where the guide crosses it', () => {
    // Anchor 1000mm down the west wall, pointer 20mm short of the east wall and 50mm below square.
    const snapped = snapPointer(box, { x: 3980, y: 1050 }, [{ x: 0, y: 1000 }], settings);
    expect(snapped.axis).toBe('horizontal');
    expect(snapped.wall?.wall.id).toBe('w2');
    expect(snapped.point).toEqual({ x: 4000, y: 1000 });
    expect(snapped.wall?.alongMm).toBeCloseTo(1000, 9);
  });

  test('a guide that runs along the wall it meets gives up the guide, not the wall', () => {
    // Anchor and pointer both on the north wall: the horizontal guide is parallel to it.
    const snapped = snapPointer(box, { x: 2000, y: 40 }, [{ x: 500, y: 0 }], settings);
    expect(snapped.wall?.wall.id).toBe('w1');
    expect(snapped.axis).toBeNull();
    expect(snapped.point).toEqual({ x: 2000, y: 0 });
  });

  test('a corner being dragged is excluded, or it snaps to itself and the drag jams', () => {
    // n2 has already been moved to the pointer, which is where a drag leaves it between events.
    const at = { x: 4000, y: 0 };
    expect(snapPointer(box, at, [], settings).node?.id).toBe('n2');

    const dragging = snapPointer(box, at, [], { ...settings, ignoreNodes: new Set(['n2']) });
    expect(dragging.node).toBeNull();
    // Its own two walls are excluded with it, so it is not pulled onto a wall it is an end of.
    expect(dragging.wall).toBeNull();
    expect(dragging.point).toEqual(at);
  });

  test('a dragged corner squares up against whichever of its neighbours is nearest to square', () => {
    // Dragging n2. Its neighbours are n1 (west, along the north wall) and n3 (south, along the east
    // wall). A pointer 30mm off the line to n3 and 900mm off the line to n1 squares to n3's.
    const snapped = snapPointer(
      box,
      { x: 4030, y: 900 },
      neighbourPoints(box, 'n2'),
      { ...settings, ignoreNodes: new Set(['n2']) },
    );
    expect(snapped.axis).toBe('vertical');
    expect(snapped.guideFrom).toEqual({ x: 4000, y: 3000 });
    expect(snapped.point).toEqual({ x: 4000, y: 900 });
  });

  test('always returns integer millimetres, because the result becomes a corner', () => {
    const diagonal = makeLevel(
      [
        ['a', 0, 0],
        ['b', 3000, 1000],
      ],
      [['w', 'a', 'b']],
    );
    const snapped = snapPointer(diagonal, { x: 1499, y: 512 }, [], { ...settings, angle: false });
    expect(Number.isInteger(snapped.point.x)).toBe(true);
    expect(Number.isInteger(snapped.point.y)).toBe(true);
  });
});
