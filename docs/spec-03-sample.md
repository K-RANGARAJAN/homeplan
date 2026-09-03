# Spec 03 — `lib/plan/sample.ts`

Build order item 0, continued. Read `CLAUDE.md`, `lib/plan/schema.ts` and `lib/plan/validate.ts`
first. If anything below conflicts with them, stop and say so before writing.

Write this one file plus its test. Do not build the viewport in this task.

## Purpose

A hand-authored, realistic Indian 2BHK flat as a `PlanDoc`. This is the fixture everything
downstream is built and debugged against: the 3D viewport, wall mitering, portal culling, the
placement solver, the screenshot pass. It exists so that none of those has to wait on the upload
and extraction pipeline, and so that "did I break something" has an answer that takes one second.

It must be more interesting than a four-wall box — real T-junctions, a non-trivial number of rooms,
doors of different widths — because a box will not exercise mitering, culling or free space, and a
fixture that passes everything is useless.

## Signature

```ts
export function sampleFlat(): PlanDoc
```

A **function returning a fresh object every call**, not an exported constant. The app mutates
documents through immer, and tests mutate fixtures; a shared constant would let one test's edits
leak into the next and produce failures that depend on file order.

Return type annotated as `PlanDoc`. Build the object literal directly — do not run it through
`PlanDocSchema.parse` inside this function. The test does that.

## The flat

A typical Indian builder 2BHK, roughly 1000–1100 sq ft carpet area. Choose exact dimensions
yourself; make them plausible round numbers a builder would actually use, in millimetres.

Rooms, at minimum:

- Living / dining (the largest space, the one you enter into)
- Kitchen
- Master bedroom, with attached bathroom
- Second bedroom
- Common bathroom
- Balcony off the living room

Openings, using NBC widths from `CLAUDE.md`:

- Main entrance door 1000mm
- Bedroom doors 900mm
- Kitchen door 800mm
- Bathroom doors 750mm
- Balcony access — your call whether a door or a sliding unit; note the choice in a comment
- Windows in every habitable room. Sill 900mm, height 1200mm, so the head lands at 2100mm and
  matches the door heads. Bathroom windows higher and smaller, sill 1500mm.

Wall thickness: 230mm external, 115mm internal partitions. That is standard Indian brickwork and
it matters — an external wall drawn at 115mm will make the whole shell look wrong in 3D.

Ceiling height 2900mm throughout, which is the schema default.

## The modelling constraint that matters

**A wall must be split at every point where the rooms on either side of it change.**

A room's `wallLoop` requires consecutive walls to share a node. So a long external wall that runs
past the master bedroom and then the second bedroom cannot be one wall — the internal partition
between those bedrooms meets it partway along, and both room loops need to close at that meeting
point. It has to be two walls sharing a node where the partition lands.

Get this wrong and the loops will not close, `ROOM_LOOP_BROKEN` will fire, and the fix is a rebuild
rather than an edit. Plan the node graph before writing any literals: place every node first, work
out which nodes are junctions, then cut the walls at them.

This is also what makes the fixture worth having. Those T-junctions are exactly what the mitering
code will get wrong, and a box has none.

## Conventions

- IDs short, readable and systematic: `n1`, `w1`, `d1`, `v1` for windows, `r1`. A human reads these
  in validator output and, later, in chat logs.
- Coordinates in millimetres with the origin at one outside corner of the flat, x to the right,
  y increasing in one consistent direction. State in a comment which way y goes; every later piece
  of geometry code depends on knowing.
- `meta` on every element: `source: 'user'`, `confidence: 1`. This is hand-authored ground truth,
  not something an extractor guessed.
- Scale: `confirmed`. Pick a plausible `mmPerPx` and a `reference` measurement consistent with it.
  An unconfirmed sample would trip the scale gate and be unusable in the viewport.
- One level, `l0`, named "Ground", `elevationMm: 0`.
- `schemaVersion: SCHEMA_VERSION`, imported — not a bare `1`.

## Items

**Leave `items` empty.** The furniture kernel and asset catalogue do not exist, so any item here
would reference a category or asset key we cannot yet build, and would have to be rewritten twice.
Say so in a comment so the emptiness reads as a decision rather than an oversight.

## Comments

A short header explaining what the flat is and why it is shaped this way. Then, above each room's
walls, one line naming the room and its internal dimensions — `// Master bedroom, 3600 x 3300` —
so that a human editing the literals can navigate them. Without this the file is 200 lines of
indistinguishable numbers.

Also record, near the top, the total carpet area you targeted and the y-direction convention.

## Tests — `lib/plan/sample.test.ts`

- `PlanDocSchema.parse(sampleFlat())` succeeds.
- `validate(sampleFlat())` returns exactly `[]`. **This is the important one.** No errors and no
  warnings — including `ROOM_NO_DOOR` and `NODE_UNREFERENCED`, which are the two most likely to
  fire on a real flat. If the balcony genuinely has no door, fix the flat, not the test.
- Two calls return objects that are deeply equal but not the same reference, and mutating one does
  not affect the other.
- A sanity check or two on the content: at least 6 rooms, at least one wall of each thickness, at
  least one node shared by three or more walls (proving the T-junctions exist).

## Done when

- `npx tsc --noEmit` clean, `npx vitest run` green.
- `validate(sampleFlat())` is `[]`.
- No `any`, no non-null `!`.

Print the finished files in full. Also print a short list of the rooms with their internal
dimensions and the total area, so the flat can be sanity-checked without reading coordinates.
