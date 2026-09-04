/**
 * Tests for wall splitting and typed lengths.
 *
 * The splitting fixture DELIBERATELY CARRIES OPENINGS, an item and two room loops, even though
 * openings, items and rooms are all later passes and nothing in the editor produces them yet. This
 * is the operation that quietly slides a door three metres down a flat, and the bug is invisible
 * until openings exist — by which time the editor is relying on the wrong behaviour. Hand-built
 * fixture, hand-computed expectations.
 */

import { describe, expect, test } from 'vitest';

import type { HingedDoor, Item, Level, Meta, PlanWindow, Room, Wall } from '../plan/schema';
import { chooseMovingEnd, planLengthChange, splitWall } from './edit';

const meta: Meta = { source: 'user', confidence: 1 };

/* --- Fixtures --------------------------------------------------------------------------------- */

type NodeSpec = [id: string, x: number, y: number];

function makeLevel(
  nodes: NodeSpec[],
  walls: Wall[],
  extras: Partial<Pick<Level, 'openings' | 'rooms' | 'items'>> = {},
): Level {
  return {
    id: 'l0',
    name: 'Test',
    elevationMm: 0,
    nodes: nodes.map(([id, x, y]) => ({ id, x, y, meta })),
    walls,
    openings: extras.openings ?? [],
    rooms: extras.rooms ?? [],
    items: extras.items ?? [],
    meta,
  };
}

const wall = (id: string, a: string, b: string, thicknessMm = 115): Wall => ({
  id,
  a,
  b,
  thicknessMm,
  heightMm: 2900,
  meta: { source: 'auto', confidence: 0.4 },
});

const door = (id: string, wallId: string, offsetMm: number, widthMm: number): HingedDoor => ({
  id,
  wall: wallId,
  kind: 'door',
  leaf: 'hinged',
  swing: { side: 'left', hinge: 'a' },
  offsetMm,
  widthMm,
  heightMm: 2100,
  sillMm: 0,
  meta,
});

const window_ = (id: string, wallId: string, offsetMm: number, widthMm: number): PlanWindow => ({
  id,
  wall: wallId,
  kind: 'window',
  offsetMm,
  widthMm,
  heightMm: 1200,
  sillMm: 900,
  meta,
});

const room = (id: string, name: string, wallLoop: string[]): Room => ({ id, name, wallLoop, meta });

const wardrobe = (id: string, wallId: string, offsetMm: number): Item => ({
  id,
  kind: 'generated',
  category: 'wardrobe',
  anchor: { on: 'wall', wall: wallId, offsetMm, side: 'left', gapMm: 0 },
  params: {},
  meta,
});

const ids = { node: 'nX', wall: 'wX' };

/**
 * A 6000 x 3000 box with a door and a window on the long north wall, a wardrobe against it, and two
 * rooms sharing it — one whose loop runs along it forwards, one backwards.
 *
 *   n1 ────────── w1 ────────── n2
 *   │                            │
 *   w4                          w2
 *   │                            │
 *   n4 ────────── w3 ────────── n3
 */
function boxWithFittings(): Level {
  return makeLevel(
    [
      ['n1', 0, 0],
      ['n2', 6000, 0],
      ['n3', 6000, 3000],
      ['n4', 0, 3000],
    ],
    [wall('w1', 'n1', 'n2'), wall('w2', 'n2', 'n3'), wall('w3', 'n3', 'n4'), wall('w4', 'n4', 'n1')],
    {
      openings: [door('d1', 'w1', 500, 900), window_('v1', 'w1', 4000, 1500)],
      rooms: [
        // Runs n1 -> n2 -> n3 -> n4: the loop traverses w1 forwards, from its node `a`.
        room('r1', 'Inside', ['w1', 'w2', 'w3', 'w4']),
        // The same walls listed the other way round: the loop arrives at w1's node `b`.
        room('r2', 'Mirror', ['w4', 'w3', 'w2', 'w1']),
      ],
      items: [wardrobe('i1', 'w1', 5200)],
    },
  );
}

/* --- Splitting -------------------------------------------------------------------------------- */

describe('splitWall', () => {
  test('cuts the wall in two at the projected point, keeping the original id on the near half', () => {
    const level = boxWithFittings();
    const outcome = splitWall(level, 'w1', { x: 2500, y: 80 }, ids);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.split.cutMm).toBe(2500);
    expect(outcome.split.node).toEqual({ id: 'nX', x: 2500, y: 0, meta: { source: 'derived', confidence: 1 } });
    expect(outcome.split.shortenedWall).toBe('w1');
    expect(outcome.split.addedWall.a).toBe('nX');
    expect(outcome.split.addedWall.b).toBe('n2');
  });

  test('the far half inherits thickness, height and provenance rather than claiming to be new', () => {
    const level = boxWithFittings();
    const outcome = splitWall(level, 'w1', { x: 2500, y: 0 }, ids);
    if (!outcome.ok) throw new Error('expected a split');

    expect(outcome.split.addedWall.thicknessMm).toBe(115);
    expect(outcome.split.addedWall.heightMm).toBe(2900);
    expect(outcome.split.addedWall.meta).toEqual({ source: 'auto', confidence: 0.4 });
  });

  test('openings past the cut move to the far half with their offsets recomputed', () => {
    const level = boxWithFittings();
    const outcome = splitWall(level, 'w1', { x: 2500, y: 0 }, ids);
    if (!outcome.ok) throw new Error('expected a split');

    // The door at 500..1400 is before the cut and is not touched. The window at 4000..5500 is past
    // it and is now 4000 - 2500 = 1500 along the new wall.
    expect(outcome.split.movedOpenings).toEqual([{ id: 'v1', wall: 'wX', offsetMm: 1500 }]);
  });

  test('an opening that ends exactly at the cut stays on the near half', () => {
    const level = boxWithFittings();
    const outcome = splitWall(level, 'w1', { x: 1400, y: 0 }, ids);
    if (!outcome.ok) throw new Error('expected a split');
    expect(outcome.split.movedOpenings.map((m) => m.id)).toEqual(['v1']);
  });

  test('an opening that starts exactly at the cut moves, and starts at zero on the far half', () => {
    const level = boxWithFittings();
    const outcome = splitWall(level, 'w1', { x: 4000, y: 0 }, ids);
    if (!outcome.ok) throw new Error('expected a split');
    expect(outcome.split.movedOpenings).toEqual([{ id: 'v1', wall: 'wX', offsetMm: 0 }]);
  });

  test('refuses to cut through the middle of a doorway, and names it', () => {
    const level = boxWithFittings();
    const outcome = splitWall(level, 'w1', { x: 900, y: 0 }, ids);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('through-opening');
    if (outcome.reason !== 'through-opening') return;
    expect(outcome.openings.map((o) => o.id)).toEqual(['d1']);
  });

  test('items anchored past the cut follow their wall', () => {
    const level = boxWithFittings();
    const outcome = splitWall(level, 'w1', { x: 2500, y: 0 }, ids);
    if (!outcome.ok) throw new Error('expected a split');
    expect(outcome.split.movedItems).toEqual([{ id: 'i1', wall: 'wX', offsetMm: 2700 }]);
  });

  test('items before the cut are left where they are', () => {
    const level = boxWithFittings();
    const outcome = splitWall(level, 'w1', { x: 5600, y: 0 }, ids);
    if (!outcome.ok) throw new Error('expected a split');
    expect(outcome.split.movedItems).toEqual([]);
  });

  test('inserts the far half after the near half in a loop that runs a -> b, and before it in one that does not', () => {
    const level = boxWithFittings();
    const outcome = splitWall(level, 'w1', { x: 2500, y: 0 }, ids);
    if (!outcome.ok) throw new Error('expected a split');

    // r1 is [w1, w2, w3, w4] and arrives at w1 from w4, which shares n1 = w1.a: forwards, so the far
    // half goes at index 1. r2 is [w4, w3, w2, w1] and arrives at w1 from w2, which shares n2 = w1.b:
    // backwards, so the far half goes at index 3, ahead of w1.
    expect(outcome.split.roomInsertions).toEqual([
      { room: 'r1', index: 1 },
      { room: 'r2', index: 3 },
    ]);
  });

  test('applying the insertions keeps both loops closed', () => {
    const level = boxWithFittings();
    const outcome = splitWall(level, 'w1', { x: 2500, y: 0 }, ids);
    if (!outcome.ok) throw new Error('expected a split');

    const loops = new Map(level.rooms.map((r) => [r.id, [...r.wallLoop]]));
    for (const insertion of outcome.split.roomInsertions) {
      loops.get(insertion.room)?.splice(insertion.index, 0, outcome.split.addedWall.id);
    }
    expect(loops.get('r1')).toEqual(['w1', 'wX', 'w2', 'w3', 'w4']);
    expect(loops.get('r2')).toEqual(['w4', 'w3', 'w2', 'wX', 'w1']);
  });

  test('refuses a cut that lands on an existing corner', () => {
    const level = boxWithFittings();
    expect(splitWall(level, 'w1', { x: 0, y: 0 }, ids)).toEqual({ ok: false, reason: 'at-end' });
    expect(splitWall(level, 'w1', { x: 6000, y: 0 }, ids)).toEqual({ ok: false, reason: 'at-end' });
    // Projection clamps, so a point well past the end is the end.
    expect(splitWall(level, 'w1', { x: 9000, y: 0 }, ids)).toEqual({ ok: false, reason: 'at-end' });
  });

  test('reports a missing wall and a wall with no direction separately', () => {
    const level = boxWithFittings();
    expect(splitWall(level, 'ghost', { x: 0, y: 0 }, ids)).toEqual({ ok: false, reason: 'no-such-wall' });

    const broken = makeLevel([['n1', 0, 0]], [wall('w1', 'n1', 'ghost')]);
    expect(splitWall(broken, 'w1', { x: 10, y: 10 }, ids)).toEqual({ ok: false, reason: 'unmeasurable' });
  });

  test('a diagonal wall is cut on its own centreline, to the nearest millimetre', () => {
    const level = makeLevel(
      [
        ['a', 0, 0],
        ['b', 3000, 4000],
      ],
      [wall('w', 'a', 'b')],
    );
    // 2500mm along a 5000mm wall is exactly the midpoint.
    const outcome = splitWall(level, 'w', { x: 1500, y: 2000 }, ids);
    if (!outcome.ok) throw new Error('expected a split');
    expect(outcome.split.cutMm).toBe(2500);
    expect(outcome.split.node.x).toBe(1500);
    expect(outcome.split.node.y).toBe(2000);
  });
});

/* --- Typed lengths ---------------------------------------------------------------------------- */

describe('chooseMovingEnd', () => {
  test('the free end moves in preference to a corner', () => {
    //   a ── w ── b ── w2 ── c :  b is busy, a is free.
    const level = makeLevel(
      [
        ['a', 0, 0],
        ['b', 1000, 0],
        ['c', 2000, 0],
      ],
      [wall('w', 'a', 'b'), wall('w2', 'b', 'c')],
    );
    expect(chooseMovingEnd(level, level.walls[0])).toBe('a');
  });

  test('a corner moves in preference to a T-junction', () => {
    const level = makeLevel(
      [
        ['a', 0, 0],
        ['b', 1000, 0],
        ['c', 2000, 0],
        ['d', 1000, 1000],
        ['e', -1000, 0],
      ],
      [wall('w', 'a', 'b'), wall('w2', 'b', 'c'), wall('w3', 'b', 'd'), wall('w4', 'a', 'e')],
    );
    // a has one other wall, b has two.
    expect(chooseMovingEnd(level, level.walls[0])).toBe('a');
  });

  test('a tie goes to b — the end most recently placed when the wall was drawn', () => {
    const level = makeLevel(
      [
        ['a', 0, 0],
        ['b', 1000, 0],
      ],
      [wall('w', 'a', 'b')],
    );
    expect(chooseMovingEnd(level, level.walls[0])).toBe('b');
  });
});

describe('planLengthChange', () => {
  const level = (): Level =>
    makeLevel(
      [
        ['a', 0, 0],
        ['b', 4000, 0],
        ['c', 4000, 3000],
      ],
      [wall('w1', 'a', 'b'), wall('w2', 'b', 'c')],
    );

  test('moves the chosen end along the wall, keeping its direction and the other end', () => {
    const outcome = planLengthChange(level(), 'w1', 3500, 'b');
    if (!outcome.ok) throw new Error('expected a change');
    expect(outcome.change.node).toBe('b');
    expect(outcome.change.from).toEqual({ x: 4000, y: 0 });
    expect(outcome.change.to).toEqual({ x: 3500, y: 0 });
    expect(outcome.change.achievedLengthMm).toBe(3500);
  });

  test('moving end a shortens from the other side, leaving b where it is', () => {
    const outcome = planLengthChange(level(), 'w1', 3500, 'a');
    if (!outcome.ok) throw new Error('expected a change');
    expect(outcome.change.node).toBe('a');
    expect(outcome.change.to).toEqual({ x: 500, y: 0 });
  });

  test('names the walls that will follow the moved corner', () => {
    const outcome = planLengthChange(level(), 'w1', 3500, 'b');
    if (!outcome.ok) throw new Error('expected a change');
    expect(outcome.change.followers).toEqual(['w2']);

    const other = planLengthChange(level(), 'w1', 3500, 'a');
    if (!other.ok) throw new Error('expected a change');
    expect(other.change.followers).toEqual([]);
  });

  test('lengthening works the same way as shortening', () => {
    const outcome = planLengthChange(level(), 'w1', 9000, 'b');
    if (!outcome.ok) throw new Error('expected a change');
    expect(outcome.change.to).toEqual({ x: 9000, y: 0 });
  });

  test('reports the length actually achieved on a diagonal, where integers cannot hit it exactly', () => {
    const diagonal = makeLevel(
      [
        ['a', 0, 0],
        ['b', 1000, 1000],
      ],
      [wall('w', 'a', 'b')],
    );
    const outcome = planLengthChange(diagonal, 'w', 3333, 'b');
    if (!outcome.ok) throw new Error('expected a change');
    expect(outcome.change.to).toEqual({ x: 2357, y: 2357 });
    expect(outcome.change.achievedLengthMm).toBe(3333);
    expect(Number.isInteger(outcome.change.to.x)).toBe(true);
  });

  test('refuses a length that is not a positive number', () => {
    expect(planLengthChange(level(), 'w1', 0, 'b')).toEqual({ ok: false, reason: 'not-positive' });
    expect(planLengthChange(level(), 'w1', -100, 'b')).toEqual({ ok: false, reason: 'not-positive' });
    expect(planLengthChange(level(), 'w1', Number.NaN, 'b')).toEqual({ ok: false, reason: 'not-positive' });
  });

  test('refuses a wall it cannot measure', () => {
    expect(planLengthChange(level(), 'ghost', 100, 'b')).toEqual({ ok: false, reason: 'no-such-wall' });
    const broken = makeLevel([['a', 0, 0]], [wall('w', 'a', 'ghost')]);
    expect(planLengthChange(broken, 'w', 100, 'b')).toEqual({ ok: false, reason: 'unmeasurable' });
  });
});
