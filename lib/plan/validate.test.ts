/**
 * Tests for `validate`. Fixtures are built inline and deliberately tiny: each one is the smallest
 * document that triggers the check under test, so a failure points at one thing.
 *
 * Every fixture goes through `PlanDocSchema.parse` on the way in. That is not ceremony — it proves
 * the fixture is a document that could really reach `validate` (zod-valid but nonsensical is exactly
 * the input class this function exists for), and it fills in the schema defaults so the tests do not
 * have to restate `heightMm: 2900` on every wall.
 *
 * The sample flat is a later task; nothing here waits on it.
 */

import { describe, expect, test } from 'vitest';
import type { z } from 'zod';

import { PlanDocSchema, type PlanDoc } from './schema';
import { validate, type Issue, type IssueCode } from './validate';

/* --- Fixture builders -------------------------------------------------------------------------- */

type RawDoc = z.input<typeof PlanDocSchema>;
type RawLevel = RawDoc['levels'][number];
type RawNode = RawLevel['nodes'][number];
type RawWall = RawLevel['walls'][number];
type RawOpening = RawLevel['openings'][number];
// `Partial<RawOpening>` would collapse the kind/leaf discriminators, so narrow first.
type RawHingedDoor = Extract<RawOpening, { leaf: 'hinged' }>;
type RawCasedOpening = Extract<RawOpening, { leaf: 'none' }>;
type RawWindow = Extract<RawOpening, { kind: 'window' }>;
type RawRoom = RawLevel['rooms'][number];
type RawItem = RawLevel['items'][number];
type RawAnchor = RawItem['anchor'];

const meta = { source: 'user', confidence: 1 } as const;

const CONFIRMED_SCALE: RawDoc['scale'] = {
  status: 'confirmed',
  mmPerPx: 10,
  reference: { lengthMm: 4000, lengthPx: 400 },
  confirmedAt: '2026-09-02T00:00:00Z',
};

function node(id: string, x: number, y: number): RawNode {
  return { id, x, y, meta };
}

function wall(id: string, a: string, b: string, over: Partial<RawWall> = {}): RawWall {
  return { id, a, b, thicknessMm: 115, ...over, meta };
}

function door(
  id: string,
  wallId: string,
  offsetMm: number,
  over: Partial<Omit<RawHingedDoor, 'kind' | 'leaf'>> = {},
): RawHingedDoor {
  return {
    id,
    wall: wallId,
    kind: 'door',
    leaf: 'hinged',
    offsetMm,
    widthMm: 900,
    heightMm: 2100,
    sillMm: 0,
    swing: { side: 'right', hinge: 'a' },
    ...over,
    meta,
  };
}

/** A doorway with no leaf in it. */
function casedOpening(
  id: string,
  wallId: string,
  offsetMm: number,
  over: Partial<Omit<RawCasedOpening, 'kind' | 'leaf'>> = {},
): RawCasedOpening {
  return { id, wall: wallId, kind: 'door', leaf: 'none', offsetMm, widthMm: 1200, heightMm: 2100, sillMm: 0, ...over, meta };
}

function windowOpening(id: string, wallId: string, offsetMm: number, over: Partial<Omit<RawWindow, 'kind'>> = {}): RawWindow {
  return { id, wall: wallId, kind: 'window', offsetMm, widthMm: 1200, heightMm: 1200, sillMm: 900, ...over, meta };
}

function room(id: string, name: string, wallLoop: string[]): RawRoom {
  return { id, name, wallLoop, meta };
}

function item(id: string, anchor: RawAnchor): RawItem {
  return { id, kind: 'retrieved', category: 'lamp', asset: 'floor-lamp-01', anchor, meta };
}

/** A level with nothing in it; spread in only the collections a test cares about. */
function level(over: Partial<RawLevel> = {}): RawLevel {
  return {
    id: 'l0',
    name: 'Ground',
    elevationMm: 0,
    nodes: [],
    walls: [],
    openings: [],
    rooms: [],
    items: [],
    ...over,
    meta,
  };
}

function makeDoc(levels: RawLevel[], scale: RawDoc['scale'] = CONFIRMED_SCALE): PlanDoc {
  return PlanDocSchema.parse({
    schemaVersion: 1,
    id: 'p1',
    name: 'Test flat',
    units: 'mm',
    scale,
    levels,
    createdAt: '2026-09-02T00:00:00Z',
    updatedAt: '2026-09-02T00:00:00Z',
  });
}

/** One 4000 x 3000 room, four walls, one door: the smallest document that should be clean. */
function cleanDoc(): PlanDoc {
  return makeDoc([
    level({
      nodes: [node('n1', 0, 0), node('n2', 4000, 0), node('n3', 4000, 3000), node('n4', 0, 3000)],
      walls: [wall('w1', 'n1', 'n2'), wall('w2', 'n2', 'n3'), wall('w3', 'n3', 'n4'), wall('w4', 'n4', 'n1')],
      openings: [door('d1', 'w1', 900)],
      rooms: [room('r1', 'Living Room', ['w1', 'w2', 'w3', 'w4'])],
    }),
  ]);
}

const codes = (issues: Issue[]): IssueCode[] => issues.map((i) => i.code);
const errors = (issues: Issue[]): Issue[] => issues.filter((i) => i.severity === 'error');

/* --- Clean --------------------------------------------------------------------------------------- */

test('a valid document produces no issues at all', () => {
  expect(validate(cleanDoc())).toEqual([]);
});

/* --- Identity ------------------------------------------------------------------------------------ */

describe('identity', () => {
  test('DUPLICATE_ID within one collection', () => {
    const doc = makeDoc([
      level({ nodes: [node('n1', 0, 0), node('n1', 500, 0), node('n2', 4000, 0)], walls: [wall('w1', 'n1', 'n2')] }),
    ]);
    expect(codes(validate(doc))).toContain('DUPLICATE_ID');
  });

  test('DUPLICATE_ID across collections, naming both', () => {
    const doc = makeDoc([
      level({ nodes: [node('x1', 0, 0), node('n2', 4000, 0)], walls: [wall('x1', 'x1', 'n2')] }),
    ]);
    const found = validate(doc).find((i) => i.code === 'DUPLICATE_ID');
    expect(found?.message).toContain('1 node and 1 wall');
    expect(found?.refs.map((r) => r.kind).sort()).toEqual(['node', 'wall']);
  });

  test('DUPLICATE_LEVEL_ID is a document-level issue', () => {
    const doc = makeDoc([level(), level()]);
    const found = validate(doc).find((i) => i.code === 'DUPLICATE_LEVEL_ID');
    expect(found?.severity).toBe('error');
    expect(found?.levelId).toBeNull();
  });
});

/* --- Reference integrity ------------------------------------------------------------------------- */

describe('reference integrity', () => {
  test('WALL_ORPHAN_NODE', () => {
    const doc = makeDoc([level({ nodes: [node('n1', 0, 0)], walls: [wall('w1', 'n1', 'nowhere')] })]);
    const found = validate(doc).find((i) => i.code === 'WALL_ORPHAN_NODE');
    expect(found?.message).toContain('"nowhere"');
  });

  test('OPENING_ORPHAN_WALL', () => {
    const doc = makeDoc([level({ openings: [door('d1', 'ghost', 900)] })]);
    expect(codes(validate(doc))).toContain('OPENING_ORPHAN_WALL');
  });

  test('ROOM_ORPHAN_WALL', () => {
    const doc = makeDoc([
      level({
        nodes: [node('n1', 0, 0), node('n2', 4000, 0), node('n3', 4000, 3000)],
        walls: [wall('w1', 'n1', 'n2'), wall('w2', 'n2', 'n3')],
        rooms: [room('r1', 'Kitchen', ['w1', 'w2', 'w9'])],
      }),
    ]);
    expect(codes(validate(doc))).toContain('ROOM_ORPHAN_WALL');
  });

  test('ITEM_ORPHAN_ANCHOR for a missing room', () => {
    const doc = makeDoc([level({ items: [item('i1', { on: 'room', room: 'r9' })] })]);
    const found = validate(doc).find((i) => i.code === 'ITEM_ORPHAN_ANCHOR');
    expect(found?.message).toContain('room "r9"');
  });

  test('a broken reference is reported once, without consequential noise', () => {
    // The wall does not exist, so the door cannot also be accused of not fitting it.
    const doc = makeDoc([level({ openings: [door('d1', 'ghost', 99999, { widthMm: 5000 })] })]);
    expect(codes(validate(doc))).toEqual(['OPENING_ORPHAN_WALL']);
  });

  test('reference errors are reported before geometry ones', () => {
    const doc = makeDoc([
      level({
        nodes: [node('n1', 0, 0), node('n2', 3, 0)],
        walls: [wall('w1', 'n1', 'gone')],
      }),
    ]);
    const list = codes(validate(doc));
    expect(list.indexOf('WALL_ORPHAN_NODE')).toBeLessThan(list.indexOf('NODES_NEARLY_COINCIDENT'));
  });
});

/* --- Anchor cycles -------------------------------------------------------------------------------- */

describe('anchor cycles', () => {
  test('ITEM_ANCHOR_CYCLE for a two-item loop', () => {
    const doc = makeDoc([
      level({
        items: [
          item('i1', { on: 'item', item: 'i2', relation: 'left-of' }),
          item('i2', { on: 'item', item: 'i1', relation: 'left-of' }),
        ],
      }),
    ]);
    expect(codes(validate(doc))).toEqual(['ITEM_ANCHOR_CYCLE']);
  });

  test('terminates on a three-item cycle and reports it once', () => {
    const doc = makeDoc([
      level({
        items: [
          item('i1', { on: 'item', item: 'i2', relation: 'left-of' }),
          item('i2', { on: 'item', item: 'i3', relation: 'left-of' }),
          item('i3', { on: 'item', item: 'i1', relation: 'left-of' }),
        ],
      }),
    ]);
    const found = validate(doc).filter((i) => i.code === 'ITEM_ANCHOR_CYCLE');
    expect(found).toHaveLength(1);
    expect(found[0].refs.map((r) => r.id).sort()).toEqual(['i1', 'i2', 'i3']);
  });

  test('an item anchored to itself is a cycle', () => {
    const doc = makeDoc([level({ items: [item('i1', { on: 'item', item: 'i1', relation: 'on-top-of' })] })]);
    expect(codes(validate(doc))).toEqual(['ITEM_ANCHOR_CYCLE']);
  });

  test('a long chain that does not close is fine', () => {
    const doc = makeDoc([
      level({
        nodes: [node('n1', 0, 0), node('n2', 4000, 0)],
        walls: [wall('w1', 'n1', 'n2')],
        items: [
          item('i1', { on: 'wall', wall: 'w1', offsetMm: 500, side: 'left' }),
          item('i2', { on: 'item', item: 'i1', relation: 'left-of' }),
          item('i3', { on: 'item', item: 'i2', relation: 'left-of' }),
        ],
      }),
    ]);
    expect(validate(doc)).toEqual([]);
  });
});

/* --- Walls ---------------------------------------------------------------------------------------- */

describe('walls', () => {
  test('WALL_ZERO_LENGTH when both ends are the same node', () => {
    const doc = makeDoc([level({ nodes: [node('n1', 0, 0)], walls: [wall('w1', 'n1', 'n1')] })]);
    expect(codes(validate(doc))).toContain('WALL_ZERO_LENGTH');
  });

  test('WALL_ZERO_LENGTH when two distinct nodes sit at the same point', () => {
    const doc = makeDoc([
      level({ nodes: [node('n1', 1200, 500), node('n2', 1200, 500)], walls: [wall('w1', 'n1', 'n2')] }),
    ]);
    const found = validate(doc).find((i) => i.code === 'WALL_ZERO_LENGTH');
    expect(found?.message).toContain('(1200, 500)');
  });

  test('WALL_TOO_SHORT is a warning with the real length', () => {
    const doc = makeDoc([level({ nodes: [node('n1', 0, 0), node('n2', 40, 0)], walls: [wall('w1', 'n1', 'n2')] })]);
    const found = validate(doc).find((i) => i.code === 'WALL_TOO_SHORT');
    expect(found?.severity).toBe('warning');
    expect(found?.message).toContain('40mm');
  });

  test('a wall exactly at the 100mm threshold is not flagged', () => {
    const doc = makeDoc([level({ nodes: [node('n1', 0, 0), node('n2', 100, 0)], walls: [wall('w1', 'n1', 'n2')] })]);
    expect(codes(validate(doc))).not.toContain('WALL_TOO_SHORT');
  });

  test('NODES_NEARLY_COINCIDENT', () => {
    const doc = makeDoc([
      level({
        nodes: [node('n1', 0, 0), node('n2', 4000, 0), node('n3', 4003, 0)],
        walls: [wall('w1', 'n1', 'n2'), wall('w2', 'n2', 'n3')],
      }),
    ]);
    const found = validate(doc).find((i) => i.code === 'NODES_NEARLY_COINCIDENT');
    expect(found?.message).toContain('3mm apart');
  });

  test('NODE_UNREFERENCED', () => {
    const doc = makeDoc([
      level({ nodes: [node('n1', 0, 0), node('n2', 4000, 0), node('n9', 9000, 9000)], walls: [wall('w1', 'n1', 'n2')] }),
    ]);
    const found = validate(doc).find((i) => i.code === 'NODE_UNREFERENCED');
    expect(found?.severity).toBe('warning');
    expect(found?.refs).toEqual([{ kind: 'node', id: 'n9' }]);
  });
});

/* --- Openings -------------------------------------------------------------------------------------- */

describe('openings', () => {
  const wallLevel = (openings: RawOpening[], lengthMm = 2800, over: Partial<RawWall> = {}): PlanDoc =>
    makeDoc([
      level({
        nodes: [node('n1', 0, 0), node('n2', lengthMm, 0)],
        walls: [wall('w1', 'n1', 'n2', over)],
        openings,
      }),
    ]);

  test('OPENING_PAST_WALL_END reports the overshoot in millimetres', () => {
    const found = validate(wallLevel([door('d1', 'w1', 2100)])).find((i) => i.code === 'OPENING_PAST_WALL_END');
    expect(found?.message).toBe(
      'The 900mm door d1 starts 2100mm along wall w1 and would end 200mm past the end of that wall, which is 2800mm long.',
    );
  });

  test('an opening ending exactly at the far end fits', () => {
    expect(codes(validate(wallLevel([door('d1', 'w1', 1900)])))).not.toContain('OPENING_PAST_WALL_END');
  });

  test('OPENING_WIDER_THAN_WALL gets its own message rather than the offset one', () => {
    const found = codes(validate(wallLevel([door('d1', 'w1', 0, { widthMm: 3200 })])));
    expect(found).toContain('OPENING_WIDER_THAN_WALL');
    expect(found).not.toContain('OPENING_PAST_WALL_END');
  });

  test('OPENING_TALLER_THAN_WALL', () => {
    const found = validate(wallLevel([windowOpening('v1', 'w1', 500, { sillMm: 2000, heightMm: 1200 })])).find(
      (i) => i.code === 'OPENING_TALLER_THAN_WALL',
    );
    expect(found?.message).toContain('3200mm above the floor');
    expect(found?.message).toContain('2900mm tall');
  });

  test('OPENING_OVERLAP names both openings and the overlap', () => {
    const found = validate(wallLevel([door('d1', 'w1', 0), door('d2', 'w1', 600)])).find(
      (i) => i.code === 'OPENING_OVERLAP',
    );
    expect(found?.message).toContain('300mm');
    expect(found?.refs.map((r) => r.id)).toEqual(['d1', 'd2', 'w1']);
  });

  test('two openings touching end to end do not overlap', () => {
    expect(codes(validate(wallLevel([door('d1', 'w1', 0), door('d2', 'w1', 900)])))).not.toContain('OPENING_OVERLAP');
  });
});

/* --- Leafless openings ------------------------------------------------------------------------------ */

describe('cased openings', () => {
  /** One triangular room: every one of its walls has outdoors on the other side. */
  const oneRoom = (openings: RawOpening[]): PlanDoc =>
    makeDoc([
      level({
        nodes: [node('n1', 0, 0), node('n2', 4000, 0), node('n3', 0, 3000)],
        walls: [wall('w1', 'n1', 'n2'), wall('w2', 'n2', 'n3'), wall('w3', 'n3', 'n1')],
        openings,
        rooms: [room('r1', 'Studio', ['w1', 'w2', 'w3'])],
      }),
    ]);

  /** Two rooms side by side sharing the middle wall w7. */
  const twoRooms = (openings: RawOpening[]): PlanDoc =>
    makeDoc([
      level({
        nodes: [
          node('n1', 0, 0),
          node('n2', 4000, 0),
          node('n3', 8000, 0),
          node('n4', 8000, 3000),
          node('n5', 4000, 3000),
          node('n6', 0, 3000),
        ],
        walls: [
          wall('w1', 'n1', 'n2'),
          wall('w2', 'n2', 'n3'),
          wall('w3', 'n3', 'n4'),
          wall('w4', 'n4', 'n5'),
          wall('w5', 'n5', 'n6'),
          wall('w6', 'n6', 'n1'),
          wall('w7', 'n2', 'n5'),
        ],
        openings,
        rooms: [room('r1', 'Living', ['w1', 'w7', 'w5', 'w6']), room('r2', 'Dining', ['w2', 'w3', 'w4', 'w7'])],
      }),
    ]);

  test('OPENING_NO_LEAF_ON_EXTERNAL_WALL when the wall bounds only one room', () => {
    const found = validate(oneRoom([casedOpening('d1', 'w1', 1000)])).find(
      (i) => i.code === 'OPENING_NO_LEAF_ON_EXTERNAL_WALL',
    );
    expect(found?.severity).toBe('error');
    expect(found?.message).toContain('"Studio"');
    expect(found?.refs.map((r) => r.id)).toEqual(['d1', 'w1', 'r1']);
  });

  test('a hinged door or a slider on the same wall is fine', () => {
    expect(codes(validate(oneRoom([door('d1', 'w1', 1000)])))).not.toContain('OPENING_NO_LEAF_ON_EXTERNAL_WALL');
    expect(
      codes(validate(oneRoom([{ ...casedOpening('d1', 'w1', 1000), leaf: 'sliding' }]))),
    ).not.toContain('OPENING_NO_LEAF_ON_EXTERNAL_WALL');
  });

  test('a cased opening between two rooms is exactly what they are for', () => {
    expect(validate(twoRooms([casedOpening('d1', 'w7', 1000)]))).toEqual([]);
  });

  test('a wall in no room loop is not assumed to be external', () => {
    // Half-drawn plans have walls and no rooms yet; shouting at that user helps nobody.
    const doc = makeDoc([
      level({
        nodes: [node('n1', 0, 0), node('n2', 4000, 0)],
        walls: [wall('w1', 'n1', 'n2')],
        openings: [casedOpening('d1', 'w1', 1000)],
      }),
    ]);
    expect(codes(validate(doc))).not.toContain('OPENING_NO_LEAF_ON_EXTERNAL_WALL');
  });

  test('a cased opening still counts as a way into a room', () => {
    expect(codes(validate(twoRooms([casedOpening('d1', 'w7', 1000)])))).not.toContain('ROOM_NO_DOOR');
  });
});

/* --- Rooms ----------------------------------------------------------------------------------------- */

describe('rooms', () => {
  test('ROOM_LOOP_BROKEN names the pair of walls that fail to meet', () => {
    const doc = makeDoc([
      level({
        nodes: [node('n1', 0, 0), node('n2', 4000, 0), node('n3', 4000, 3000), node('n5', 9000, 9000), node('n6', 9000, 12000)],
        walls: [wall('w1', 'n1', 'n2'), wall('w2', 'n2', 'n3'), wall('w3', 'n5', 'n6')],
        rooms: [room('r1', 'Master Bedroom', ['w1', 'w2', 'w3'])],
      }),
    ]);
    const found = validate(doc).find((i) => i.code === 'ROOM_LOOP_BROKEN');
    expect(found?.message).toContain('wall w2');
    expect(found?.message).toContain('wall w3');
    expect(found?.refs.map((r) => r.id)).toEqual(['r1', 'w2', 'w3']);
  });

  test('ROOM_LOOP_REPEATED_WALL', () => {
    const doc = makeDoc([
      level({
        nodes: [node('n1', 0, 0), node('n2', 4000, 0), node('n3', 4000, 3000)],
        walls: [wall('w1', 'n1', 'n2'), wall('w2', 'n2', 'n3')],
        rooms: [room('r1', 'Study', ['w1', 'w2', 'w2'])],
      }),
    ]);
    const found = validate(doc).find((i) => i.code === 'ROOM_LOOP_REPEATED_WALL');
    expect(found?.message).toContain('2 times');
  });

  test('ROOM_NO_DOOR is a warning, not an error', () => {
    const doc = cleanDoc();
    const withoutDoor = makeDoc([
      level({
        nodes: doc.levels[0].nodes,
        walls: doc.levels[0].walls,
        rooms: doc.levels[0].rooms,
      }),
    ]);
    const found = validate(withoutDoor).find((i) => i.code === 'ROOM_NO_DOOR');
    expect(found?.severity).toBe('warning');
    expect(errors(validate(withoutDoor))).toEqual([]);
  });

  test('a window does not count as a way in', () => {
    const doc = makeDoc([
      level({
        nodes: [node('n1', 0, 0), node('n2', 4000, 0), node('n3', 4000, 3000), node('n4', 0, 3000)],
        walls: [wall('w1', 'n1', 'n2'), wall('w2', 'n2', 'n3'), wall('w3', 'n3', 'n4'), wall('w4', 'n4', 'n1')],
        openings: [windowOpening('v1', 'w1', 900)],
        rooms: [room('r1', 'Balcony', ['w1', 'w2', 'w3', 'w4'])],
      }),
    ]);
    expect(codes(validate(doc))).toContain('ROOM_NO_DOOR');
  });

  test('ROOM_NAME_DUPLICATE', () => {
    const doc = makeDoc([
      level({
        nodes: [node('n1', 0, 0), node('n2', 4000, 0), node('n3', 4000, 3000), node('n4', 0, 3000)],
        walls: [wall('w1', 'n1', 'n2'), wall('w2', 'n2', 'n3'), wall('w3', 'n3', 'n4'), wall('w4', 'n4', 'n1')],
        openings: [door('d1', 'w1', 900)],
        rooms: [room('r1', 'Bedroom', ['w1', 'w2', 'w3', 'w4']), room('r2', 'Bedroom', ['w1', 'w2', 'w3', 'w4'])],
      }),
    ]);
    const found = validate(doc).find((i) => i.code === 'ROOM_NAME_DUPLICATE');
    expect(found?.severity).toBe('warning');
    expect(found?.refs.map((r) => r.id)).toEqual(['r1', 'r2']);
  });
});

/* --- Items ------------------------------------------------------------------------------------------ */

describe('items', () => {
  test('ITEM_ANCHOR_PAST_WALL_END', () => {
    const doc = makeDoc([
      level({
        nodes: [node('n1', 0, 0), node('n2', 4000, 0)],
        walls: [wall('w1', 'n1', 'n2')],
        items: [item('i1', { on: 'wall', wall: 'w1', offsetMm: 5000, side: 'left' })],
      }),
    ]);
    const found = validate(doc).find((i) => i.code === 'ITEM_ANCHOR_PAST_WALL_END');
    expect(found?.message).toContain('5000mm along wall w1');
    expect(found?.message).toContain('only 4000mm long');
  });

  test('an item anchored at the far end of the wall is fine', () => {
    const doc = makeDoc([
      level({
        nodes: [node('n1', 0, 0), node('n2', 4000, 0)],
        walls: [wall('w1', 'n1', 'n2')],
        items: [item('i1', { on: 'wall', wall: 'w1', offsetMm: 4000, side: 'right' })],
      }),
    ]);
    expect(validate(doc)).toEqual([]);
  });
});

/* --- Scale ------------------------------------------------------------------------------------------- */

describe('scale', () => {
  test('an unconfirmed scale is a warning and nothing else', () => {
    const doc = makeDoc([level()], { status: 'unconfirmed', suggestedMmPerPx: 12.5 });
    const issues = validate(doc);
    expect(codes(issues)).toEqual(['SCALE_UNCONFIRMED']);
    expect(errors(issues)).toEqual([]);
    expect(issues[0].levelId).toBeNull();
  });

  test('a confirmed scale produces nothing', () => {
    expect(codes(validate(cleanDoc()))).not.toContain('SCALE_UNCONFIRMED');
  });
});

/* --- Several problems at once -------------------------------------------------------------------------- */

test('a document with several distinct problems reports all of them', () => {
  const doc = makeDoc(
    [
      level({
        nodes: [node('n1', 0, 0), node('n2', 2800, 0), node('n2', 2803, 0), node('n4', 0, 3000)],
        walls: [wall('w1', 'n1', 'n2'), wall('w2', 'n4', 'missing')],
        openings: [door('d1', 'w1', 2100), windowOpening('v1', 'w1', 0, { sillMm: 2500, heightMm: 1200 })],
        rooms: [room('r1', 'Hall', ['w1', 'w2', 'w1'])],
        items: [item('i1', { on: 'wall', wall: 'w1', offsetMm: 9000, side: 'left' })],
      }),
    ],
    { status: 'unconfirmed' },
  );

  const found = new Set(codes(validate(doc)));
  for (const expected of [
    'DUPLICATE_ID',
    'WALL_ORPHAN_NODE',
    'NODES_NEARLY_COINCIDENT',
    'OPENING_PAST_WALL_END',
    'OPENING_TALLER_THAN_WALL',
    'ROOM_LOOP_REPEATED_WALL',
    'ITEM_ANCHOR_PAST_WALL_END',
    'SCALE_UNCONFIRMED',
  ] satisfies IssueCode[]) {
    expect([...found]).toContain(expected);
  }
});

test('every issue carries refs and a message with something quantitative or named in it', () => {
  const doc = makeDoc([
    level({
      nodes: [node('n1', 0, 0), node('n2', 40, 0)],
      walls: [wall('w1', 'n1', 'n2')],
      openings: [door('d1', 'w1', 30)],
    }),
  ]);
  for (const found of validate(doc)) {
    expect(found.refs.length).toBeGreaterThan(0);
    expect(found.message.length).toBeGreaterThan(20);
    expect(found.levelId).toBe('l0');
  }
});
