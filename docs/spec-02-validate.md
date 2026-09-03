# Spec 02 — `lib/plan/validate.ts`

Build order item 0, continued. Read `CLAUDE.md` and `lib/plan/schema.ts` first. If anything below
conflicts with either, stop and say so before writing.

Write this one file plus its test file. Do not build the sample flat or the viewport in this task.

## Purpose

Zod checks that a document has the right **shape**. This checks that it makes **sense** — the
questions that need the whole document in hand at once: do these IDs point at anything, does this
room loop close, does this door actually fit in its wall.

Nothing downstream should have to ask "but does this wall's node exist?". The 2D editor runs this
continuously and shades problems; the 3D shell refuses to build on errors; the eval harness counts
them.

## Signature

```ts
export function validate(doc: PlanDoc): Issue[]
```

Pure. No I/O, no throwing, no React, no three.js. A structurally broken document is a normal,
expected input — it is what extraction produces and what the editor exists to repair. Throwing
would make it unopenable, which is the opposite of useful.

Return `[]` for a clean document. Do not stop at the first problem; a user fixing ten things wants
to see ten things.

## The `Issue` type

Export it. At minimum:

- `severity`: `'error' | 'warning'`
  - **error** — the document cannot be rendered in 3D or reasoned about. Broken references,
    impossible geometry.
  - **warning** — renderable, but probably not what the user meant. Two nodes 3mm apart, a room
    with no door.
- `code`: a stable machine-readable string, screaming snake case, e.g. `WALL_ORPHAN_NODE`. Tests
  and the UI match on this; the message text must be free to improve without breaking them.
- `message`: a plain-language sentence a homeowner could act on. **Include the real numbers.**
  Not "opening does not fit". Instead: *"The 900mm door at 2100mm along wall w7 would end 200mm
  past the end of that wall, which is 2800mm long."*
- `refs`: the IDs of the elements involved, so the editor can highlight them.
- `levelId`: which level it was found on.

Decide yourself whether `refs` is a flat `Id[]` or a tagged structure, and comment the choice.

## Checks to implement

Group them in the code roughly as below and comment each group with what breaks downstream if it
is not caught.

**Identity**
- Duplicate IDs within a level, per collection and across collections. Two walls called `w3`
  makes every later lookup a coin flip.

**Reference integrity** (all errors)
- A wall's `a` or `b` names a node that does not exist.
- An opening's `wall` names a wall that does not exist.
- A room's `wallLoop` names a wall that does not exist.
- An item anchor names a wall / item / room that does not exist.
- An item anchored to an item, in a cycle — `i1` on `i2` on `i1`. Detect cycles of any length;
  deriving a world transform would recurse forever.

**Walls**
- Zero-length wall: `a` and `b` are the same node, or two distinct nodes at identical coordinates.
  Error — it has no direction, so mitering, side-of-wall and offsets are all undefined.
- Very short wall, under about 100mm. Warning, probably an extraction artifact.
- Two nodes closer together than about 5mm but not identical. Warning — almost certainly one
  corner that should be merged, and it will show as a hairline gap in 3D.

**Openings**
- `offsetMm + widthMm` exceeds the length of its wall. Error. Report the overshoot in millimetres.
- `sillMm + heightMm` exceeds the wall's `heightMm`. Error.
- Two openings on the same wall whose spans overlap. Error, and name both.
- An opening whose width exceeds the wall length outright deserves its own clearer message rather
  than falling out of the offset check.

**Rooms**
- The loop does not close: consecutive walls in `wallLoop` must share a node, and the last must
  share a node with the first. Error, and say *which* pair of walls fails to meet — that is the
  actionable part.
- Fewer than 3 walls. (Zod enforces this already; if so, say that in a comment rather than
  duplicating it.)
- A wall appearing twice in the same loop. Error.
- A room with no door opening on any of its walls. Warning — legal, and true of a balcony, but
  usually an extraction miss, and it will silently break portal culling.

**Scale**
- Scale is `unconfirmed`. Warning at document level, not an error: a document being edited before
  the scale gate is a normal state. It exists so the 3D shell has one thing to check.

**Items**
- Wall-anchored item whose `offsetMm` exceeds its wall's length. Error.

Add checks you think are missing, but list them separately in your reply and say why, so the
addition is a decision rather than a surprise.

## Explicitly out of scope

- Overlap between furniture footprints, clearance rules, walkway widths. That is the placement
  solver, item 6, and it needs the furniture kernel to know how big anything is. The document does
  not store item sizes and this file must not pretend otherwise.
- Whether a room polygon is self-intersecting, or its winding direction. Geometry, later.
- Repairing anything. This function reports; it never mutates.

## Implementation notes

- Wall length needs one distance calculation. A small local helper is fine. Do **not** create
  `lib/geometry` in this task.
- Build ID lookup maps once at the top rather than scanning arrays inside loops.
- Iterate all levels; tag every issue with its `levelId`.
- Order matters for usability: reference-integrity errors first, since a broken reference makes
  every later check about that element noise. If an opening's wall does not exist, do not then also
  report that it does not fit.
- Millimetres are integers, so compare exactly. No epsilons anywhere in this file. The 5mm and
  100mm thresholds above are tolerances on real distances, not float slop — define them as named
  constants with a comment saying so.

## Tests — `lib/plan/validate.test.ts`

Vitest. This file is arithmetic and edge cases, so it gets tests.

- A minimal hand-built valid document produces `[]`.
- One test per error code, each constructing the smallest document that triggers it and asserting
  the code appears.
- A document with several distinct problems returns all of them.
- The cycle detector terminates on a 3-item cycle.
- A document that is merely `unconfirmed` on scale produces a warning and no errors.

Build the fixtures inline in the test file. The sample flat is a separate later task and this must
not wait on it.

## Done when

- `npx tsc --noEmit` clean, `npx vitest run` green.
- No `any`, no non-null `!`, no thrown exceptions.
- Every message names the elements and the actual numbers involved.

Print the finished files in full, and list any checks you added beyond this spec.
