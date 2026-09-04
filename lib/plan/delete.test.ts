/**
 * Tests for the deletion cascade.
 *
 * As with wall splitting, the fixture carries items even though nothing in the editor creates them
 * yet: item anchors CHAIN — a lamp on a side table beside a sofa against a wall — and a cascade that
 * only walks one link deep leaves the lamp anchored to a table that no longer exists. That is an
 * `ITEM_ORPHAN_ANCHOR` the editor created itself, and it is much easier to get right now than to
 * notice later.
 */

import { describe, expect, test } from 'vitest';

import { describeDeletion, isEmptyDeletion, planDeletion } from './delete';
import { sampleFlat } from './sample';
import type { Item, Level, Meta } from './schema';

const meta: Meta = { source: 'user', confidence: 1 };

const onWall = (id: string, wallId: string): Item => ({
  id,
  kind: 'generated',
  category: 'wardrobe',
  anchor: { on: 'wall', wall: wallId, offsetMm: 500, side: 'left', gapMm: 0 },
  params: {},
  meta,
});

const onItem = (id: string, itemId: string): Item => ({
  id,
  kind: 'retrieved',
  category: 'lamp',
  asset: 'lamp-a',
  anchor: { on: 'item', item: itemId, relation: 'on-top-of', gapMm: 0 },
  meta,
});

const onRoom = (id: string, roomId: string): Item => ({
  id,
  kind: 'retrieved',
  category: 'plant',
  asset: 'plant-a',
  anchor: { on: 'room', room: roomId },
  meta,
});

function withItems(items: Item[]): Level {
  const level = sampleFlat().levels[0];
  return { ...level, items };
}

describe('planDeletion', () => {
  test('a corner takes the walls pinned to it, and those walls take their openings', () => {
    const level = sampleFlat().levels[0];
    // n12 joins w12 (master bedroom | bathroom), w13 and w15.
    const deletion = planDeletion(level, [{ kind: 'node', id: 'n12' }]);

    expect(deletion.nodes).toContain('n12');
    expect(deletion.walls.sort()).toEqual(['w12', 'w13', 'w15']);
    // d3 is on w12 and d2 is on w13.
    expect(deletion.openings.sort()).toEqual(['d2', 'd3']);
  });

  test('a wall takes every room whose outline ran along it', () => {
    const level = sampleFlat().levels[0];
    const deletion = planDeletion(level, [{ kind: 'wall', id: 'w12' }]);
    // w12 is in the master bedroom's loop and the master bathroom's.
    expect(deletion.rooms.sort()).toEqual(['r1', 'r2']);
  });

  test('corners still holding another wall up are not swept', () => {
    const level = sampleFlat().levels[0];
    const deletion = planDeletion(level, [{ kind: 'wall', id: 'w12' }]);
    // n2 still has w1 and w2; n12 still has w13 and w15.
    expect(deletion.nodes).toEqual([]);
  });

  test('a corner that loses its last wall goes with it', () => {
    const level: Level = {
      ...sampleFlat().levels[0],
      nodes: [
        { id: 'a', x: 0, y: 0, meta },
        { id: 'b', x: 1000, y: 0, meta },
      ],
      walls: [{ id: 'w', a: 'a', b: 'b', thicknessMm: 115, heightMm: 2900, meta }],
      openings: [],
      rooms: [],
      items: [],
    };
    expect(planDeletion(level, [{ kind: 'wall', id: 'w' }]).nodes.sort()).toEqual(['a', 'b']);
  });

  test('items follow their wall, and items anchored to those items follow them', () => {
    const level = withItems([onWall('i1', 'w12'), onItem('i2', 'i1'), onItem('i3', 'i2'), onWall('i4', 'w1')]);
    const deletion = planDeletion(level, [{ kind: 'wall', id: 'w12' }]);
    expect(deletion.items.sort()).toEqual(['i1', 'i2', 'i3']);
  });

  test('an item standing free in a room goes when the room does', () => {
    const level = withItems([onRoom('i1', 'r2')]);
    // w14 is in the master bathroom's loop, so deleting it removes r2.
    const deletion = planDeletion(level, [{ kind: 'wall', id: 'w14' }]);
    expect(deletion.rooms).toContain('r2');
    expect(deletion.items).toEqual(['i1']);
  });

  test('an empty selection deletes nothing', () => {
    const deletion = planDeletion(sampleFlat().levels[0], []);
    expect(isEmptyDeletion(deletion)).toBe(true);
  });

  test('a selection naming something that is not there deletes nothing', () => {
    const deletion = planDeletion(sampleFlat().levels[0], [{ kind: 'wall', id: 'ghost' }]);
    expect(isEmptyDeletion(deletion)).toBe(true);
  });
});

describe('describeDeletion', () => {
  test('reads as a sentence a homeowner would understand', () => {
    const level = sampleFlat().levels[0];
    expect(describeDeletion(planDeletion(level, [{ kind: 'wall', id: 'w12' }]))).toBe(
      '1 wall, 1 opening and 2 rooms',
    );
  });

  test('one thing has no list', () => {
    const level: Level = { ...sampleFlat().levels[0], openings: [], rooms: [], items: [] };
    expect(describeDeletion(planDeletion(level, [{ kind: 'wall', id: 'w12' }]))).toBe('1 wall');
  });
});
