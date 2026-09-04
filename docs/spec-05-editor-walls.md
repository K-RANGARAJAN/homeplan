# Spec 05 — 2D plan editor, part 1: nodes and walls

Build order item 1, first of three passes. Read `CLAUDE.md`, `lib/plan/schema.ts`,
`lib/plan/validate.ts` and `lib/geometry/plan-space.ts` first. The plan-space conventions in
`CLAUDE.md` are binding — x east, y **downward**, nodes are centrelines.

## Why this exists

Two reasons, and the second is the one that matters.

It is the repair path when extraction gets something wrong. But more importantly, **it is the
measurement instrument for the whole project.** The eval harness needs 30 real Indian plans with
hand-measured ground truth; this is the tool that records that truth. Without it there is no way to
tell a good extraction from a bad one, and the project's central claim — a measured wall error —
cannot be made at all.

Build it as an instrument: precise, predictable, no surprises.

## Scope

**In:** draw walls, drag nodes, select, delete, snapping, typed exact lengths, pan and zoom, undo
and redo, live validation display.

**Out, later passes:** openings, rooms, backdrop image tracing, extraction. Do not start any of
them.

**Out entirely:** editing anything in 3D. Room shape is edited only here.

## Platform

**Desktop and touch, both, from the start.** That means: no hover-only affordances, no right-click
menus, touch targets at least 44px, and every gesture works with a single pointer. Use Pointer
Events, not mouse events. Assume no keyboard is available — anything bound to a key must also have
a visible control.

## State — `lib/plan/store.ts`

Zustand with the immer middleware. One store holding the current `PlanDoc` plus editor-local state
(selection, active tool, camera).

**Undo/redo comes from immer patches, not from document snapshots.** Every mutation produces a
patch and an inverse patch; the history is two stacks of patch groups. This is why immer is a
dependency. Snapshotting the whole document per keystroke is simpler for a week and becomes
unusable the moment documents get large.

**One user gesture = one undo step.** Dragging a node from A to B is a single entry, not one per
pointer-move event. Group at gesture boundaries — pointer-down opens a group, pointer-up closes it.

Editor state (what is selected, which tool is active, where the camera is) is **not** part of the
`PlanDoc` and is not undoable. Undo restores geometry, not viewport.

## Geometry helpers — extend `lib/geometry/`

Pure functions, tested, no React:

- Nearest node to a point, within a radius.
- Nearest wall to a point, within a radius, plus the parameter along it.
- Angle snapping: given an anchor and a raw point, return the point snapped to the nearest
  multiple of 90° from the anchor if within a tolerance, else unchanged.
- Splitting a wall at a point: one wall becomes two sharing a new node. **Openings on that wall
  must be reassigned to whichever half now contains them, with offsets recomputed.** There are no
  openings yet, so write the function to handle them and test it with a hand-built fixture — this
  is the single most error-prone operation in the editor and it must not be retrofitted.

## Snapping

Two kinds, both on by default, with a single visible toggle that turns both off.

**Existing nodes.** Within a screen-space radius (about 12px, so it stays constant as you zoom),
the point becomes that exact node. This is what stops two corners landing 3mm apart and silently
breaking room loops — the `NODES_NEARLY_COINCIDENT` case the validator already reports.

**90°.** While drawing or dragging, if the segment is within a few degrees of horizontal or
vertical relative to its anchor, make it exactly so.

**No grid.** Real flats are not on a grid, and a grid fights a traced backdrop. Round numbers come
from typing an exact length, which is a better mechanism.

Snap radii are in **screen pixels, converted to plan millimetres using the current zoom**. A
fixed millimetre radius feels broken at both ends of the zoom range.

Show the user what snapped and why: highlight the node being snapped to, show a guide line for an
angle snap. A snap that happens invisibly is indistinguishable from a bug.

## Tools

A small toolbar. Exactly one tool active at a time, always visibly indicated.

**Select** (default) — tap a node or wall to select. Tap empty space to clear. Drag a selected
node to move it; every attached wall follows, which is the entire point of the shared-node design.

**Draw wall** — tap to place the start, tap again to place the end, and continue chaining from that
end so a room can be drawn in one sequence. A visible Done control ends the chain; on desktop
Escape also works. Each committed segment is one undo step.

While drawing, show a live preview of the pending segment with its current length in millimetres.

Drawing onto an existing wall's middle splits it. Drawing onto an existing node attaches to it.

**Delete** — removes the selected node or wall. Deleting a node deletes the walls attached to it.
Warn before deleting something that would orphan other elements, and say what will go.

New walls default to 115mm thickness, 2900mm height, with `meta.source: 'user'` and
`confidence: 1`.

## Typed exact lengths

**This is the feature that makes the tool an instrument rather than a sketchpad**, so give it real
attention.

Select a wall, and its length is shown in an editable field in millimetres. Type a number, commit,
and the wall becomes exactly that length.

The hard question is what moves. Decide and comment your reasoning:

- Which endpoint moves — the one further from the rest of the structure, the one with fewer
  attached walls, or a user choice?
- What happens to walls attached to the moved node? They follow, by the shared-node rule. This can
  distort the rest of the plan, which may or may not be what the user wanted.

Pick the least surprising behaviour, state it in a comment, and make it visible in the UI before
committing (preview the change). Getting this wrong makes the tool feel possessed.

## Rendering — `components/editor/`

Plain SVG. No library — none fits this document shape, and the interaction is simple enough that
one would cost more than it saves.

- Walls as lines with their real thickness at the current zoom, so the drawing reads like a plan.
- Nodes as small circles, larger when selected, with a touch target well beyond the visible dot.
- Selection clearly indicated.
- Elements with `meta.source: 'auto'` and low `confidence` shaded differently. Nothing produces
  those yet, but the shading is how a user will later know where to look after an extraction, and
  wiring it now costs nothing.
- A scale indicator, since without one the drawing has no sense of size.

**Pan and zoom:** drag on empty space pans, pinch or wheel zooms. Zoom about the pointer, not the
centre of the screen. Keep the transform as a simple {scale, translate} pair and apply it as one
SVG transform — do not recompute per-element coordinates.

## Live validation

Run `validate()` on every document change and display the result. Errors and warnings visually
distinct. Tapping an issue selects and centres the elements in its `refs` — this is why `refs`
carries the collection kind.

Keep it unobtrusive: a count that expands, not a permanent panel eating half a phone screen.

Debounce if it costs anything, but measure first — the sample flat validates in well under a
millisecond and premature debouncing adds lag for no reason.

## Page

Replace the current viewport-only page with something that shows both: the 2D editor and the 3D
view of the same document. Split on desktop, tabbed or switchable on mobile. Both read the same
store, so an edit in 2D updates the 3D immediately — that is the "one document, many renderings"
principle made visible, and it is also the fastest way to spot a geometry bug.

Load `sampleFlat()` as the starting document. Persistence is a later task.

## Tests

Geometry helpers get real tests: node/wall hit testing, angle snapping at boundaries, wall
splitting with openings present.

Store operations get tests: draw a wall, undo, redo, confirm the document matches. Drag a node and
confirm attached walls follow. Delete a node and confirm dependent walls go with it. Confirm one
gesture is one undo step.

Rendering does not need tests.

**One integration test worth its weight:** build a small plan through store operations only, and
assert `validate()` returns `[]`. If the editor can produce an invalid document through ordinary
use, that is the bug to find now.

## Done when

- `npx tsc --noEmit` clean, `npx vitest run` green, eslint clean.
- No `any`, no non-null `!`.
- A flat can be drawn from nothing, on both desktop and a phone-sized viewport, and it validates
  clean.
- Undo and redo work across every operation, one step per gesture.
- The 3D view updates as the 2D is edited.

Print the finished files in full. Say what you chose for the typed-length behaviour and why, and
flag anything in this spec that fought the existing schema.
