# CLAUDE.md

Read this at the start of every session. It is binding.

## What this project is

An interior design planner. A homeowner uploads their apartment floor plan, gets an accurate
navigable 3D model of **their actual flat**, then furnishes it by describing what they want in
plain language. Output is labelled screenshots they can show a carpenter.

The promise is not "here's a beautiful idea for a home" — that's Pinterest. It is **"here's what
will actually fit and work in YOUR home."** The room is theirs, the wall is the real length, the
wardrobe is the width it would actually have to be.

Division of labour with the carpenter: **the app carries the form, the carpenter carries the
millimetres.** He measures the wall himself and builds to fit. We do NOT produce construction
drawings, cut lists, or hardware schedules.

Solo university project, India. Priorities in order: learning, portfolio, maybe a business later.
`homeplan` is a placeholder name.

## Core philosophy — do not violate

```
AI understands meaning
  -> our code does the geometry and numbers
    -> the solver validates placement
      -> the furniture kernel generates geometry
        -> the renderer draws it
```

**The AI proposes, the solver disposes, the renderer obeys.**

The first time chat writes a position directly, debuggability is gone. If you find yourself about
to let a language model emit a coordinate, a dimension, or a piece of geometry code — stop, and
say so instead of doing it.

## The spine: one document

There is ONE JSON document per project (`lib/plan/schema.ts`). Every view — 2D plan, 3D scene,
screenshots, chat context — is a *rendering* of it. The 3D scene is never a separate thing that
gets synced.

Four rules the schema enforces. Do not work around any of them:

1. **Integer millimetres everywhere.** Convert to metres exactly once, at the three.js boundary.
   Floats plus snapping produces equality bugs forever.
2. **Walls reference shared node IDs**, never their own coordinates. Drag a corner, all attached
   walls follow. Per-wall `[x1,y1,x2,y2]` is simpler for a week and leaks hairline gaps at
   T-junctions for the rest of the project.
3. **Openings anchored by absolute offset from node `a`**, not a 0..1 fraction. A fraction moves
   the door when the wall is lengthened.
4. **Items store an anchor, not a position.** World transforms are derived. There is no `x`/`y`
   field on an item, so "floating in mid-air" is unrepresentable by construction.

Every element carries `meta.source` (`auto` / `user` / `derived`) and `confidence`. Re-running
extraction must never clobber a user's fix. Preserve these fields through every transformation.

## Stack

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind 4
three.js 0.185 · @react-three/fiber 9.7 · @react-three/drei 10.7 · camera-controls 3.1
zustand + immer (patches give undo nearly free) · zod (validates the document)
Geometry: clipper2 (free space) · rbush (broad phase) · sat-js (overlap) · manifold (booleans,
only where genuinely unavoidable)
2D editor: plain SVG/Canvas — no library fits this document shape.

**Deliberately absent, do not introduce:** game engine, Blender in the runtime, Python service,
GPU box, CAD kernel on the client.

Do not add a dependency without saying why in the same message. Prefer writing 40 lines to
pulling in a package.

## Subsystem constraints

Only the parts that constrain code. Ask before designing beyond these.

**Floor plan -> geometry.** Upload -> rectify if photo -> **scale gate** -> extraction -> cleanup
-> 2D editor. The scale gate is mandatory: a plan image has no inherent real-world size. Read
every dimension string, RANSAC to consensus, pre-fill, then require the user to confirm by
clicking two ends of one known wall. **Nothing reaches 3D on an unconfirmed scale.**

Extraction is a TIME-SAVER, NOT A SOURCE OF TRUTH. Published methods get ~40% of corners wrong on
real plans. Build the 2D editor first. Put extraction behind a swappable
`Extractor.extract(image) -> PlanDoc` interface.

**3D shell.** Walls = plan lines given thickness, extruded to 2900mm.
- **Miter wall ends at junctions.** Naive per-wall offsetting leaves notches at T-junctions and
  gaps at non-90° corners — the #1 visual bug in hand-rolled planners.
- **Build walls in pieces AROUND openings.** Never boolean-subtract holes.
- Walls single-sided, normals into the room, dot-product visibility vs camera, dithered fade.
  Ceiling on its own layer, off except in walkthrough.
- **Portal culling** from the floorplan graph (rooms = cells, doorways = portals).
- Navigation is Google Earth style: top-down overview -> press a room -> **animated swoop** down
  -> look around in POV. The fly transition is not cosmetic; it stops people getting lost.
  Drag = orbit, like a car configurator.
- **Room shape is edited ONLY in the 2D plan, never in 3D.** The 3D view changes features
  (furniture, finishes), not geometry.

**Lighting v1.** Even brightness, no fixtures, plus faint contact shadows so shapes read as 3D.
Leave the plumbing for bounced light (a proxy-scene representation) in place now — retrofitting
it later invalidates the geometry batching.

**Chat -> intent.** The LLM's only job is filling a small, closed, flat schema.
- **No `x`/`y` in the tool schema at all.** Absolute positions must be unexpressible.
- **Never regenerate, always patch the JSON.** Constraint drift must be structurally impossible.
- ~7 macro tools: addFurniture, moveFurniture, resizeFurniture, setParameter, setMaterial,
  removeFurniture, queryScene. Every call names a stable short ID.
- Resolve "it"/"that" OUTSIDE the model, with a focus stack (last-created, last-modified,
  selected). If two candidates match, ask the user.
- One utterance = one grouped op = one undo step. Ops carry inverses.

**Placement solver.** The AI says *where relative to what*; this computes *where exactly*.
DoF reduction -> free space (room polygon − footprints ⊕ clearances − door swing sectors −
corridors) -> enumerate every 50mm × 4 yaws -> score -> argmin, keep top 3.

Rules are **data, not code** — an editable table. That table is the encoded design knowledge and
the most valuable artifact in the project. Never hardcode a clearance in a function.

Seed values (mm): main walkway 915, secondary 760, each side of bed 760, foot of bed 915, in
front of hinged wardrobe 1000, kitchen work aisle 1065 (1220 multi-cook), sofa->coffee table
355-455, behind seated diner 1015. Door swing = 90° sector polygon, radius = leaf width.

**India defaults, not US:** counter height 750-800 (not 915); NBC door widths main 1.0m /
bedroom 0.90m / kitchen 0.80m / bath 0.75m. Region-switch the table (`region: 'IN' | 'US'`).

**Explainable failure is the feature.** Never return "no valid placement". Return
*"I fitted the 1800 wardrobe — the 2400 would leave only 700mm to squeeze past your bed."*
Hard/soft rule split, explicit relaxation ladder, report what was relaxed.

**Parametric furniture.** Built-ins are *built* from boards, never stretched — stretching breaks
handles, plinths and grain at about ±15%. Wall is 2340 -> sides 18mm, shelves 2304, each of 4
doors 585. Everything calculated.
- Generated: wardrobe (hinged/sliding), study desk, TV unit, kitchen base/wall runs, storage bed,
  shelving, vanity.
- Retrieved GLB: sofas, chairs, dining sets, appliances, sanitaryware, lamps, plants, decor.
- **`setParameter` must NOT be offered on retrieved assets** — the model must not promise what we
  cannot do.
- Primitives: Board (L×W×T, material, grain) · Carcass · Division · Shutter (with reveals) ·
  Drawer · Shelf · RunAlongWall · Extrusion.
- **P0, not polish:** (a) 0.3-0.5mm chamfer on every board edge, (b) real 2-3mm shutter reveals,
  (c) textures tiled at true mm scale, grain-direction aware. These three decide whether it looks
  designed or looks like grey CAD boxes.

**Screenshots.** Do NOT use `canvas.toDataURL()`. Accumulate 32-64 jittered subpixel samples in
the SAME renderer with the SAME settings. Any path through a different renderer inherits a
permanent "export doesn't match preview" bug. Eye height 1550mm, **horizon dead level**.

**Eval harness.** 30 real Indian builder floor plans, wall lengths measured by hand once = the
answer key. Do not skip. It is the difference between "I built an app" and "I built an app and
here's how accurate it is".

## Code conventions

- TypeScript strict. No `any`. No non-null `!` to silence the compiler — fix the type.
- All lengths are integer millimetres, typed as such. Name variables `widthMm`, never `width`.
- Pure functions for geometry. No reaching into React state from a geometry module.
- Zod validates at the boundaries: file load, extraction output, LLM tool call. Not everywhere.
- Errors that a user could cause return structured results (`Issue[]`), not thrown exceptions.
  Throw only for programmer error.
- Vitest for anything with arithmetic in it. Geometry without tests is geometry that is wrong.

## Assets

Poly Haven (CC0), ambientCG (CC0), Google Scanned Objects (CC-BY) are always safe.
**Do not use Poliigon** — its licence explicitly bans use in room-design apps.

## Build order

0. Schema + validator + sample flat + empty viewport   <- IN PROGRESS
1. 2D plan editor (walls, openings, rooms, backdrop, typed lengths)
2. Wall extrusion + mitering + 4 camera modes + portal culling
3. Lighting v1
4. Upload -> rectify -> scale gate -> extraction -> cleanup
5. Chat -> intent -> tool calls -> doc patches -> undo
6. Placement solver + rule table + violation reporting
7. Furniture kernel + 5-6 recipes
8. Materials + GLB props
9. Screenshot accumulator + annotations
10. Eval harness
11. Hardening

**Prefer depth over breadth. One subsystem at 100% beats five at 30%** — that is the actual
failure mode for a project this size. Do not start the next item because the current one is
boring.

## Open decisions — ask, do not assume

1. **Paid Claude API vs fully self-hosted models.** A zero-cost path exists (CubiCasa5K weights
   via ONNX Runtime Web, LoRA-tuned 1-3B via WebLLM, grammar-constrained decoding, browser-only
   storage, static hosting) but relies on CC-BY-NC and research-only datasets, which would block
   commercialisation later. **Not decided.**
2. India-first or region-neutral
3. Desktop-first or mobile from day one
4. A real name
5. **Plan space:** x increases east, y increases **downward** (south), matching SVG and screen
   coordinates so the 2D editor needs no flip. The three.js boundary maps plan (x, y) to world
   (x, z) and is the only place this changes.
6. **Left and right of a wall** mean left and right for a person walking from node `a` to node `b`,
   looking down at the plan: for direction (dx, dy), the left side is the half-plane that (dy, -dx)
   points into. Walking east, north is on your left. Door swings and item anchors are both defined
   against this. Implement it once, in `lib/geometry`, and import it everywhere.
7. **Nodes are wall centrelines, not faces.** A wall occupies thicknessMm/2 either side. Derived
   face coordinates therefore land on half-millimetres even though every stored value is an
   integer — this is correct and expected. Never use a face coordinate as a map key or an equality
   test. Node IDs are the identity.

## How to work here

- The user is directing, not writing the code. Explain decisions in plain language. Define jargon
  the first time you use it.
- Build exactly what was specified. If the spec is ambiguous, ask — do not pick and proceed.
- If a spec conflicts with this file, say so before writing anything.
- Show real code, not summaries of code.
- One item at a time.
