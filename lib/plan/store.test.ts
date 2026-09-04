/**
 * Tests for the editor store.
 *
 * These are the tests that decide whether the editor is trustworthy: that one gesture is one undo
 * step, that shared nodes really do drag their walls, that deleting takes its dependents with it,
 * and — the one worth the most — that a plan built purely through store operations validates clean.
 * If ordinary use of the editor can produce an invalid document, that is the bug to find now, not
 * after extraction is layered on top of it.
 *
 * The store is a module singleton, as it is in the app, so every test resets it first.
 */

import { beforeEach, describe, expect, test } from 'vitest';

import { planLengthChange } from '../geometry/edit';
import { sampleFlat } from './sample';
import { SCHEMA_VERSION, type Level, type PlanDoc } from './schema';
import { currentLevel, usePlanStore, type DrawAnchor } from './store';
import { validate } from './validate';

/* --- Helpers ---------------------------------------------------------------------------------- */

const store = () => usePlanStore.getState();
const level = (): Level => currentLevel(store().doc);
const nodeIds = (): string[] => level().nodes.map((n) => n.id);
const wallIds = (): string[] => level().walls.map((w) => w.id);
const undoDepth = (): number => store().history.past.length;

function nodeAt(id: string): { x: number; y: number } {
  const node = level().nodes.find((n) => n.id === id);
  if (node === undefined) throw new Error(`no node ${id}`);
  return { x: node.x, y: node.y };
}

/** An empty flat with a confirmed scale, so the scale gate is not the thing under test. */
function emptyPlan(): PlanDoc {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: 'blank',
    name: 'Blank',
    units: 'mm',
    region: 'IN',
    scale: {
      status: 'confirmed',
      mmPerPx: 10,
      reference: { lengthMm: 4000, lengthPx: 400 },
      confirmedAt: '2026-09-04T09:00:00.000Z',
    },
    levels: [
      {
        id: 'l0',
        name: 'Ground',
        elevationMm: 0,
        nodes: [],
        walls: [],
        openings: [],
        rooms: [],
        items: [],
        meta: { source: 'user', confidence: 1 },
      },
    ],
    createdAt: '2026-09-04T09:00:00.000Z',
    updatedAt: '2026-09-04T09:00:00.000Z',
  };
}

/** Tap a sequence of points with the draw tool, and finish the chain. */
function drawChain(...anchors: DrawAnchor[]): void {
  for (const anchor of anchors) store().drawTo(anchor);
  store().endChain();
}

const at = (x: number, y: number): DrawAnchor => ({ on: 'empty', at: { x, y } });

/* --- Drawing ---------------------------------------------------------------------------------- */

describe('drawing walls', () => {
  beforeEach(() => store().reset(emptyPlan()));

  test('the first tap commits nothing — it only arms the chain', () => {
    store().drawTo(at(0, 0));
    expect(nodeIds()).toEqual([]);
    expect(undoDepth()).toBe(0);
    expect(store().chain).not.toBeNull();
  });

  test('the second tap creates both corners and the wall between them', () => {
    store().drawTo(at(0, 0));
    store().drawTo(at(4000, 0));

    expect(level().nodes).toHaveLength(2);
    expect(level().walls).toHaveLength(1);
    expect(level().walls[0]).toMatchObject({
      a: level().nodes[0].id,
      b: level().nodes[1].id,
      thicknessMm: 115,
      heightMm: 2900,
      meta: { source: 'user', confidence: 1 },
    });
  });

  test('two corners and a wall are ONE undo step, not three', () => {
    store().drawTo(at(0, 0));
    store().drawTo(at(4000, 0));
    expect(undoDepth()).toBe(1);
  });

  test('the chain continues from the end just placed, one step per segment', () => {
    drawChain(at(0, 0), at(4000, 0), at(4000, 3000), at(0, 3000));
    expect(level().walls).toHaveLength(3);
    expect(undoDepth()).toBe(3);
    // Consecutive walls share a corner: that is the whole point of the shared-node design.
    expect(level().walls[0].b).toBe(level().walls[1].a);
    expect(level().walls[1].b).toBe(level().walls[2].a);
  });

  test('closing onto an existing corner reuses it instead of stacking a second one on top', () => {
    store().drawTo(at(0, 0));
    store().drawTo(at(4000, 0));
    store().drawTo(at(4000, 3000));
    const first = level().nodes[0].id;
    store().drawTo({ on: 'node', node: first });
    store().endChain();

    expect(level().nodes).toHaveLength(3);
    expect(level().walls).toHaveLength(3);
    expect(level().walls[2].b).toBe(first);
  });

  test('a second wall between the same two corners is refused, with a reason', () => {
    store().drawTo(at(0, 0));
    store().drawTo(at(4000, 0));
    const [a, b] = nodeIds();
    store().drawTo({ on: 'node', node: a });
    store().drawTo({ on: 'node', node: b });

    expect(level().walls).toHaveLength(1);
    expect(store().notice).toMatch(/already a wall/i);
  });

  test('coordinates are rounded to integer millimetres, whatever the pointer produced', () => {
    store().drawTo({ on: 'empty', at: { x: 12.4, y: -7.6 } });
    store().drawTo({ on: 'empty', at: { x: 4000.5, y: 0.2 } });
    for (const node of level().nodes) {
      expect(Number.isInteger(node.x)).toBe(true);
      expect(Number.isInteger(node.y)).toBe(true);
    }
    expect(nodeAt(nodeIds()[0])).toEqual({ x: 12, y: -8 });
  });
});

/* --- Drawing onto an existing wall ------------------------------------------------------------ */

describe('drawing onto an existing wall', () => {
  beforeEach(() => store().reset(emptyPlan()));

  test('splits it, and the new corner joins three walls', () => {
    drawChain(at(0, 0), at(4000, 0));
    const original = wallIds()[0];

    store().drawTo({ on: 'wall', wall: original, at: { x: 2000, y: 0 } });
    store().drawTo(at(2000, 3000));
    store().endChain();

    expect(level().walls).toHaveLength(3);
    const junction = level().nodes.find((n) => n.x === 2000 && n.y === 0);
    expect(junction).toBeDefined();
    const attached = level().walls.filter((w) => w.a === junction?.id || w.b === junction?.id);
    expect(attached).toHaveLength(3);
    expect(validate(store().doc)).toEqual([]);
  });

  test('the split marks the corner and both halves as the user"s, so extraction cannot undo it', () => {
    const doc = sampleFlat();
    // As an extraction run would leave it: found automatically, and not confidently.
    const w1 = doc.levels[0].walls.find((w) => w.id === 'w1');
    if (w1 === undefined) throw new Error('no w1');
    w1.meta = { source: 'auto', confidence: 0.4 };
    store().reset(doc);

    // Clear of window v1, which runs 1250..2750 along w1 — a cut through it would be refused.
    store().drawTo({ on: 'wall', wall: 'w1', at: { x: 1000, y: 0 } });
    store().drawTo({ on: 'empty', at: { x: 1000, y: 1500 } });
    store().endChain();

    const junction = level().nodes.find((n) => n.x === 1000 && n.y === 0);
    expect(junction?.meta).toEqual({ source: 'user', confidence: 1 });
    for (const wall of level().walls.filter((w) => w.a === junction?.id || w.b === junction?.id)) {
      expect(wall.meta).toEqual({ source: 'user', confidence: 1 });
    }
  });

  test('the whole thing — split plus new wall — is one undo step', () => {
    drawChain(at(0, 0), at(4000, 0));
    const before = undoDepth();

    store().drawTo({ on: 'wall', wall: wallIds()[0], at: { x: 2000, y: 0 } });
    store().drawTo(at(2000, 3000));
    store().endChain();

    expect(undoDepth()).toBe(before + 1);
  });

  test('a tap that lands on a wall but within rounding of its corner attaches to the corner', () => {
    drawChain(at(0, 0), at(4000, 0));
    const [a] = nodeIds();

    store().drawTo({ on: 'wall', wall: wallIds()[0], at: { x: 0, y: 0 } });
    store().drawTo(at(0, 3000));
    store().endChain();

    expect(level().nodes).toHaveLength(3); // No spurious corner on top of `a`.
    expect(level().walls).toHaveLength(2);
    expect(level().walls[1].a).toBe(a);
  });

  test('a split through a doorway is refused and says which one', () => {
    const doc = sampleFlat();
    store().reset(doc);
    // d1 is the front door, 800..1800 along w10.
    store().drawTo({ on: 'wall', wall: 'w10', at: { x: 0, y: 7700 } });
    store().drawTo({ on: 'empty', at: { x: 2000, y: 7700 } });
    store().endChain();

    expect(store().notice).toMatch(/door d1/);
    expect(level().walls.filter((w) => w.id === 'w10')).toHaveLength(1);
  });
});

/* --- Dragging --------------------------------------------------------------------------------- */

describe('dragging a corner', () => {
  beforeEach(() => store().reset(emptyPlan()));

  test('every attached wall follows, because they share the corner', () => {
    drawChain(at(0, 0), at(4000, 0), at(4000, 3000));
    const shared = level().walls[0].b;
    expect(level().walls[1].a).toBe(shared);

    store().beginGesture('Drag');
    store().moveNode(shared, { x: 4500, y: 200 });
    store().endGesture();

    // There is no per-wall copy of the corner to go stale: both walls read the same node.
    expect(nodeAt(level().walls[0].b)).toEqual({ x: 4500, y: 200 });
    expect(nodeAt(level().walls[1].a)).toEqual({ x: 4500, y: 200 });
  });

  test('a hundred pointer-moves are one undo step', () => {
    drawChain(at(0, 0), at(4000, 0));
    const node = level().walls[0].b;
    const before = undoDepth();

    store().beginGesture('Drag');
    for (let i = 1; i <= 100; i += 1) store().moveNode(node, { x: 4000 + i, y: i });
    store().endGesture();

    expect(undoDepth()).toBe(before + 1);
    expect(nodeAt(node)).toEqual({ x: 4100, y: 100 });
  });

  test('undoing that one step returns the corner to where the drag started', () => {
    drawChain(at(0, 0), at(4000, 0));
    const node = level().walls[0].b;

    store().beginGesture('Drag');
    for (let i = 1; i <= 20; i += 1) store().moveNode(node, { x: 4000 + i * 10, y: 0 });
    store().endGesture();
    expect(nodeAt(node)).toEqual({ x: 4200, y: 0 });

    store().undo();
    expect(nodeAt(node)).toEqual({ x: 4000, y: 0 });
  });

  test('a drag that ends where it began adds nothing to the history', () => {
    drawChain(at(0, 0), at(4000, 0));
    const node = level().walls[0].b;
    const before = undoDepth();

    store().beginGesture('Drag');
    store().moveNode(node, { x: 4000, y: 0 });
    store().endGesture();

    expect(undoDepth()).toBe(before);
  });

  test('a dragged corner is marked as the user"s, so extraction cannot clobber the fix', () => {
    const doc = sampleFlat();
    doc.levels[0].nodes[0].meta = { source: 'auto', confidence: 0.3 };
    store().reset(doc);

    store().beginGesture('Drag');
    store().moveNode('n1', { x: 50, y: 50 });
    store().endGesture();

    expect(level().nodes[0].meta).toEqual({ source: 'user', confidence: 1 });
  });
});

/* --- Typed lengths ---------------------------------------------------------------------------- */

describe('typed exact lengths', () => {
  beforeEach(() => store().reset(emptyPlan()));

  test('sets the wall to exactly the length asked for, moving the chosen end', () => {
    drawChain(at(0, 0), at(4000, 0));
    const [a, b] = nodeIds();

    store().setWallLength(wallIds()[0], 3210, 'b');
    expect(nodeAt(a)).toEqual({ x: 0, y: 0 });
    expect(nodeAt(b)).toEqual({ x: 3210, y: 0 });
  });

  test('moving the other end leaves b alone and is one undo step either way', () => {
    drawChain(at(0, 0), at(4000, 0));
    const [a, b] = nodeIds();
    const before = undoDepth();

    store().setWallLength(wallIds()[0], 3210, 'a');
    expect(nodeAt(a)).toEqual({ x: 790, y: 0 });
    expect(nodeAt(b)).toEqual({ x: 4000, y: 0 });
    expect(undoDepth()).toBe(before + 1);
  });

  test('walls attached to the moved corner follow it', () => {
    drawChain(at(0, 0), at(4000, 0), at(4000, 3000));
    const corner = level().walls[0].b;

    store().setWallLength(wallIds()[0], 5000, 'b');
    expect(nodeAt(corner)).toEqual({ x: 5000, y: 0 });
    expect(nodeAt(level().walls[1].a)).toEqual({ x: 5000, y: 0 });
  });

  test('a follower that would be left with no length is reported before the change, not after', () => {
    // Two walls off one corner, with the far corner of the second sitting exactly where the first
    // wall's end is headed.
    drawChain(at(0, 0), at(4000, 0));
    const corner = level().walls[0].b;
    store().drawTo({ on: 'node', node: corner });
    store().drawTo(at(2500, 0));
    store().endChain();

    const outcome = planLengthChange(level(), wallIds()[0], 2500, 'b');
    if (!outcome.ok) throw new Error('expected a change');
    expect(outcome.change.collapsing).toEqual([wallIds()[1]]);

    // And it is a warning, not a refusal: the change still applies, and `validate` then says so.
    store().setWallLength(wallIds()[0], 2500, 'b');
    expect(store().issues.map((i) => i.code)).toContain('WALL_ZERO_LENGTH');
  });

  test('a corner landing a few millimetres from another is reported before the change, not after', () => {
    // Two walls running east from the same corner, the shorter ending 2497mm along.
    drawChain(at(0, 0), at(4000, 0));
    const [origin] = nodeIds();
    store().drawTo({ on: 'node', node: origin });
    store().drawTo(at(2497, 0));
    store().endChain();

    const outcome = planLengthChange(level(), wallIds()[0], 2500, 'b');
    if (!outcome.ok) throw new Error('expected a change');
    expect(outcome.change.nearlyCoincident).toEqual([{ node: nodeIds()[2], distanceMm: 3 }]);

    // And the preview agrees with the validator, because both read the same tolerance.
    store().setWallLength(wallIds()[0], 2500, 'b');
    expect(store().issues.map((i) => i.code)).toContain('NODES_NEARLY_COINCIDENT');
  });

  test('an absurd length is refused rather than applied, and the corner does not move', () => {
    drawChain(at(0, 0), at(4000, 0));
    const [, b] = nodeIds();

    store().setWallLength(wallIds()[0], 140_000_000_000, 'b');
    expect(nodeAt(b)).toEqual({ x: 4000, y: 0 });
    expect(store().notice).toMatch(/longer than 50000mm/i);
    expect(undoDepth()).toBe(1); // The wall itself; nothing added by the refusal.
  });

  test('a length that is not a positive number is refused with an explanation', () => {
    drawChain(at(0, 0), at(4000, 0));
    store().setWallLength(wallIds()[0], 0, 'b');
    expect(store().notice).toMatch(/longer than nothing/i);
    expect(nodeAt(nodeIds()[1])).toEqual({ x: 4000, y: 0 });
  });
});

/* --- Deleting --------------------------------------------------------------------------------- */

describe('deleting', () => {
  beforeEach(() => store().reset(emptyPlan()));

  test('deleting a corner takes the walls pinned to it', () => {
    drawChain(at(0, 0), at(4000, 0), at(4000, 3000));
    const middle = level().walls[0].b;

    store().select([{ kind: 'node', id: middle }]);
    store().deleteSelection();

    expect(level().walls).toHaveLength(0);
    // Both far corners lost their last wall, so they went too rather than being left as litter.
    expect(level().nodes).toHaveLength(0);
    expect(validate(store().doc)).toEqual([]);
  });

  test('deleting a wall leaves corners that are still in use', () => {
    drawChain(at(0, 0), at(4000, 0), at(4000, 3000));
    store().select([{ kind: 'wall', id: wallIds()[0] }]);
    store().deleteSelection();

    expect(level().walls).toHaveLength(1);
    expect(level().nodes).toHaveLength(2); // The corner shared by both walls survives.
    expect(validate(store().doc)).toEqual([]);
  });

  test('deleting is one undo step, and undo brings everything back', () => {
    drawChain(at(0, 0), at(4000, 0), at(4000, 3000));
    const before = store().doc;
    const depth = undoDepth();

    store().select([{ kind: 'node', id: level().walls[0].b }]);
    store().deleteSelection();
    expect(undoDepth()).toBe(depth + 1);

    store().undo();
    expect(store().doc).toEqual(before);
  });

  test('a wall in the sample flat takes its openings and the rooms that ran along it', () => {
    store().reset(sampleFlat());
    // w22 divides the living room from bedroom 2 and carries door d6.
    store().select([{ kind: 'wall', id: 'w22' }]);
    store().deleteSelection();

    expect(wallIds()).not.toContain('w22');
    expect(level().openings.map((o) => o.id)).not.toContain('d6');
    expect(level().rooms.map((r) => r.id)).not.toContain('r6');
    expect(level().rooms.map((r) => r.id)).not.toContain('r7');
    expect(store().notice).toMatch(/Removed/);
  });

  test('deleting nothing does nothing', () => {
    drawChain(at(0, 0), at(4000, 0));
    const depth = undoDepth();
    store().select([]);
    store().deleteSelection();
    expect(undoDepth()).toBe(depth);
  });
});

/* --- Undo and redo ---------------------------------------------------------------------------- */

describe('undo and redo', () => {
  beforeEach(() => store().reset(emptyPlan()));

  test('undo then redo returns the document to exactly what it was, field for field', () => {
    const blank = store().doc;

    store().drawTo(at(0, 0));
    store().drawTo(at(4000, 0));
    store().endChain();
    const drawn = store().doc;

    store().undo();
    expect(store().doc).toEqual(blank);

    store().redo();
    expect(store().doc).toEqual(drawn);
  });

  test('undo unwinds one gesture at a time, in order', () => {
    drawChain(at(0, 0), at(4000, 0), at(4000, 3000), at(0, 3000));
    expect(level().walls).toHaveLength(3);

    store().undo();
    expect(level().walls).toHaveLength(2);
    store().undo();
    expect(level().walls).toHaveLength(1);
    store().undo();
    expect(level().walls).toHaveLength(0);
    store().undo(); // Nothing left; must not throw or corrupt.
    expect(level().walls).toHaveLength(0);
  });

  test('a new edit after an undo discards the redo stack', () => {
    drawChain(at(0, 0), at(4000, 0));
    store().undo();
    expect(store().history.future).toHaveLength(1);

    drawChain(at(0, 1000), at(4000, 1000));
    expect(store().history.future).toHaveLength(0);
  });

  test('undo is refused in the middle of a gesture, not applied to half of one', () => {
    drawChain(at(0, 0), at(4000, 0));
    const node = level().walls[0].b;

    store().beginGesture('Drag');
    store().moveNode(node, { x: 5000, y: 0 });
    store().undo();
    expect(nodeAt(node)).toEqual({ x: 5000, y: 0 });
    store().endGesture();

    store().undo();
    expect(nodeAt(node)).toEqual({ x: 4000, y: 0 });
  });

  test('the timestamp moves with the edit and comes back with the undo', () => {
    const before = store().doc.updatedAt;
    drawChain(at(0, 0), at(4000, 0));
    expect(store().doc.updatedAt).not.toBe(before);
    store().undo();
    expect(store().doc.updatedAt).toBe(before);
  });

  test('a fresh document clears the history rather than leaving patches that would splice one flat into another', () => {
    drawChain(at(0, 0), at(4000, 0));
    store().reset(sampleFlat());
    expect(store().history.past).toHaveLength(0);
    expect(store().history.future).toHaveLength(0);
  });

  test('selection that no longer exists is dropped after an undo', () => {
    drawChain(at(0, 0), at(4000, 0));
    store().select([{ kind: 'wall', id: wallIds()[0] }]);
    store().undo();
    expect(store().selection).toEqual([]);
  });
});

/* --- The one that matters --------------------------------------------------------------------- */

describe('a flat drawn from nothing', () => {
  test('validates clean', () => {
    store().reset(emptyPlan());

    // A 2-room flat: an outer 6000 x 4000 rectangle with a partition dropped onto the long walls.
    store().drawTo(at(0, 0));
    store().drawTo(at(6000, 0));
    store().drawTo(at(6000, 4000));
    store().drawTo(at(0, 4000));
    store().drawTo({ on: 'node', node: nodeIds()[0] });
    store().endChain();

    const north = level().walls[0].id;
    const south = level().walls[2].id;
    store().drawTo({ on: 'wall', wall: north, at: { x: 3500, y: 0 } });
    store().drawTo({ on: 'wall', wall: south, at: { x: 3500, y: 4000 } });
    store().endChain();

    store().setWallLength(north, 3500, 'b');

    expect(validate(store().doc)).toEqual([]);
    expect(level().walls).toHaveLength(7); // 4 outer, 2 of them split, plus the partition.
    expect(level().nodes).toHaveLength(6);
  });

  test('issues are recomputed on every change, not only when asked', () => {
    store().reset(emptyPlan());
    expect(store().issues).toEqual([]);

    // A lone corner, made by splitting nothing: draw a wall, then delete the wall but not its ends.
    drawChain(at(0, 0), at(4000, 0));
    expect(store().issues).toEqual([]);

    store().beginGesture('Drag');
    store().moveNode(nodeIds()[1], { x: 3, y: 0 });
    store().endGesture();

    expect(store().issues.map((i) => i.code)).toContain('WALL_TOO_SHORT');
  });
});
