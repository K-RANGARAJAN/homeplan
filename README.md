# homeplan

*Working name.*

An interior design planner. A homeowner uploads their apartment floor plan, gets an accurate
navigable 3D model of **their actual flat**, then furnishes it by describing what they want in
plain language. Output is labelled screenshots they can show a carpenter.

The promise is not "here's a beautiful idea for a home" — that's Pinterest, and it's abundant.
It is **"here's what will actually fit and work in YOUR home."** Every reference image a homeowner
has is of somebody else's house. Here the room is theirs, the wall is the real length, and the
wardrobe is the width it would actually have to be.

---

## Running it

Requires Node 20 or later.

```bash
npm install
npm run dev
```

Then open http://localhost:3000. It loads a hand-authored sample 2BHK: the 2D plan editor on one
side, the 3D view of the same document on the other. Edit the plan and the 3D updates immediately —
they are two renderings of one document, not two things kept in sync.

To try it on a phone, open the network address `npm run dev` prints, from a device on the same wifi.
Touch is supported and worth testing; the editor is built for both.

## Checks

```bash
npm test              # vitest, 208 tests
npx tsc --noEmit      # types
npx eslint .          # lint
npm run build         # production build
```

All four must pass before anything merges. A fifth, informal check matters as much: `validate(sampleFlat())`
must still return `[]`. It is asserted in the test suite, and if the sample flat starts producing
issues, something in the foundations moved.

## Layout

```
lib/plan/         the document — schema, validator, sample flat, store, edits
lib/geometry/     pure geometry — plan space, wall mitering, hit testing
components/editor/    2D plan editor (SVG)
components/viewport/  3D view (three.js / react-three-fiber)
docs/             build specs, one per subsystem
```

---

## What's built

**Step 0 — the document.**

`lib/plan/schema.ts` defines the single JSON document every view renders. It is written so that bad
states are unrepresentable rather than merely invalid: integer millimetres throughout, walls holding
node IDs rather than coordinates, openings anchored by absolute offset rather than a fraction, items
holding an anchor rather than a position. `z.strictObject` throughout, so an unknown key is an error
rather than silently dropped.

`lib/plan/validate.ts` checks what the schema can't — whether the document makes *sense*. Broken
references, unclosed room loops, a 900mm door at offset 2100 in a 2800mm wall. 21 issue codes, pure,
never throws. Messages name the elements and the real numbers, because explainable failure is a
feature of this project rather than a nicety.

`lib/plan/sample.ts` is a hand-authored Indian 2BHK — 18 nodes, 25 walls, 8 rooms, 913 sq ft carpet,
eleven T-junctions and one four-way. It validates to exactly `[]` and it is the fixture everything
is debugged against.

`lib/geometry/walls.ts` turns wall centrelines into mitred footprints. Junctions are solved per node
rather than per wall, and each wall at a junction of three or more also takes the node point itself,
so the middle gets filled rather than left as a triangular hole. Handles differing thicknesses,
collinear runs, near-collinear miter limits, short walls between two junctions, and sharp angles.

**Step 1 — the 2D plan editor.**

Draw walls by tapping, chaining segments into rooms. Drag corners and every attached wall follows.
Delete with a cascade warning. Snapping to existing corners and to 90°, both toggleable, radii in
screen pixels so they behave at any zoom. Undo and redo from immer patches, one entry per gesture.
Live validation with issues you can tap to select the elements involved.

Typed exact lengths are the feature that makes this an instrument rather than a sketchpad — the eval
harness will record its ground truth by typing lengths here. Select a wall, type a length, and see
before committing which corner will move, how many walls follow it, whether any would collapse to
zero length or land within 5mm of another corner, and what length is actually achievable.

---

## Where it's going

Extraction — upload a plan and have it vectorised automatically — is next, and it is where the
project's research contribution sits. Current published methods reach roughly 92% boundary IoU,
which on a 4-metre wall is still ±30cm. For an app whose entire claim is "the wall is the real
length", that is not good enough. Indian builder plans print their dimensions; the plan is to use
those strings as **hard constraints in a global solve** rather than as soft hints, which is what
nobody in the literature appears to be doing.

The 2D editor is not a fallback for that. It is the measurement instrument: the eval harness needs
30 real plans with hand-measured ground truth, and this is the tool that records them.

After that: camera modes and portal culling, the placement solver with its editable clearance rule
table, the parametric furniture kernel, and the screenshot pass.

---

## Reading order for new contributors

1. **`CLAUDE.md`** (repo root) — binding rules. Claude Code reads it every session; so should you.
2. **`docs/ONBOARDING.md`** — the architecture, the conventions that will bite you, the tracks.
3. **`docs/spec-01`** through **`spec-05`** — how each piece was specified, and why.

Then clone it, run it, and draw a flat by hand. Ten minutes with the thing is worth an hour of
reading about it.

## Working agreement

- Branch per track. Never commit to `main` directly.
- Pull requests, read by someone else before merging.
- Anything touching `lib/plan/` or `lib/geometry/` needs review — those are the shared foundations
  and a change there breaks every track silently.
- Write a spec before building. Read what comes back, not the summary of it.
- One item at a time. The failure mode for a project this size is five subsystems at 30%.
