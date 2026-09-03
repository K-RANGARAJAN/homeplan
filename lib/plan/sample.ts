/**
 * lib/plan/sample.ts — a hand-authored 2BHK, used as the fixture for everything downstream.
 *
 * This is a typical Indian builder 2BHK: two bedrooms, the master with an attached bathroom, a
 * common bathroom off a short passage, a kitchen, an L-shaped living/dining you enter into, and a
 * long front balcony. It exists so the 3D viewport, wall mitering, portal culling, the placement
 * solver and the screenshot pass can all be built and debugged before upload and extraction exist,
 * and so "did I break something" is a one-second question.
 *
 * It is deliberately not a box. There are eleven T-junctions and one four-way junction (n16), an
 * L-shaped room, two wall thicknesses and a 1100mm balcony parapet — precisely the things a naive
 * per-wall offset gets wrong. A fixture that passes everything teaches nothing.
 *
 * CONVENTIONS — every later piece of geometry depends on these:
 *
 *   - Origin (0, 0) is the junction of the two external wall CENTRELINES at the top-left corner of
 *     the flat. Nodes are centrelines, not faces: a wall's material occupies thicknessMm/2 either
 *     side of the line between its nodes. The outside face of the flat is therefore at x = -115,
 *     y = -115. Centrelines are what keep these literals round numbers a builder would recognise.
 *   - x increases to the right (east). **y increases downward (south)**, matching screen and SVG
 *     coordinates, so the 2D editor needs no flip. The three.js boundary maps plan (x, y) to world
 *     (x, z) and is the only place that changes.
 *   - "left" and "right" of a wall mean left and right as a person walking from node `a` to node
 *     `b` would experience them, looking down at the plan: for a direction (dx, dy), the left side
 *     is the half-plane that (dy, -dx) points into. Walking east, north is on your left. Door
 *     swings below are chosen against that convention.
 *
 * AREAS. Internal (carpet) area works out at ~93.7 m^2 / ~1009 sq ft including the balcony, and
 * ~84.8 m^2 / ~913 sq ft excluding it, which is the RERA convention. Per-room figures are on each
 * room below.
 *
 *   y=0     n1─────w1─────n2──w2──n3─w3─n4──────w4──────n5
 *           │             │      │     │                │
 *           │   Master    │ M.   │ C.  │                │
 *           │   bedroom   │ bath │ bath│    Kitchen     │
 *   y=2500  │             n12─w15─n14─w16─n15           │
 *           │             │     Passage   │             │
 *   y=4000  n11────w19────n13──────w20────n16────w21────n6
 *           │                             │             │
 *           │      Living / dining        │  Bedroom 2  │
 *   y=7600  │             n18─────w23─────n17────w24────n7
 *           │             │          Balcony            │
 *   y=9000  n10─────w9────n9──────────────w8────────────n8
 *
 *           x=0        x=4000  x=6100  x=7900       x=11400
 */

import {
  SCHEMA_VERSION,
  type CasedOpening,
  type HingedDoor,
  type Meta,
  type PlanDoc,
  type PlanNode,
  type PlanWindow,
  type Room,
  type SlidingDoor,
  type Wall,
} from './schema';

/* ------------------------------------------------------------------------------------------------
 * Constants
 * ---------------------------------------------------------------------------------------------- */

/** 230mm external, 115mm internal: standard Indian brickwork. Drawing an external wall at 115 makes
 *  the whole 3D shell read wrong — the reveals at every window are half as deep as they should be. */
const EXTERNAL_MM = 230;
const PARTITION_MM = 115;

const CEILING_MM = 2900;
/** The balcony's outer walls are a parapet, not a wall. This is what per-wall `heightMm` is for. */
const PARAPET_MM = 1100;

/** Door heads and window heads both land at 2100mm, which is what makes an elevation look right. */
const DOOR_HEAD_MM = 2100;
const WINDOW_SILL_MM = 900;
const WINDOW_HEIGHT_MM = 1200;
/** Bathroom windows sit above head height for privacy, and are smaller. */
const BATH_SILL_MM = 1500;
const BATH_WINDOW_HEIGHT_MM = 900;

/* ------------------------------------------------------------------------------------------------
 * Builders
 *
 * These exist to keep the geometry legible: without them every line carries an identical `meta` and
 * `heightMm` and the file becomes 200 lines of indistinguishable numbers. They build literals — this
 * function never runs the document through `PlanDocSchema.parse`, so the test can prove the literals
 * are correct rather than proving zod's defaults are.
 *
 * `authored()` returns a NEW meta object every call. A shared constant would be handed to all 60-odd
 * elements and to every document this function ever returns, so one test writing to a `meta` would
 * reach into every other test's fixture.
 * ---------------------------------------------------------------------------------------------- */

const authored = (): Meta => ({ source: 'user', confidence: 1 });

const node = (id: string, x: number, y: number): PlanNode => ({ id, x, y, meta: authored() });

const wall = (id: string, a: string, b: string, thicknessMm: number, heightMm = CEILING_MM): Wall => ({
  id,
  a,
  b,
  thicknessMm,
  heightMm,
  meta: authored(),
});

const doorway = (id: string, wallId: string, offsetMm: number, widthMm: number) => ({
  id,
  wall: wallId,
  kind: 'door' as const,
  offsetMm,
  widthMm,
  heightMm: DOOR_HEAD_MM,
  sillMm: 0,
  meta: authored(),
});

const hingedDoor = (
  id: string,
  wallId: string,
  offsetMm: number,
  widthMm: number,
  side: 'left' | 'right',
  hinge: 'a' | 'b',
): HingedDoor => ({ ...doorway(id, wallId, offsetMm, widthMm), leaf: 'hinged', swing: { side, hinge } });

const slidingDoor = (id: string, wallId: string, offsetMm: number, widthMm: number): SlidingDoor => ({
  ...doorway(id, wallId, offsetMm, widthMm),
  leaf: 'sliding',
});

const casedOpening = (id: string, wallId: string, offsetMm: number, widthMm: number): CasedOpening => ({
  ...doorway(id, wallId, offsetMm, widthMm),
  leaf: 'none',
});

const window_ = (
  id: string,
  wallId: string,
  offsetMm: number,
  widthMm: number,
  sillMm = WINDOW_SILL_MM,
  heightMm = WINDOW_HEIGHT_MM,
): PlanWindow => ({ id, wall: wallId, kind: 'window', offsetMm, widthMm, heightMm, sillMm, meta: authored() });

const room = (id: string, name: string, wallLoop: string[]): Room => ({ id, name, wallLoop, meta: authored() });

/* ------------------------------------------------------------------------------------------------
 * The flat
 * ---------------------------------------------------------------------------------------------- */

/**
 * A fresh document every call.
 *
 * Not an exported constant: the app mutates documents through immer and tests mutate fixtures, so a
 * shared object would let one test's edit leak into the next and produce failures that depend on
 * file order — the worst kind to debug.
 */
export function sampleFlat(): PlanDoc {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: 'sample-2bhk',
    name: 'Sample 2BHK',
    units: 'mm',
    region: 'IN',

    // A real calibration: the master bedroom's north wall, 4000mm, measured 400px on the source
    // image. Confirmed, because an unconfirmed scale trips the scale gate and the fixture would be
    // unusable in the viewport — which is the one thing it exists for.
    scale: {
      status: 'confirmed',
      mmPerPx: 10,
      reference: { lengthMm: 4000, lengthPx: 400, label: 'North wall of the master bedroom (w1)' },
      confirmedAt: '2026-09-03T09:00:00.000Z',
    },

    levels: [
      {
        id: 'l0',
        name: 'Ground',
        elevationMm: 0,
        meta: authored(),

        // Every junction is a node, and every wall is CUT at each junction it passes through. A
        // single long external wall running past two rooms would be simpler to write and would make
        // both room loops fail to close: `wallLoop` needs consecutive walls to share a node, and a
        // partition landing halfway along an uncut wall shares nothing with it.
        nodes: [
          node('n1', 0, 0),
          node('n2', 4000, 0),
          node('n3', 6100, 0),
          node('n4', 7900, 0),
          node('n5', 11400, 0),
          node('n6', 11400, 4000),
          node('n7', 11400, 7600),
          node('n8', 11400, 9000),
          node('n9', 4000, 9000),
          node('n10', 0, 9000),
          node('n11', 0, 4000),
          node('n12', 4000, 2500),
          node('n13', 4000, 4000),
          node('n14', 6100, 2500),
          node('n15', 7900, 2500),
          node('n16', 7900, 4000),
          node('n17', 7900, 7600),
          node('n18', 4000, 7600),
        ],

        walls: [
          // External shell, 230mm, clockwise from the top-left. Cut at n2/n3/n4 (partitions between
          // master, both bathrooms and kitchen), n6/n7 (kitchen | bedroom 2 | balcony) and n9.
          wall('w1', 'n1', 'n2', EXTERNAL_MM), // north: master bedroom
          wall('w2', 'n2', 'n3', EXTERNAL_MM), // north: master bathroom
          wall('w3', 'n3', 'n4', EXTERNAL_MM), // north: common bathroom
          wall('w4', 'n4', 'n5', EXTERNAL_MM), // north: kitchen
          wall('w5', 'n5', 'n6', EXTERNAL_MM), // east: kitchen
          wall('w6', 'n6', 'n7', EXTERNAL_MM), // east: bedroom 2
          wall('w7', 'n7', 'n8', EXTERNAL_MM, PARAPET_MM), // east: balcony parapet
          wall('w8', 'n8', 'n9', EXTERNAL_MM, PARAPET_MM), // south: balcony parapet
          wall('w9', 'n9', 'n10', EXTERNAL_MM), // south: living / dining
          wall('w10', 'n10', 'n11', EXTERNAL_MM), // west: living / dining, holds the front door
          wall('w11', 'n11', 'n1', EXTERNAL_MM), // west: master bedroom

          // Internal partitions, 115mm. Each is labelled with the two rooms it separates — that is
          // the thing to check when the loops stop closing.
          wall('w12', 'n2', 'n12', PARTITION_MM), // master bedroom | master bathroom
          wall('w13', 'n12', 'n13', PARTITION_MM), // master bedroom | passage
          wall('w14', 'n3', 'n14', PARTITION_MM), // master bathroom | common bathroom
          wall('w15', 'n12', 'n14', PARTITION_MM), // master bathroom | passage
          wall('w16', 'n14', 'n15', PARTITION_MM), // common bathroom | passage
          wall('w17', 'n4', 'n15', PARTITION_MM), // common bathroom | kitchen
          wall('w18', 'n15', 'n16', PARTITION_MM), // passage | kitchen
          wall('w19', 'n11', 'n13', PARTITION_MM), // master bedroom | living
          wall('w20', 'n13', 'n16', PARTITION_MM), // passage | living
          wall('w21', 'n16', 'n6', PARTITION_MM), // kitchen | bedroom 2
          wall('w22', 'n16', 'n17', PARTITION_MM), // living | bedroom 2
          wall('w23', 'n18', 'n17', PARTITION_MM), // living | balcony
          wall('w24', 'n17', 'n7', PARTITION_MM), // bedroom 2 | balcony
          wall('w25', 'n18', 'n9', PARTITION_MM), // living | balcony
        ],

        openings: [
          // Hinged doors, at NBC widths: main 1000, bedroom 900, kitchen 800, bathroom 750. Offsets
          // are absolute millimetres from node `a` of the named wall, and swings are chosen so each
          // leaf opens the way it would be hung: bedroom and bathroom doors into the room they
          // serve, the front door inward. Each of these costs its room a 90 degree sector of floor.
          hingedDoor('d1', 'w10', 800, 1000, 'right', 'a'), // front door, opens into the living room
          hingedDoor('d2', 'w13', 300, 900, 'right', 'b'), // passage -> master bedroom
          hingedDoor('d3', 'w12', 1400, 750, 'left', 'b'), // master bedroom -> master bathroom
          hingedDoor('d4', 'w16', 525, 750, 'left', 'a'), // passage -> common bathroom
          hingedDoor('d5', 'w18', 350, 800, 'left', 'a'), // passage -> kitchen
          hingedDoor('d6', 'w22', 400, 900, 'left', 'a'), // living -> bedroom 2

          // The passage opens off the living room through a 1200mm cased opening — a lined hole in
          // the wall with nothing hanging in it, which is how these are actually built. It takes no
          // floor from either room. Without it the flat would be unwalkable: there would be no way
          // from the front door to either bedroom.
          casedOpening('d7', 'w20', 1350, 1200),

          // Balcony access is a 1200mm slider, which is what a builder fits here: the leaf runs
          // along the wall instead of swinging into a living room that wants that floor for a sofa.
          slidingDoor('d8', 'w23', 1350, 1200),

          // Windows: sill 900, height 1200, so heads land at 2100 alongside the door heads.
          window_('v1', 'w1', 1250, 1500), // master bedroom, north
          window_('v2', 'w11', 1400, 1200), // master bedroom, west
          window_('v5', 'w4', 1000, 1500), // kitchen, north
          window_('v6', 'w6', 1050, 1500), // bedroom 2, east
          window_('v7', 'w10', 2600, 1800), // living, west (clear of the front door at 800..1800)
          window_('v8', 'w9', 1250, 1500), // living, south

          // Bathroom windows: higher and smaller, heads at 2400.
          window_('v3', 'w2', 750, 600, BATH_SILL_MM, BATH_WINDOW_HEIGHT_MM), // master bathroom
          window_('v4', 'w3', 600, 600, BATH_SILL_MM, BATH_WINDOW_HEIGHT_MM), // common bathroom
        ],

        // Loops run clockwise on screen. Consecutive walls share a node, and the last shares one
        // with the first; the dimensions given are internal, i.e. between wall faces.
        rooms: [
          room('r1', 'Master Bedroom', ['w1', 'w12', 'w13', 'w19', 'w11']), // 3828 x 3828, 14.7 m^2
          room('r2', 'Master Bathroom', ['w2', 'w14', 'w15', 'w12']), // 1985 x 2328, 4.6 m^2
          room('r3', 'Common Bathroom', ['w3', 'w17', 'w16', 'w14']), // 1685 x 2328, 3.9 m^2
          room('r4', 'Kitchen', ['w4', 'w5', 'w21', 'w18', 'w17']), // 3328 x 3828, 12.7 m^2
          room('r5', 'Passage', ['w15', 'w16', 'w18', 'w20', 'w13']), // 3785 x 1385, 5.2 m^2
          room('r6', 'Bedroom 2', ['w21', 'w6', 'w24', 'w22']), // 3328 x 3485, 11.6 m^2
          // L-shaped: 7728 x 3485, with a 3828 x 1343 return south to the front wall. 32.1 m^2.
          room('r7', 'Living / Dining', ['w19', 'w20', 'w22', 'w23', 'w25', 'w9', 'w10']),
          room('r8', 'Balcony', ['w23', 'w24', 'w7', 'w8', 'w25']), // 7228 x 1228, 8.9 m^2
        ],

        // Deliberately empty. The furniture kernel and the asset catalogue do not exist yet, so any
        // item here would have to name a `category` we cannot build or an `asset` key that resolves
        // to nothing, and would then be rewritten twice — once when the kernel lands and again when
        // the catalogue does. Furnishing the sample flat is a task for build order item 7.
        items: [],
      },
    ],

    createdAt: '2026-09-03T09:00:00.000Z',
    updatedAt: '2026-09-03T09:00:00.000Z',
  };
}
