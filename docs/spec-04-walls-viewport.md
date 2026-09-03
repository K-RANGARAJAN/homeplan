# Spec 04 — Wall footprints, mitering, and the first viewport

Build order item 0, final piece. Read `CLAUDE.md`, `lib/plan/schema.ts` and `lib/plan/sample.ts`
first. The plan-space, left/right and centreline conventions in `CLAUDE.md` are binding — implement
them here, once, and import them everywhere after.

Four files:

- `lib/geometry/plan-space.ts`
- `lib/geometry/walls.ts`
- `lib/geometry/walls.test.ts`
- `components/viewport/Viewport.tsx` (plus whatever it needs), mounted from `app/page.tsx`

## Scope

**In:** wall footprints with correct mitering, extrusion to height, a floor, even lighting, faint
contact shadows, orbit controls, the sample flat on screen.

**Out, and do not start:** openings (walls are solid this task), portal culling, the four camera
modes and the swoop, single-sided walls and dithered fade, ceilings, materials, textures, furniture,
the 2D editor. Each is a later build-order item and each is bigger than it looks.

## Part 1 — `lib/geometry/plan-space.ts`

The small shared vocabulary. Pure, no three.js.

- A 2D point type in plan millimetres.
- Basic vector operations as needed: subtract, length, normalise, dot, scale.
- **`leftNormal(direction)`** — the convention from `CLAUDE.md`, implemented exactly once. For
  direction `(dx, dy)`, returns `(dy, -dx)`. With y increasing downward, walking east puts north on
  your left. Every door swing and item anchor in the app resolves through this function; if it is
  wrong, everything is wrong consistently, which is worse than being wrong loudly.
- **`MM_PER_M = 1000`** and a `toMetres()` helper. This is the only conversion in the codebase.
  Everything upstream is millimetres; only the three.js boundary calls this.

Note in a comment that mitred corner points are **not** integers — they are intersections of offset
lines and land on fractions. That is correct and expected: the *document* is integer millimetres,
derived geometry is not. Derived coordinates must never be used as map keys or equality tests.

## Part 2 — `lib/geometry/walls.ts` — the actual work

### The problem

A wall is a centreline from node `a` to node `b` with a thickness. Naively it becomes a rectangle,
the centreline offset by ±thickness/2. Where two walls meet, those rectangles overlap on the inside
of the corner and leave a wedge of nothing on the outside. At a T-junction you get a notch; at a
non-90° corner you get a gap. Both are immediately visible in 3D and no amount of later polish
hides them.

### The approach

Junctions must be solved per node, not per wall — a wall cannot know where to stop without knowing
what it meets.

For each node, take every wall attached to it and sort them by the angle of their direction *away*
from that node. Each adjacent pair in that angular order defines a corner. The corner point is the
intersection of the two relevant offset lines: the first wall's edge on one side, the second wall's
edge on the facing side. Walk the angular order and every wall end receives its two endpoints — one
per side — which in general are **not** the perpendicular ends and **not** symmetric.

A wall's footprint is then the polygon through its four resulting corner points. Return it as a
point array, not a fixed quad, because the bevel fallback below can produce more.

### Cases that must be handled

- **Degree 1 (dead end).** Nothing to miter against. Square butt end, perpendicular to the
  centreline.
- **Degree 2.** The ordinary corner. Both walls extend or retreat to the shared miter points.
- **Degree 3+.** T-junctions and the four-way at `n16` in the sample flat. Each angular gap gets its
  own intersection, so one wall end's left point is computed against a different neighbour from its
  right point. This is the case naive implementations get wrong, and it is the reason the fixture
  has one.
- **Different thicknesses meeting.** A 230mm external wall meeting a 115mm partition. The offset
  distances differ; the intersection maths is unchanged. Very common in the sample flat.
- **Near-collinear walls.** Two walls almost in a straight line have almost-parallel offset lines,
  and the intersection shoots off toward infinity. Define a **miter limit** as a named constant —
  a multiple of the wall thickness — and fall back to a bevel (two points instead of one) when the
  miter point exceeds it. Comment the constant with what it is protecting against.
- **Exactly collinear walls.** Parallel offset lines, no intersection at all. Butt them
  perpendicular. Detect this by the cross product rather than by catching a division by zero.

### Signature

Compute the whole level at once, since junctions need neighbours:

```ts
export function wallFootprints(level: Level): Map<string, Point[]>
```

Pure. No three.js, no React. Walls whose nodes are missing are skipped rather than throwing — the
validator already reports those, and the viewport must still render everything it can. A document
with one broken wall should show the other twenty-four.

## Part 3 — extrusion

Turn each footprint plus its wall height into a solid prism.

**Hand-build the `BufferGeometry`. Do not use `ExtrudeGeometry`.** Its UV layout is unusable for
textures tiled at true millimetre scale, which is a P0 requirement later, so using it now means
writing this twice. Positions and normals this task; leave the per-face structure such that UVs can
be added without restructuring.

Plan `(x, y)` maps to world `(x, z)`. Height goes up in `y`. Convert to metres exactly here and
nowhere else.

Walls are solid closed prisms for now — all faces, visible from every angle. The single-sided,
normals-inward, dithered-fade treatment is item 2. Solid is deliberate for this task: **miter errors
must be visible**, and a wall that vanishes when you orbit past it hides exactly the bug we are here
to catch.

## Part 4 — the viewport

`components/viewport/Viewport.tsx`, a client component, mounted from `app/page.tsx` filling the
window.

- react-three-fiber `<Canvas>`.
- Orbit via `camera-controls` (drei's wrapper is fine). Drag orbits the model, like a car
  configurator. Nothing else this task — no room selection, no swoop, no POV.
- On load, frame the whole flat: compute the plan's bounding box and fit the camera to it. Opening
  to a default camera pointing at nothing is the first thing that makes a 3D tool feel broken.
- A floor plane covering the plan's bounding box, plain neutral colour. Per-room floors need
  polygon triangulation and materials; both are later.
- **Lighting v1, per `CLAUDE.md`:** no fixtures, just even brightness so everything is legible,
  plus faint contact shadows so shapes read as solid rather than as flat cardboard. A hemisphere or
  ambient light plus one soft directional is enough. Do not build the bounced-light proxy scene —
  that is item 3 and doing it before materials exist is guesswork.
- Neutral background, distinguishable from both the floor and the walls.
- Render `sampleFlat()`. Nothing loads from disk this task.

Keep geometry generation out of the render loop. Compute footprints once with `useMemo` keyed on
the document; the mesh components consume the result. A geometry rebuild on every frame is the
performance mistake that gets baked in early and is miserable to unpick.

## Part 5 — tests, `lib/geometry/walls.test.ts`

This is arithmetic, so it is tested numerically, headlessly, with no renderer. Assert exact
coordinates where the geometry is exact.

- **One wall alone.** Both ends are square butts; the footprint is the expected rectangle; its area
  equals length × thickness.
- **Two walls at 90°, equal thickness.** Assert the *exact* expected coordinates of both miter
  points. Hand-compute them for the test — a test that recomputes them the way the implementation
  does proves nothing.
- **Two walls at 90°, different thicknesses.** Same, hand-computed.
- **Two walls at a non-90° angle.** Assert the outer corner is a single sharp point, not two points
  with a gap between them.
- **A T-junction.** Three walls at one node. Assert no gaps: the three footprints between them cover
  the junction area with no hole. Choose a defensible way to assert this and comment it.
- **The four-way junction.** Four walls at one node, the `n16` case.
- **Collinear continuation.** Two walls in a straight line, same thickness, produce a continuous
  footprint with no notch and no runaway coordinates.
- **Near-collinear.** The miter limit engages and the coordinates stay bounded. Assert a specific
  bound rather than merely "is finite".
- **A dead end.** Degree-1 node gives a perpendicular butt.
- **Over the whole sample flat:** every wall produces a footprint; every footprint is a simple
  polygon with positive area; no footprint has a coordinate wildly outside the plan bounding box
  (the runaway-miter smoke test).
- **No adjacent pair of footprints overlaps** beyond a negligible amount. Overlap at a junction is
  what mitering exists to remove.

## Done when

- `npx tsc --noEmit` clean, `npx vitest run` green, eslint clean.
- No `any`, no non-null `!`.
- `npm run dev` shows the sample flat's walls standing up, correctly joined, orbitable, lit.
- Nothing in `lib/geometry` imports three.js or React.

Print the finished files in full. Say which junction cases you are least confident about, and
describe what a miter failure would look like on screen so it can be recognised rather than guessed
at.
