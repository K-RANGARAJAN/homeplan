/**
 * lib/plan/store.ts — the editor's state, and the only place the document is mutated.
 *
 * TWO KINDS OF STATE LIVE HERE AND THEY ARE NOT THE SAME KIND OF THING.
 *
 *   - `doc` is the one document. Every view in the app is a rendering of it, and every change to it
 *     is undoable.
 *   - Everything else — what is selected, which tool is active, where the 2D camera is, whether
 *     snapping is on — is EDITOR state. It is not part of the `PlanDoc`, it is never saved with it,
 *     and it is not undoable. Undo restores geometry, not viewport: an undo that scrolled the plan
 *     back to where it was five minutes ago would make the user hunt for their own work.
 *
 * UNDO COMES FROM IMMER PATCHES, NOT FROM SNAPSHOTS. Every mutation produces a patch and an inverse
 * patch, scoped to `doc`, and the history is two stacks of patch groups. Snapshotting the whole
 * document per change is simpler for about a week and then becomes unusable: a plan with a hundred
 * walls, a dozen rooms and eventually a flat's worth of furniture, copied on every pointer-move of a
 * drag, at sixty of those a second.
 *
 * ONE USER GESTURE IS ONE UNDO STEP. Dragging a corner from A to B emits a mutation per pointer
 * event and lands in the history as a single entry, because the gesture opens a GROUP on
 * pointer-down and closes it on pointer-up. Undo pops the group and applies its inverses in reverse.
 *
 * Not a server module: it builds a zustand store at import time and is only ever pulled in by client
 * components. It has no `'use client'` directive because it uses no React APIs itself — the
 * components that consume it carry the boundary.
 */

import { applyPatches, castDraft, enablePatches, produceWithPatches, type Draft, type Patch } from 'immer';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

import { planLengthChange, splitWall, type LengthChange, type WallEnd } from '../geometry/edit';
import { indexNodes, wallEnds } from '../geometry/pick';
import { distance, type Point } from '../geometry/plan-space';
import { describeDeletion, isEmptyDeletion, planDeletion, type Deletion, type Selected } from './delete';
import { freshId, ID_PREFIX, levelIds } from './ids';
import { sampleFlat } from './sample';
import type { Level, PlanDoc } from './schema';
import { validate, type Issue, type IssueRef } from './validate';

// Immer generates patches only when asked to; without this every `produceWithPatches` returns empty
// arrays and undo silently does nothing. Called once, at import.
enablePatches();

export type { Selected } from './delete';

/* ------------------------------------------------------------------------------------------------
 * New walls
 * ---------------------------------------------------------------------------------------------- */

/** A 115mm internal partition at full ceiling height: the wall a user is most often drawing. */
const NEW_WALL_THICKNESS_MM = 115;
const NEW_WALL_HEIGHT_MM = 2900;

/* ------------------------------------------------------------------------------------------------
 * Camera
 *
 * A single {scale, translate} pair, applied to the SVG as ONE transform. Recomputing every element's
 * coordinates on pan would throw away the browser's own transform machinery, make every node a
 * render, and put a rounding step between the document and what is drawn.
 * ---------------------------------------------------------------------------------------------- */

export interface Camera {
  /** Screen pixels per plan millimetre. */
  pxPerMm: number;
  /** Screen position, in pixels, of plan (0, 0). */
  xPx: number;
  yPx: number;
}

/** Roughly 2mm per pixel at one end and 500mm per pixel at the other: a whole tower to a door stop. */
const MIN_PX_PER_MM = 0.002;
const MAX_PX_PER_MM = 0.5;

export function toScreen(camera: Camera, p: Point): { x: number; y: number } {
  return { x: p.x * camera.pxPerMm + camera.xPx, y: p.y * camera.pxPerMm + camera.yPx };
}

export function toPlan(camera: Camera, xPx: number, yPx: number): Point {
  return { x: (xPx - camera.xPx) / camera.pxPerMm, y: (yPx - camera.yPx) / camera.pxPerMm };
}

/**
 * Zoom about a screen point, keeping whatever is under it exactly where it is.
 *
 * Zooming about the centre of the viewport instead is the single most common way to make a plan
 * editor feel wrong: the user points at the thing they want to see and it slides away from the
 * pointer as they zoom in.
 */
export function zoomAbout(camera: Camera, factor: number, xPx: number, yPx: number): Camera {
  const pxPerMm = Math.min(MAX_PX_PER_MM, Math.max(MIN_PX_PER_MM, camera.pxPerMm * factor));
  const actual = pxPerMm / camera.pxPerMm;
  return {
    pxPerMm,
    xPx: xPx - (xPx - camera.xPx) * actual,
    yPx: yPx - (yPx - camera.yPx) * actual,
  };
}

interface PlanBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** The extent of the drawn corners, including half of the thickest wall. `null` for an empty plan. */
function planBounds(level: Level): PlanBounds | null {
  if (level.nodes.length === 0) return null;
  const margin = Math.max(0, ...level.walls.map((w) => w.thicknessMm / 2));
  const xs = level.nodes.map((n) => n.x);
  const ys = level.nodes.map((n) => n.y);
  return {
    minX: Math.min(...xs) - margin,
    minY: Math.min(...ys) - margin,
    maxX: Math.max(...xs) + margin,
    maxY: Math.max(...ys) + margin,
  };
}

/** A camera that puts `bounds` in the middle of a `widthPx` x `heightPx` box with `padPx` around it. */
function fitCamera(
  bounds: PlanBounds | null,
  widthPx: number,
  heightPx: number,
  padPx: number,
): Camera {
  // An empty plan has no extent to fit, so it gets a scale at which a 10-metre flat would fill the
  // box — the size of the thing the user is about to draw.
  if (bounds === null) {
    const pxPerMm = clampScale(Math.min(widthPx, heightPx) / 10_000);
    return { pxPerMm, xPx: widthPx / 2, yPx: heightPx / 2 };
  }

  const spanX = Math.max(1, bounds.maxX - bounds.minX);
  const spanY = Math.max(1, bounds.maxY - bounds.minY);
  const pxPerMm = clampScale(
    Math.min((widthPx - padPx * 2) / spanX, (heightPx - padPx * 2) / spanY),
  );

  return {
    pxPerMm,
    xPx: widthPx / 2 - ((bounds.minX + bounds.maxX) / 2) * pxPerMm,
    yPx: heightPx / 2 - ((bounds.minY + bounds.maxY) / 2) * pxPerMm,
  };
}

function clampScale(pxPerMm: number): number {
  if (!Number.isFinite(pxPerMm) || pxPerMm <= 0) return MIN_PX_PER_MM;
  return Math.min(MAX_PX_PER_MM, Math.max(MIN_PX_PER_MM, pxPerMm));
}

/* ------------------------------------------------------------------------------------------------
 * History
 * ---------------------------------------------------------------------------------------------- */

interface PatchEntry {
  patches: Patch[];
  inverse: Patch[];
}

interface PatchGroup {
  /** What the user did, in their words. Shown on the undo button. */
  label: string;
  entries: PatchEntry[];
}

interface History {
  past: PatchGroup[];
  future: PatchGroup[];
  /** The gesture currently in progress, collecting patches. */
  open: PatchGroup | null;
  /**
   * Gesture nesting depth.
   *
   * Actions call `beginGesture` themselves so that they are one undo step when invoked directly, and
   * a drag wraps several of them in an outer gesture. Without a depth count the inner action's
   * `endGesture` would close the drag's group at the first pointer-move and the drag would land in
   * the history as a hundred entries.
   */
  depth: number;
}

/* ------------------------------------------------------------------------------------------------
 * Tools and the drawing chain
 * ---------------------------------------------------------------------------------------------- */

export type Tool = 'select' | 'draw' | 'delete';

/**
 * What the next drawn point attaches to.
 *
 * Deliberately NOT a node id. Tapping the middle of an existing wall means "split it here", and
 * tapping empty space means "make a corner here", and neither should touch the document until the
 * segment they belong to is actually committed — otherwise the first tap of a chain is an undo step
 * that produced a lone corner attached to nothing.
 */
export type DrawAnchor =
  | { on: 'node'; node: string }
  | { on: 'wall'; wall: string; at: Point }
  | { on: 'empty'; at: Point };

export interface DrawChain {
  /** Where the next segment starts. */
  from: DrawAnchor;
}

/* ------------------------------------------------------------------------------------------------
 * The store
 * ---------------------------------------------------------------------------------------------- */

export interface PlanState {
  doc: PlanDoc;
  /** Recomputed on every document change. See `revalidate` for why it is not debounced. */
  issues: Issue[];

  selection: Selected[];
  tool: Tool;
  camera: Camera;
  /** Both kinds of snap, on or off together, from one visible control. */
  snapping: boolean;
  chain: DrawChain | null;
  /**
   * A deletion the user has been asked to confirm, because it would take more than they selected.
   * Editor state: what is on screen waiting for an answer, not part of the document.
   */
  pendingDelete: Deletion | null;
  /**
   * The uncommitted result of the length field, so the plan can draw a ghost of the change before it
   * happens. Previewing is the whole reason the typed-length feature does not feel possessed: the
   * user sees which corner is about to move and what follows it.
   */
  lengthPreview: LengthChange | null;
  /** Size of the drawing surface in CSS pixels. Needed to fit and to centre, and measured by it. */
  viewport: { widthPx: number; heightPx: number };
  /**
   * A one-line explanation of something the editor just refused to do. Transient, editor-only,
   * cleared by the next action. "Explainable failure is the feature" applies here as much as it does
   * to the placement solver — an editor that silently declines a tap is indistinguishable from a
   * broken one.
   */
  notice: string | null;

  history: History;

  /* -- gestures -- */
  beginGesture: (label: string) => void;
  endGesture: () => void;

  /* -- document -- */
  drawTo: (anchor: DrawAnchor) => void;
  endChain: () => void;
  moveNode: (nodeId: string, to: Point) => void;
  setWallLength: (wallId: string, lengthMm: number, moving: WallEnd) => void;
  deleteSelection: () => void;
  requestDelete: () => void;
  confirmDelete: () => void;
  cancelDelete: () => void;

  /* -- editor -- */
  setTool: (tool: Tool) => void;
  select: (selection: Selected[]) => void;
  setSnapping: (on: boolean) => void;
  setCamera: (camera: Camera) => void;
  setViewport: (widthPx: number, heightPx: number) => void;
  fitToPlan: () => void;
  setLengthPreview: (preview: LengthChange | null) => void;
  /** Select the elements an issue names, and bring them into view. */
  focus: (refs: readonly IssueRef[]) => void;
  setNotice: (notice: string | null) => void;

  /* -- history -- */
  undo: () => void;
  redo: () => void;
  reset: (doc: PlanDoc) => void;
}

/** v1 has one level. The index is carried here rather than sprinkled through every caller. */
const LEVEL_INDEX = 0;

export function currentLevel(doc: PlanDoc): Level {
  return doc.levels[LEVEL_INDEX];
}

const INITIAL_DOC = sampleFlat();

export const usePlanStore = create<PlanState>()(
  immer((set, get) => {
    /**
     * The one place `doc` changes.
     *
     * Patches are scoped to the DOCUMENT, not to the whole store — a patch path that began at the
     * store root would carry the history stacks inside itself, and undoing would restore the history
     * that produced it.
     */
    const mutate = (recipe: (doc: Draft<PlanDoc>) => void): void => {
      const [next, patches, inverse] = produceWithPatches(get().doc, recipe);
      if (patches.length === 0) return; // A no-op edit must not become an undo step.

      set((state) => {
        state.doc = castDraft(next);
        state.issues = castDraft(validate(next));

        const entry: PatchEntry = { patches, inverse };
        if (state.history.open !== null) {
          state.history.open.entries.push(entry);
        } else {
          state.history.past.push({ label: 'Edit', entries: [entry] });
          state.history.future.length = 0;
        }
        prune(state);
      });
    };

    /** Drop selection and drawing state that now point at elements which no longer exist. */
    const prune = (state: Draft<PlanState>): void => {
      const level = currentLevel(state.doc);
      const nodes = new Set(level.nodes.map((n) => n.id));
      const walls = new Set(level.walls.map((w) => w.id));

      state.selection = state.selection.filter((s) =>
        s.kind === 'node' ? nodes.has(s.id) : walls.has(s.id),
      );

      const from = state.chain?.from;
      if (from === undefined) return;
      const alive = from.on === 'node' ? nodes.has(from.node) : from.on === 'wall' ? walls.has(from.wall) : true;
      if (!alive) state.chain = null;
    };

    /**
     * Turn an anchor into a real corner, creating one or splitting a wall if that is what it means.
     *
     * Runs as its own mutation rather than inside the caller's, because a split has to be computed
     * against the document as it stands — and drawing from the middle of one wall to the middle of
     * another splits two of them, the second of which must see the result of the first. Both land in
     * the caller's open gesture, so they are still one undo step.
     */
    const resolveAnchor = (anchor: DrawAnchor): string | null => {
      const level = currentLevel(get().doc);

      if (anchor.on === 'node') {
        return level.nodes.some((n) => n.id === anchor.node) ? anchor.node : null;
      }

      if (anchor.on === 'empty') {
        const id = freshId(ID_PREFIX.node, levelIds(level));
        mutate((doc) => {
          currentLevel(doc).nodes.push({
            id,
            x: Math.round(anchor.at.x),
            y: Math.round(anchor.at.y),
            meta: { source: 'user', confidence: 1 },
          });
        });
        return id;
      }

      const taken = levelIds(level);
      const ids = { node: freshId(ID_PREFIX.node, taken), wall: freshId(ID_PREFIX.wall, taken) };
      const outcome = splitWall(level, anchor.wall, anchor.at, ids);

      if (!outcome.ok) {
        if (outcome.reason === 'at-end') {
          // The tap landed on the wall but within rounding of one of its corners. Attaching to that
          // corner is what the user meant, and it is what node snapping would have done had they
          // been a pixel closer.
          return nearestEndOf(level, anchor.wall, anchor.at);
        }
        if (outcome.reason === 'through-opening') {
          const names = outcome.openings.map((o) => `${o.kind} ${o.id}`).join(' and ');
          set((state) => {
            state.notice = `That would cut wall ${anchor.wall} through the ${names}. Move the corner clear of it, or split the wall on the other side.`;
          });
        }
        return null;
      }

      const { split } = outcome;
      mutate((doc) => {
        const target = currentLevel(doc);
        const wall = target.walls.find((w) => w.id === split.shortenedWall);
        if (wall === undefined) return;

        target.nodes.push(castDraft(split.node));
        wall.b = split.node.id;
        target.walls.push(castDraft(split.addedWall));

        for (const move of split.movedOpenings) {
          const opening = target.openings.find((o) => o.id === move.id);
          if (opening === undefined) continue;
          opening.wall = move.wall;
          opening.offsetMm = move.offsetMm;
        }
        for (const move of split.movedItems) {
          const item = target.items.find((i) => i.id === move.id);
          if (item === undefined || item.anchor.on !== 'wall') continue;
          item.anchor.wall = move.wall;
          item.anchor.offsetMm = move.offsetMm;
        }
        for (const insertion of split.roomInsertions) {
          const room = target.rooms.find((r) => r.id === insertion.room);
          if (room === undefined) continue;
          room.wallLoop.splice(insertion.index, 0, split.addedWall.id);
        }
      });

      return split.node.id;
    };

    return {
      doc: INITIAL_DOC,
      issues: validate(INITIAL_DOC),
      selection: [],
      tool: 'select',
      // Replaced by a fit as soon as the editor knows how big its box is; a value is needed before
      // then so that the server and the first client render agree.
      camera: { pxPerMm: 0.05, xPx: 40, yPx: 40 },
      snapping: true,
      chain: null,
      pendingDelete: null,
      lengthPreview: null,
      viewport: { widthPx: 0, heightPx: 0 },
      notice: null,
      history: { past: [], future: [], open: null, depth: 0 },

      /* -- gestures ------------------------------------------------------------------------- */

      beginGesture(label) {
        set((state) => {
          if (state.history.depth === 0) state.history.open = { label, entries: [] };
          state.history.depth += 1;
        });
      },

      endGesture() {
        const history = get().history;
        if (history.depth === 0) return;
        if (history.depth > 1) {
          set((state) => {
            state.history.depth -= 1;
          });
          return;
        }

        // Stamped once per gesture rather than once per mutation: a drag would otherwise write a
        // timestamp sixty times a second, and every one of them would be a patch in the group.
        // Inside the group, so undo restores the old timestamp along with the geometry.
        if (history.open !== null && history.open.entries.length > 0) {
          const stamp = new Date().toISOString();
          mutate((doc) => {
            doc.updatedAt = stamp;
          });
        }

        set((state) => {
          const group = state.history.open;
          state.history.open = null;
          state.history.depth = 0;
          if (group === null || group.entries.length === 0) return;
          state.history.past.push(group);
          state.history.future.length = 0;
        });
      },

      /* -- document ------------------------------------------------------------------------- */

      drawTo(anchor) {
        set((state) => {
          state.notice = null;
        });

        const chain = get().chain;
        if (chain === null) {
          // The first tap of a chain commits nothing. It only records where the next segment starts.
          set((state) => {
            state.chain = { from: anchor };
          });
          return;
        }

        get().beginGesture('Draw wall');
        try {
          const from = resolveAnchor(chain.from);
          if (from === null) return;
          const to = resolveAnchor(anchor);
          if (to === null) {
            // The chain now hangs off whatever the first anchor resolved to, so an aborted second
            // tap does not throw away the corner the user already placed.
            set((state) => {
              state.chain = { from: { on: 'node', node: from } };
            });
            return;
          }

          if (from === to) {
            set((state) => {
              state.chain = { from: { on: 'node', node: to } };
            });
            return;
          }

          const level = currentLevel(get().doc);
          if (level.walls.some((w) => (w.a === from && w.b === to) || (w.a === to && w.b === from))) {
            set((state) => {
              state.notice = 'There is already a wall between those two corners.';
              state.chain = { from: { on: 'node', node: to } };
            });
            return;
          }

          const id = freshId(ID_PREFIX.wall, levelIds(level));
          mutate((doc) => {
            currentLevel(doc).walls.push({
              id,
              a: from,
              b: to,
              thicknessMm: NEW_WALL_THICKNESS_MM,
              heightMm: NEW_WALL_HEIGHT_MM,
              meta: { source: 'user', confidence: 1 },
            });
          });

          set((state) => {
            state.chain = { from: { on: 'node', node: to } };
            state.selection = [{ kind: 'wall', id }];
          });
        } finally {
          get().endGesture();
        }
      },

      endChain() {
        set((state) => {
          state.chain = null;
        });
      },

      moveNode(nodeId, to) {
        const x = Math.round(to.x);
        const y = Math.round(to.y);
        mutate((doc) => {
          const node = currentLevel(doc).nodes.find((n) => n.id === nodeId);
          if (node === undefined) return;
          if (node.x === x && node.y === y) return;
          node.x = x;
          node.y = y;
          // The user has now decided where this corner is, whatever the extractor thought. This is
          // the field that stops a later extraction run from clobbering the fix.
          node.meta.source = 'user';
          node.meta.confidence = 1;
        });
      },

      setWallLength(wallId, lengthMm, moving) {
        const outcome = planLengthChange(currentLevel(get().doc), wallId, lengthMm, moving);
        if (!outcome.ok) {
          set((state) => {
            state.notice =
              outcome.reason === 'not-positive'
                ? 'A wall has to be longer than nothing. Type a length in millimetres.'
                : `Wall ${wallId} cannot be measured, so its length cannot be set.`;
          });
          return;
        }

        get().beginGesture('Set wall length');
        try {
          get().moveNode(outcome.change.node, outcome.change.to);
        } finally {
          get().endGesture();
        }
      },

      deleteSelection() {
        const level = currentLevel(get().doc);
        const deletion = planDeletion(level, get().selection);
        if (isEmptyDeletion(deletion)) return;

        get().beginGesture('Delete');
        try {
          mutate((doc) => {
            const target = currentLevel(doc);
            const gone = {
              nodes: new Set(deletion.nodes),
              walls: new Set(deletion.walls),
              openings: new Set(deletion.openings),
              items: new Set(deletion.items),
              rooms: new Set(deletion.rooms),
            };
            // Spliced in place rather than reassigned: `arr = arr.filter(...)` makes one patch
            // carrying the whole array, so an undo entry for deleting one wall would hold a copy of
            // every wall in the flat.
            removeWhere(target.nodes, (n) => gone.nodes.has(n.id));
            removeWhere(target.walls, (w) => gone.walls.has(w.id));
            removeWhere(target.openings, (o) => gone.openings.has(o.id));
            removeWhere(target.items, (i) => gone.items.has(i.id));
            removeWhere(target.rooms, (r) => gone.rooms.has(r.id));
          });
          set((state) => {
            state.selection = [];
            state.pendingDelete = null;
            state.notice = `Removed ${describeDeletion(deletion)}.`;
          });
        } finally {
          get().endGesture();
        }
      },

      /**
       * Delete, but stop and ask first if it would take more than was selected.
       *
       * The threshold is deliberately "anything the user did not point at". Removing the wall you
       * tapped needs no ceremony; removing the wall you tapped, its door and two rooms does, because
       * the rooms are somewhere else on screen and their disappearance would otherwise look like a
       * bug rather than a consequence.
       */
      requestDelete() {
        const deletion = planDeletion(currentLevel(get().doc), get().selection);
        if (isEmptyDeletion(deletion)) {
          set((state) => {
            state.notice = 'Nothing is selected. Tap a corner or a wall first.';
          });
          return;
        }

        const extra =
          deletion.openings.length > 0 ||
          deletion.rooms.length > 0 ||
          deletion.items.length > 0 ||
          deletion.nodes.length + deletion.walls.length > get().selection.length;

        if (!extra) {
          get().deleteSelection();
          return;
        }
        set((state) => {
          state.pendingDelete = deletion;
          state.notice = null;
        });
      },

      confirmDelete() {
        if (get().pendingDelete === null) return;
        get().deleteSelection();
      },

      cancelDelete() {
        set((state) => {
          state.pendingDelete = null;
        });
      },

      /* -- editor --------------------------------------------------------------------------- */

      setTool(tool) {
        set((state) => {
          state.tool = tool;
          // Switching away mid-chain would leave a start point armed and invisible.
          state.chain = null;
          state.notice = null;
          state.pendingDelete = null;
        });
      },

      select(selection) {
        set((state) => {
          state.selection = selection;
          // A preview belongs to one wall's length field. Selecting something else abandons it.
          state.lengthPreview = null;
          state.pendingDelete = null;
        });
      },

      setSnapping(on) {
        set((state) => {
          state.snapping = on;
        });
      },

      setCamera(camera) {
        set((state) => {
          state.camera = camera;
        });
      },

      setViewport(widthPx, heightPx) {
        set((state) => {
          state.viewport = { widthPx, heightPx };
        });
      },

      fitToPlan() {
        const { viewport, doc } = get();
        if (viewport.widthPx === 0 || viewport.heightPx === 0) return;
        set((state) => {
          state.camera = fitCamera(
            planBounds(currentLevel(doc)),
            viewport.widthPx,
            viewport.heightPx,
            FIT_PADDING_PX,
          );
        });
      },

      setLengthPreview(preview) {
        set((state) => {
          state.lengthPreview = preview === null ? null : castDraft(preview);
        });
      },

      /**
       * Select what an issue names and bring it into view.
       *
       * Only corners and walls can be selected in this pass, but the CAMERA is aimed using every ref
       * the issue carries — an opening is centred by way of its wall, a room by way of its loop.
       * This is what `refs` being tagged with a collection kind is for: with a flat list of strings
       * there would be nothing to resolve against.
       */
      focus(refs) {
        const level = currentLevel(get().doc);
        const nodeById = indexNodes(level.nodes);
        const points: Point[] = [];
        const selection: Selected[] = [];

        const addWall = (wallId: string): void => {
          const wall = level.walls.find((w) => w.id === wallId);
          if (wall === undefined) return;
          const ends = wallEnds(nodeById, wall);
          if (ends === null) return;
          points.push({ x: ends.a.x, y: ends.a.y }, { x: ends.b.x, y: ends.b.y });
        };

        for (const ref of refs) {
          if (ref.kind === 'node') {
            const node = nodeById.get(ref.id);
            if (node === undefined) continue;
            selection.push({ kind: 'node', id: ref.id });
            points.push({ x: node.x, y: node.y });
          } else if (ref.kind === 'wall') {
            if (level.walls.some((w) => w.id === ref.id)) selection.push({ kind: 'wall', id: ref.id });
            addWall(ref.id);
          } else if (ref.kind === 'opening') {
            const opening = level.openings.find((o) => o.id === ref.id);
            if (opening !== undefined) addWall(opening.wall);
          } else if (ref.kind === 'room') {
            const room = level.rooms.find((r) => r.id === ref.id);
            for (const wallId of room?.wallLoop ?? []) addWall(wallId);
          }
        }

        set((state) => {
          state.selection = selection;
          const camera = centreOn(state.camera, state.viewport, points);
          if (camera !== null) state.camera = camera;
        });
      },

      setNotice(notice) {
        set((state) => {
          state.notice = notice;
        });
      },

      /* -- history -------------------------------------------------------------------------- */

      undo() {
        const { history, doc } = get();
        if (history.depth > 0 || history.past.length === 0) return; // Never mid-gesture.

        const group = history.past[history.past.length - 1];
        let next = doc;
        // Reverse entry order: the group's mutations happened in sequence, so their inverses have to
        // be unwound from the last one back. (Within a single mutation, immer's inverse patches are
        // already in an order that applies forwards.)
        for (let i = group.entries.length - 1; i >= 0; i -= 1) {
          next = applyPatches(next, group.entries[i].inverse);
        }

        set((state) => {
          state.doc = castDraft(next);
          state.issues = castDraft(validate(next));
          state.history.past.pop();
          state.history.future.push(group);
          state.chain = null;
          state.notice = null;
          state.pendingDelete = null;
          state.lengthPreview = null;
          prune(state);
        });
      },

      redo() {
        const { history, doc } = get();
        if (history.depth > 0 || history.future.length === 0) return;

        const group = history.future[history.future.length - 1];
        let next = doc;
        for (const entry of group.entries) next = applyPatches(next, entry.patches);

        set((state) => {
          state.doc = castDraft(next);
          state.issues = castDraft(validate(next));
          state.history.future.pop();
          state.history.past.push(group);
          state.chain = null;
          state.notice = null;
          state.pendingDelete = null;
          state.lengthPreview = null;
          prune(state);
        });
      },

      reset(doc) {
        set((state) => {
          state.doc = castDraft(doc);
          state.issues = castDraft(validate(doc));
          state.selection = [];
          state.chain = null;
          state.notice = null;
          state.pendingDelete = null;
          state.lengthPreview = null;
          // A new document invalidates every patch in the history: the paths still resolve, which is
          // worse than if they did not, because undo would then splice one flat's walls into another.
          state.history = { past: [], future: [], open: null, depth: 0 };
        });
      },
    };
  }),
);

/* ------------------------------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------------------------------- */

/** Air left around the plan when the view is fitted to it, in screen pixels. */
const FIT_PADDING_PX = 48;

/**
 * Bring `points` into view.
 *
 * The zoom is LEFT ALONE when what is being shown already fits comfortably, and only changed when
 * it does not. Re-zooming every time the user taps an issue would keep throwing away the scale they
 * had chosen to work at, which is more disorienting than a slightly awkward crop.
 */
function centreOn(
  camera: Camera,
  viewport: { widthPx: number; heightPx: number },
  points: readonly Point[],
): Camera | null {
  if (points.length === 0 || viewport.widthPx === 0 || viewport.heightPx === 0) return null;

  const bounds: PlanBounds = {
    minX: Math.min(...points.map((p) => p.x)),
    maxX: Math.max(...points.map((p) => p.x)),
    minY: Math.min(...points.map((p) => p.y)),
    maxY: Math.max(...points.map((p) => p.y)),
  };

  const fits =
    (bounds.maxX - bounds.minX) * camera.pxPerMm <= viewport.widthPx * 0.8 &&
    (bounds.maxY - bounds.minY) * camera.pxPerMm <= viewport.heightPx * 0.8;

  if (!fits) return fitCamera(bounds, viewport.widthPx, viewport.heightPx, FIT_PADDING_PX);

  return {
    pxPerMm: camera.pxPerMm,
    xPx: viewport.widthPx / 2 - ((bounds.minX + bounds.maxX) / 2) * camera.pxPerMm,
    yPx: viewport.heightPx / 2 - ((bounds.minY + bounds.maxY) / 2) * camera.pxPerMm,
  };
}

function removeWhere<T>(list: T[], doomed: (value: T) => boolean): void {
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (doomed(list[i])) list.splice(i, 1);
  }
}

/** Whichever end of `wallId` is nearer to `at`, for a tap that landed on a wall but at its corner. */
function nearestEndOf(level: Level, wallId: string, at: Point): string | null {
  const wall = level.walls.find((w) => w.id === wallId);
  if (wall === undefined) return null;
  const ends = wallEnds(indexNodes(level.nodes), wall);
  if (ends === null) return null;
  return distance(ends.a, at) <= distance(ends.b, at) ? ends.a.id : ends.b.id;
}

/* ------------------------------------------------------------------------------------------------
 * Selectors
 *
 * Small, and returning primitives or stable references, because zustand re-renders a component when
 * its selector's result changes by identity — a selector that builds a fresh object every call
 * re-renders on every store change, which for a drag is every pointer event.
 * ---------------------------------------------------------------------------------------------- */

/** Where the pending segment starts, in plan millimetres, or `null` if no chain is running. */
export function chainAnchorOf(level: Level, chain: DrawChain | null): Point | null {
  const from = chain?.from;
  if (from === undefined) return null;
  if (from.on !== 'node') return from.at;
  const node = level.nodes.find((n) => n.id === from.node);
  return node === undefined ? null : { x: node.x, y: node.y };
}

/** The same, for the pointer handlers, which read the store imperatively to avoid stale closures. */
export function chainAnchor(state: PlanState): Point | null {
  return chainAnchorOf(currentLevel(state.doc), state.chain);
}
