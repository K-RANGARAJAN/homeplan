# Spec 01 — `lib/plan/schema.ts`

Build order item 0. Read `CLAUDE.md` first; if anything below conflicts with it, stop and say so.

Write exactly this one file. Do not create the validator, the sample flat, or any React component
in this task.

## Purpose

The single JSON document that describes a flat. Every view in the app — 2D plan, 3D scene,
screenshots, chat context — is a rendering of this document. It is defined with zod so that any
document arriving from disk, from extraction, or from an LLM tool call can be checked before we
trust it.

## Non-negotiable invariants

These are the reason the file exists. Encode them in the types, not in comments alone.

1. **Integer millimetres everywhere.** Every length, coordinate, thickness and height is an
   integer number of millimetres. No floats, no metres, no centimetres, no feet. Conversion to
   metres happens exactly once, later, at the three.js boundary — not here.
2. **Walls reference shared node IDs, never their own coordinates.** A wall stores `a` and `b`,
   which are node IDs. It must be impossible to give a wall its own `x1,y1,x2,y2`.
3. **Openings are anchored by absolute offset in millimetres from node `a`**, never a 0..1
   fraction of wall length.
4. **Items store an anchor, not a position.** There must be no `x` or `y` field on an item. World
   transforms are derived elsewhere. "Floating in mid-air" must be unrepresentable.

## Required helpers

Define and reuse these rather than repeating primitives inline:

- `Mm` — an integer millimetre value. Use `z.number().int()`. Where a value cannot sensibly be
  negative or zero (thickness, height, width), constrain it.
- `Id` — a stable short string identifier, non-empty.
- `Meta` — attached to every element:
  - `source`: `'auto' | 'user' | 'derived'`
  - `confidence`: number 0..1
  Purpose: re-running extraction must never clobber a user's fix, the UI can shade low-confidence
  elements, and we can measure the extractor by counting what users changed. Every element type
  below carries a `meta` field of this type.

## Elements

Design the exact field set yourself where this spec is silent, but include at minimum:

**Node** — a point in plan space. `id`, `x` (Mm), `y` (Mm), `meta`.

**Wall** — `id`, `a` (Id of a node), `b` (Id of a node), `thicknessMm`, `heightMm`, `meta`.
Default height 2900mm, but the field is per-wall, not global.

**Opening** — a door or window in a wall. `id`, `wall` (Id), `kind` (`'door' | 'window'`),
`offsetMm` (absolute, from node `a`), `widthMm`, `heightMm`, `sillMm` (height of the bottom above
floor — 0 for a door), `meta`. Doors additionally need enough information to derive a swing:
which side they open to and which way they hinge. Choose a representation and comment why.

**Room** — `id`, `name` (e.g. "Master Bedroom"), an ordered loop of wall IDs or node IDs that
bounds it (choose one, justify it in a comment), `meta`. The choice matters: the solver needs a
polygon, and portal culling needs to know which walls are shared between rooms.

**Item** — a piece of furniture. `id`, a type discriminator distinguishing **generated**
(parametric, built from boards — wardrobe, desk, TV unit, kitchen run, storage bed, shelving,
vanity) from **retrieved** (a downloaded GLB — sofa, chair, dining set, appliance, sanitaryware,
lamp, plant, decor), an `anchor` describing what it is placed against and how, a parameter bag
for generated items only, a material reference, and `meta`.

The anchor is the important part. It must express things like "against this wall, this far along
it, facing into the room" or "against this other item" — never an absolute world position.
Generated items may carry `params`; retrieved items must not, because `setParameter` is not
offered on them and the schema should make that promise unbreakable.

**Scale** — the calibration that maps the source image to real millimetres. Must be able to
represent *unconfirmed*. Nothing downstream may reach 3D on an unconfirmed scale, so make the
unconfirmed state loud and explicit rather than a nullable number.

**Level** — a floor of the building. Contains nodes, walls, openings, rooms, items. The document
holds an array of levels even though v1 will only ever have one; retrofitting this later would
touch every module.

**PlanDoc** — the root. `schemaVersion` (a number, present from day one so old files can be
migrated), `id`, `name`, `units` (fixed literal `'mm'` — present as documentation and as a guard
against a future contributor assuming otherwise), `region` (`'IN' | 'US'`, default `'IN'`),
`scale`, `levels`, and a `createdAt` / `updatedAt` pair.

## Exports

- A zod schema for every element and for `PlanDoc`.
- A TypeScript type for each, inferred from the schema with `z.infer`. Do not hand-write types
  alongside the schemas — they will drift.
- Whatever small helpers the schemas need. No parsing, no validation logic, no geometry.

## Explicitly out of scope

- Structural validation — closed room loops, openings inside their wall's extent, orphan node
  references, zero-length walls. That is `lib/plan/validate.ts`, a separate later task. Zod checks
  *shape*; the validator checks *sense*. Do not blur them.
- Any geometry maths.
- Any React or three.js import. This file must be usable in a plain Node test with no DOM.

## Comments

Comment the reasoning, not the syntax. Where a decision could plausibly have gone the other way —
node IDs over inline coordinates, absolute offsets over fractions, anchors over positions,
per-wall height over a global constant — say in one or two lines what breaks if you take the other
road. A future reader needs to know why the awkward-looking choice is the right one, or they will
"simplify" it.

## Done when

- `npx tsc --noEmit` is clean.
- No `any`, no non-null `!`.
- There is no way to construct a valid `Item` with an `x` or `y` field.
- There is no way to construct a valid `Wall` holding its own coordinates.
- A length field typed as a plain `number` does not exist anywhere in the file.

Print the finished file in full when done.
