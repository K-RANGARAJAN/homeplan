# Joining this project

Read this once, all the way through, before writing anything. Then read `CLAUDE.md` in the repo
root — that one is binding, and Claude Code reads it every session.

## What we're building

An interior design planner. A homeowner uploads their apartment floor plan, gets an accurate
navigable 3D model of **their actual flat**, then furnishes it by describing what they want in
plain language. Output is labelled screenshots they can show a carpenter.

The promise is not "here's a beautiful idea for a home" — that's Pinterest, and it's abundant.
It is **"here's what will actually fit and work in YOUR home."**

Every reference image a homeowner has is of somebody else's house. The value here is that the room
is theirs, the wall is the real length, and the wardrobe is the width it would actually have to be.

Division of labour with the carpenter: **the app carries the form, the carpenter carries the
millimetres.** He measures the wall himself and builds to fit, as he always has. We do NOT produce
construction drawings, cut lists, or hardware schedules.

## The one idea that explains every decision

```
AI understands meaning
  -> our code does the geometry and numbers
    -> the solver validates placement
      -> the furniture kernel generates geometry
        -> the renderer draws it
```

**The AI proposes, the solver disposes, the renderer obeys.**

Language models are good at understanding what someone means and bad at arithmetic. So they never
produce a number. They fill in a small closed schema — "a wardrobe, against that wall, near the
window" — and deterministic, testable code turns that into millimetres.

The first time chat writes a position directly, debuggability is gone. If you find yourself about
to let a model emit a coordinate, stop.

## One document

There is ONE JSON document per project, defined in `lib/plan/schema.ts`. Every view — the 2D plan,
the 3D scene, screenshots, what chat knows about the room — is a *rendering* of it. The 3D scene is
not a separate thing that gets synced.

This is also why three people can work in parallel without colliding: each track talks to the
document, not to the other tracks.

Four rules the schema enforces. Do not work around any of them:

1. **Integer millimetres everywhere.** Convert to metres exactly once, at the three.js boundary.
   Floats plus snapping produces equality bugs forever.
2. **Walls reference shared node IDs, never their own coordinates.** Drag a corner and every
   attached wall follows. Per-wall `[x1,y1,x2,y2]` is simpler for a week and leaks hairline gaps at
   every T-junction for the rest of the project.
3. **Openings are anchored by absolute offset from node `a`**, never a fraction of wall length. A
   fraction moves the door when the wall is lengthened.
4. **Items store an anchor, not a position.** World transforms are derived. There is no `x`/`y` on
   an item, so "floating in mid-air" is unrepresentable rather than merely invalid.

Every element also carries `meta.source` (`auto` / `user` / `derived`) and `confidence`. Re-running
extraction must never clobber a user's fix. Preserve these through every transformation.

The schema uses `z.strictObject` throughout, so an unknown key is an error rather than silently
dropped. That's what makes the rules above real instead of aspirational.

## What already exists

Roughly 1,900 lines, 191 tests, all green.

**`lib/plan/schema.ts`** — the document. Nodes, walls, openings, rooms, items, scale, levels.
Doors are a union on `leaf` (hinged / sliding / none), so only a hinged door can carry swing data —
the solver reads swing to subtract floor, and a slider carrying leftover swing would subtract floor
that isn't blocked. `scale` is a union with an explicit `unconfirmed` case, so the compiler forces
you to check before reading the ratio.

**`lib/plan/validate.ts`** — what zod can't check: whether the document makes *sense*. Broken
references, unclosed room loops, a 900mm door at offset 2100 in a 2800mm wall. 21 issue codes. Pure,
never throws, returns `Issue[]`. Messages name the elements and the real numbers, because
**explainable failure is a feature of this project, not a nicety.**

**`lib/plan/sample.ts`** — a hand-authored 2BHK. 18 nodes, 25 walls, 8 rooms, 913 sq ft. Eleven
T-junctions and one four-way. It validates to exactly `[]` and it is the fixture you debug against.

**`lib/geometry/`** — plan-space vocabulary and wall mitering. Mitering is solved per node, not per
wall, and each wall at a junction of three or more also takes the node point itself so the middle
gets filled. Getting this wrong is the #1 visual bug in hand-rolled planners.

**`lib/plan/store.ts`** — zustand plus immer. Undo comes from immer patches, one group per user
gesture.

**`components/editor/` and `components/viewport/`** — the 2D plan editor and the 3D view, both
reading the same store.

## Conventions that will bite you if you don't know them

- **Plan space:** x increases east, y increases **downward** (south), matching SVG. The three.js
  boundary maps plan (x, y) to world (x, z) and is the only place this changes.
- **Left and right of a wall** mean left and right walking from node `a` to node `b`, looking down:
  for direction (dx, dy), left is the half-plane (dy, -dx) points into. Implemented once in
  `lib/geometry/plan-space.ts`. Import it; never re-derive it.
- **Nodes are wall centrelines, not faces.** A wall occupies thickness/2 either side. Derived face
  coordinates land on half-millimetres even though every stored value is an integer. That's
  correct. Never use a derived coordinate as a map key or an equality test — node IDs are identity.
- **India-first.** NBC door widths (main 1.0m, bedroom 0.90m, kitchen 0.80m, bath 0.75m), counter
  heights 750-800 not 915, 230mm external brickwork and 115mm partitions.
- **Desktop and touch both.** No hover-only affordances, no right-click, 44px touch targets,
  Pointer Events not mouse events.

## Code conventions

- TypeScript strict. No `any`. No non-null `!` to silence the compiler — fix the type.
- Lengths are integer millimetres and named as such: `widthMm`, never `width`.
- Pure functions for geometry. No reaching into React state from a geometry module.
- Errors a user could cause return structured results (`Issue[]`), not exceptions. Throw only for
  programmer error.
- Vitest for anything with arithmetic in it. Geometry without tests is geometry that is wrong.
- Don't add a dependency without saying why. Prefer writing 40 lines to pulling in a package.

## How we work

We direct Claude Code rather than typing implementations. That works, but only with discipline:

- **Write a spec before building.** Look at `docs/spec-01` through `spec-05` for the shape. Exact
  file paths, exact signatures, the invariants that must hold, the edge cases, and what "done"
  means. If the spec is vague, Claude Code invents an answer and you inherit it.
- **Read what comes back.** Actually read it, not the summary. That's where you catch a float
  sneaking into a length, or a second millimetre conversion appearing.
- **One item at a time.** The failure mode for a project this size is five subsystems at 30%.
- **When it pushes back on a spec, take it seriously.** Several of the better decisions in this
  codebase came from exactly that.

### Git

- **Branch per track.** Never commit to `main` directly.
- Pull requests, and someone else reads it before it merges.
- **Anything touching `lib/plan/` or `lib/geometry/` needs review from K**, because those are the
  shared foundations every track depends on and a change there breaks everyone silently.
- Everything else is yours.

### Definition of done

`npx tsc --noEmit` clean, `npx vitest run` green, eslint clean, and `validate(sampleFlat())` still
returns `[]`. That last one is the canary — if the sample flat starts producing issues, something
in the foundations moved.

## The tracks

**Renderer.** Camera modes and the Google-Earth swoop (top-down → tap a room → animated dive →
look around), portal culling from the floorplan graph, lighting v1, and the screenshot accumulator.
Reads the document, writes nothing to it. Highly visual, and the swoop is the thing that stops
users getting lost.

**Furniture kernel.** Built-ins generated from boards rather than stretched — a 2340 wall gives
18mm sides, 2304 shelves, four 585 doors. Everything calculated, nothing scaled. Three things
decide whether it looks designed or looks like grey CAD boxes, and they are P0 not polish:
0.3-0.5mm chamfer on every board edge, real 2-3mm shutter reveals, and textures tiled at true
millimetre scale. Then materials and retrieved GLB props.

**Extraction and eval.** Upload, rectify, the mandatory scale gate, and the research contribution:
using the dimension strings printed on Indian builder plans as *hard constraints* in a global solve
rather than as soft hints. Plus the eval harness that produces the project's headline number.

## Assets

Poly Haven (CC0), ambientCG (CC0), Google Scanned Objects (CC-BY) are always safe.
**Do not use Poliigon** — its licence explicitly bans use in room-design apps.

## First thing to do

Clone it, `npm install`, `npm run dev`, and draw a flat by hand in the 2D editor. Watch it appear
in 3D. Ten minutes with the thing you're building on top of is worth more than another hour of
reading this.
