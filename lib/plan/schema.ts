/**
 * lib/plan/schema.ts — the one document.
 *
 * Every view in this app (2D plan, 3D scene, screenshots, chat context) is a rendering of a
 * `PlanDoc`. Nothing else is a source of truth; the 3D scene is not a separate thing that gets
 * synced. Because a document can arrive from disk, from the extractor, or from an LLM tool call,
 * the shape is declared with zod so it can be checked at those three boundaries before we trust it.
 *
 * This file describes SHAPE only. Whether a room loop actually closes, whether an opening fits
 * inside its wall, whether a wall references a node that exists — that is `lib/plan/validate.ts`.
 * Zod checks shape; the validator checks sense. Keeping them apart means a structurally broken
 * document can still be loaded into the 2D editor and repaired, instead of being rejected at the
 * door with no way back.
 *
 * No geometry, no React, no three.js. This file must run in a plain Node test.
 */

import { z } from 'zod';

/* ------------------------------------------------------------------------------------------------
 * Primitives
 * ---------------------------------------------------------------------------------------------- */

/**
 * An integer millimetre value — every length, coordinate, thickness and height in the document.
 *
 * Integers, not floats: the editor snaps constantly, and snapped floats make two points that are
 * "the same corner" compare unequal at the 1e-13 level forever after. Millimetres, not metres:
 * a millimetre is finer than anything a carpenter will act on, so integers lose nothing.
 * Conversion to metres happens exactly once, at the three.js boundary, and nowhere else.
 */
export const Mm = z.number().int();

/** An integer millimetre value that must be > 0 — thickness, height, width of a real object. */
export const MmPositive = z.number().int().positive();

/** An integer millimetre value that must be >= 0 — an offset or a gap, which may legitimately be 0. */
export const MmNonNegative = z.number().int().nonnegative();

/**
 * A stable short identifier. Short because the chat layer names elements by ID in every tool call
 * and a human has to be able to read them in a log; stable because undo/redo and "move it left"
 * both depend on an ID surviving an edit.
 */
export const Id = z.string().min(1);

/**
 * A distance in source-image pixels. This is the ONLY non-millimetre, non-integer quantity in the
 * document, and it exists solely inside `Scale`, where a pixel measurement is being converted into
 * millimetres. It is deliberately not named with an `Mm` suffix so it can never be mistaken for a
 * real-world length.
 */
export const Px = z.number().positive();

/**
 * Provenance, attached to every element.
 *
 * `source` says who last decided this value: the extractor (`auto`), the human (`user`), or code
 * that computed it from something else (`derived`). Re-running extraction must never clobber a
 * user's fix, so extraction merges by refusing to overwrite `user` elements — that rule is
 * unimplementable without this field. `confidence` lets the 2D editor shade a doubtful wall so the
 * user knows where to look, and lets the eval harness measure the extractor by counting what
 * humans had to change.
 */
export const MetaSchema = z.strictObject({
  source: z.enum(['auto', 'user', 'derived']),
  confidence: z.number().min(0).max(1),
});

/* ------------------------------------------------------------------------------------------------
 * Elements
 *
 * Note on `z.strictObject` throughout: unknown keys are an ERROR, not silently stripped. This is
 * what makes the invariants below real rather than aspirational — an `Item` carrying `x` and `y`,
 * or a `Wall` carrying `x1,y1,x2,y2`, fails to parse instead of quietly losing the extra fields and
 * looking valid. Forward compatibility is handled by `schemaVersion` and an explicit migration, not
 * by tolerating fields we do not understand.
 * ---------------------------------------------------------------------------------------------- */

/** A point in plan space. Walls, and therefore rooms, are built entirely out of these. */
export const NodeSchema = z.strictObject({
  id: Id,
  x: Mm,
  y: Mm,
  meta: MetaSchema,
});

/**
 * A wall segment between two nodes.
 *
 * `a` and `b` are node IDs, never coordinates. Storing `[x1,y1,x2,y2]` per wall is simpler for
 * about a week: then the user drags one corner of an L-shaped room, three walls each hold their own
 * idea of where that corner is, and every T-junction and non-90° corner leaks a hairline gap that
 * shows up in the 3D shell and can never be fully chased down. Shared nodes make "drag a corner and
 * everything attached follows" the only possible behaviour.
 *
 * `heightMm` is per-wall, not a global constant, because half-height partitions, kitchen pass-
 * throughs and parapets exist. A global constant is one line shorter today and a rewrite of the
 * extrusion, mitering and portal-culling code the first time a flat contains one.
 */
export const WallSchema = z.strictObject({
  id: Id,
  a: Id,
  b: Id,
  thicknessMm: MmPositive,
  heightMm: MmPositive.default(2900),
  meta: MetaSchema,
});

/**
 * Which side of the wall a door leaf swings out to, and which end it is hinged at.
 *
 * Both are expressed relative to the wall's own a -> b direction, never in world terms: `side` is
 * left or right of that direction vector, `hinge` is the low-offset end (`a`) or the high-offset
 * end (`b`) of the opening's span. That keeps the swing correct for free when the wall is moved,
 * rotated, lengthened or has its nodes dragged — a world-space angle or an "opens north" flag would
 * silently become wrong the moment the plan is edited. The solver derives the 90° swing sector
 * polygon (radius = leaf width) from these two flags plus the wall geometry.
 */
export const DoorSwingSchema = z.strictObject({
  side: z.enum(['left', 'right']),
  hinge: z.enum(['a', 'b']),
});

const openingBase = {
  id: Id,
  wall: Id,
  /**
   * Absolute distance along the wall from node `a` to the START of the opening.
   *
   * Absolute, not a 0..1 fraction of wall length: a fraction silently slides the door down the wall
   * every time the wall is lengthened, which is exactly what happens during plan cleanup after
   * extraction. A door is 900mm from the corner because of how the flat was built, not because it
   * is 23% of the way along.
   */
  offsetMm: MmNonNegative,
  widthMm: MmPositive,
  heightMm: MmPositive,
  /** Height of the bottom edge above the finished floor. 0 for a normal door. */
  sillMm: MmNonNegative,
  meta: MetaSchema,
};

export const PlanDoorSchema = z.strictObject({
  ...openingBase,
  kind: z.literal('door'),
  swing: DoorSwingSchema,
});

export const PlanWindowSchema = z.strictObject({
  ...openingBase,
  kind: z.literal('window'),
});

/**
 * A hole in a wall.
 *
 * A discriminated union rather than one object with an optional `swing`, so that a door without
 * swing information cannot be constructed (the solver needs it to subtract the swing sector from
 * free space) and a window carrying one cannot either.
 */
export const OpeningSchema = z.discriminatedUnion('kind', [PlanDoorSchema, PlanWindowSchema]);

/**
 * A named enclosed space.
 *
 * The loop is an ordered list of WALL ids, not node ids. Both can produce the polygon the solver
 * needs — walls by walking their endpoints — but only walls answer the second question directly:
 * portal culling has to know which walls two rooms share, which with wall ids is a set
 * intersection, and with node ids is a reverse lookup from every adjacent node pair back to a wall.
 * That lookup is also ambiguous the moment a plan has two walls between the same pair of nodes,
 * which is how a thick party wall between two flats usually ends up being drawn. Ordering is
 * meaningful: consecutive walls share a node, and the loop runs the same way round for every room
 * so the derived polygon has a consistent winding.
 */
export const RoomSchema = z.strictObject({
  id: Id,
  name: z.string().min(1),
  wallLoop: z.array(Id).min(3),
  meta: MetaSchema,
});

/* ------------------------------------------------------------------------------------------------
 * Anchors — how an item is attached to the world
 * ---------------------------------------------------------------------------------------------- */

/**
 * Where an item sits, expressed as a relationship, never as a position.
 *
 * There is no `x` or `y` anywhere in this union, and that is the point. The world transform of an
 * item is DERIVED from its anchor plus the geometry it refers to, so:
 *   - "floating in mid-air" and "half inside the wall" are unrepresentable rather than merely
 *     invalid;
 *   - moving a wall carries its wardrobe along with it, with no fix-up pass;
 *   - the chat layer can be handed this exact vocabulary, which is why the LLM tool schema contains
 *     no coordinates at all. The AI says *where relative to what*; the solver computes *where
 *     exactly*.
 */
export const AnchorSchema = z.discriminatedUnion('on', [
  z.strictObject({
    on: z.literal('wall'),
    wall: Id,
    /** Distance along the wall from node `a` to the item's footprint centre. Absolute, as for openings. */
    offsetMm: MmNonNegative,
    /** Which side of the wall's a -> b direction the item stands on. Its back is to the wall, so this also fixes its facing. */
    side: z.enum(['left', 'right']),
    /** Clearance between the wall face and the back of the item. 0 = pushed flush against it. */
    gapMm: MmNonNegative.default(0),
  }),
  z.strictObject({
    on: z.literal('item'),
    item: Id,
    /** Relations are in the reference item's own frame, so rotating the sofa takes the side table with it. */
    relation: z.enum(['left-of', 'right-of', 'in-front-of', 'behind', 'on-top-of']),
    gapMm: MmNonNegative.default(0),
  }),
  z.strictObject({
    on: z.literal('room'),
    /**
     * Free-standing in a room: a dining table, a rug, an island. It deliberately carries no
     * position — the solver picks the spot from the free-space polygon and the clearance rules, and
     * re-picks it when the room changes. Without this case, anything not touching a wall or another
     * object would be unrepresentable and someone would "temporarily" add coordinates to fix it.
     */
    room: Id,
  }),
]);

/* ------------------------------------------------------------------------------------------------
 * Items
 * ---------------------------------------------------------------------------------------------- */

/**
 * A single value in a generated item's parameter bag. Numbers are integers — millimetres where the
 * parameter is a length, plain counts otherwise (shelves, doors). Which keys a given recipe accepts
 * and what they mean is the furniture kernel's business, not the document's; validating that here
 * would put every recipe's signature in the schema and force a schema migration each time one gains
 * an option.
 */
export const ParamValueSchema = z.union([z.number().int(), z.string(), z.boolean()]);

const itemBase = {
  id: Id,
  /** Human-readable label for annotations and screenshots. Falls back to the category when absent. */
  name: z.string().min(1).optional(),
  anchor: AnchorSchema,
  /** Reference into the material library. Optional: a retrieved GLB already ships with materials. */
  material: Id.optional(),
  meta: MetaSchema,
};

/** Built from boards by the furniture kernel — every dimension calculated, nothing stretched. */
export const GeneratedItemSchema = z.strictObject({
  ...itemBase,
  kind: z.literal('generated'),
  category: z.enum([
    'wardrobe',
    'desk',
    'tv-unit',
    'kitchen-run',
    'storage-bed',
    'shelving',
    'vanity',
  ]),
  params: z.record(z.string(), ParamValueSchema),
});

/** A downloaded GLB, used as-is. */
export const RetrievedItemSchema = z.strictObject({
  ...itemBase,
  kind: z.literal('retrieved'),
  category: z.enum([
    'sofa',
    'chair',
    'dining-set',
    'appliance',
    'sanitaryware',
    'lamp',
    'plant',
    'decor',
  ]),
  /** Catalogue key of the asset. */
  asset: Id,
});

/**
 * A piece of furniture.
 *
 * The generated/retrieved split is a discriminated union, and `RetrievedItemSchema` is strict with
 * no `params` field, so a retrieved asset carrying parameters fails to parse. That is the schema
 * keeping a promise the rest of the app makes: `setParameter` is not offered on retrieved assets,
 * because a downloaded sofa mesh cannot be rebuilt 200mm wider. If params could be attached to one
 * anyway, some later code path would try.
 */
export const ItemSchema = z.discriminatedUnion('kind', [GeneratedItemSchema, RetrievedItemSchema]);

/* ------------------------------------------------------------------------------------------------
 * Scale
 * ---------------------------------------------------------------------------------------------- */

/**
 * The calibration that maps the source image to real millimetres.
 *
 * A floor plan image has no inherent real-world size, so this is a union with an explicit
 * `unconfirmed` case rather than a nullable `mmPerPx: number | null`. A nullable number invites
 * `scale.mmPerPx ?? 1`, and a flat silently rendered at 1mm-per-pixel is the worst possible failure
 * — it looks like a building, just the wrong one. With a union, code that wants the ratio has to
 * narrow on `status` first, so "nothing reaches 3D on an unconfirmed scale" is enforced by the
 * compiler rather than by everyone remembering.
 *
 * `mmPerPx` is a ratio, not a length, so it is the one legitimate float here. Everything measured
 * through it is rounded to integer millimetres immediately.
 */
export const ScaleSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('unconfirmed'),
    /**
     * Pre-fill from reading dimension strings off the plan and RANSAC-ing them to a consensus.
     * A suggestion for the confirmation UI to show — explicitly not usable as the scale.
     */
    suggestedMmPerPx: z.number().positive().optional(),
  }),
  z.strictObject({
    status: z.literal('confirmed'),
    mmPerPx: z.number().positive(),
    /** What the user clicked two ends of, and how long they said it was. Kept so the gate can be revisited. */
    reference: z.strictObject({
      lengthMm: MmPositive,
      lengthPx: Px,
      label: z.string().optional(),
    }),
    confirmedAt: z.iso.datetime(),
  }),
]);

/* ------------------------------------------------------------------------------------------------
 * Level and document root
 * ---------------------------------------------------------------------------------------------- */

/**
 * One floor of the building.
 *
 * v1 will only ever contain a single level, but the document holds an array from day one. The
 * levels array is the boundary every module crosses to reach walls and rooms; introducing it later
 * would mean touching the editor, the extruder, the culler, the solver and the chat layer at once,
 * whereas carrying `levels[0]` for a while costs one index.
 */
export const LevelSchema = z.strictObject({
  id: Id,
  name: z.string().min(1),
  /** Height of this level's finished floor above the building datum. Ground floor is 0. */
  elevationMm: Mm,
  nodes: z.array(NodeSchema),
  walls: z.array(WallSchema),
  openings: z.array(OpeningSchema),
  rooms: z.array(RoomSchema),
  items: z.array(ItemSchema),
  meta: MetaSchema,
});

/** Bump when a change to this file makes existing saved documents unreadable, and write a migration. */
export const SCHEMA_VERSION = 1;

/**
 * The root document. One per project.
 *
 * `schemaVersion` is present from day one because the alternative is discovering, on the day of the
 * first breaking change, that no saved file says what shape it is and none of them can be migrated.
 * It is pinned to a literal, not merely "a positive integer": a document written by a future version
 * must fail here, at the parse boundary, with one clear error — not slip through and surface as a
 * missing field somewhere inside the solver. Migration reads the version off the raw JSON *before*
 * parsing, upgrades the object, and only then hands it to this schema.
 *
 * `units` is a fixed literal. It stores no information — everything here is millimetres by
 * construction — and exists as documentation at the top of every saved file, and as a tripwire: a
 * future contributor who decides to write centimetres has to delete this line to do it.
 */
export const PlanDocSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: Id,
  name: z.string().min(1),
  units: z.literal('mm'),
  region: z.enum(['IN', 'US']).default('IN'),
  scale: ScaleSchema,
  levels: z.array(LevelSchema).min(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

/* ------------------------------------------------------------------------------------------------
 * Types
 *
 * Every type is inferred from its schema. Hand-writing a parallel interface guarantees that one day
 * the type and the runtime check disagree, and the compiler will be the one that is wrong.
 * ---------------------------------------------------------------------------------------------- */

export type Meta = z.infer<typeof MetaSchema>;
/** Named `PlanNode`, not `Node`, so importing it never shadows the DOM's global `Node`. */
export type PlanNode = z.infer<typeof NodeSchema>;
export type Wall = z.infer<typeof WallSchema>;
export type DoorSwing = z.infer<typeof DoorSwingSchema>;
/** `PlanDoor` / `PlanWindow` for the same reason as `PlanNode`: `Window` is a DOM global. */
export type PlanDoor = z.infer<typeof PlanDoorSchema>;
export type PlanWindow = z.infer<typeof PlanWindowSchema>;
export type Opening = z.infer<typeof OpeningSchema>;
export type Room = z.infer<typeof RoomSchema>;
export type Anchor = z.infer<typeof AnchorSchema>;
export type ParamValue = z.infer<typeof ParamValueSchema>;
export type GeneratedItem = z.infer<typeof GeneratedItemSchema>;
export type RetrievedItem = z.infer<typeof RetrievedItemSchema>;
export type Item = z.infer<typeof ItemSchema>;
export type Scale = z.infer<typeof ScaleSchema>;
export type Level = z.infer<typeof LevelSchema>;
export type PlanDoc = z.infer<typeof PlanDocSchema>;

export type Source = Meta['source'];
export type Region = PlanDoc['region'];
