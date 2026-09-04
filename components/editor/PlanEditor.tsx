'use client';

/**
 * components/editor/PlanEditor.tsx — the 2D plan, drawn and driven.
 *
 * Plain SVG, no library. The document is a handful of shapes and the interaction is one pointer at a
 * time; a diagramming library would bring its own idea of what a node and an edge are, and this
 * document's shape — walls referencing shared corner IDs, everything in integer millimetres — is not
 * that idea. Wiring one up would cost more than it saves and would put a translation layer between
 * the user's drag and the document.
 *
 * ONE TRANSFORM. Everything geometric is drawn in plan millimetres inside a single
 * `translate(...) scale(...)` group, and pan and zoom only ever change those two numbers. Recomputing
 * every element's coordinates per frame would throw away the browser's own transform machinery and
 * put a rounding step between the document and what is on screen. Text is the exception: it lives in
 * a second, untransformed group, because scaled type is either microscopic or enormous.
 *
 * POINTER EVENTS, NOT MOUSE EVENTS, and every gesture works with one pointer. There is no hover-only
 * affordance and no right-click menu here, because on a phone neither exists.
 *
 * HIT TESTING IS DONE IN CODE, not by putting SVG event handlers on each shape. A 44px touch target
 * would otherwise mean an invisible fat shape behind every corner and every wall, stacked in an
 * order that decides what wins — and the order that puts corners above walls is exactly the priority
 * `snapPointer` already implements. One code path, not two that can disagree.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { wallFootprints } from '@/lib/geometry/walls';
import {
  nearestNode,
  nearestWall,
  neighbourPoints,
  snapPointer,
  type Snapped,
} from '@/lib/geometry/pick';
import type { Point } from '@/lib/geometry/plan-space';
import {
  chainAnchor,
  chainAnchorOf,
  currentLevel,
  toScreen,
  toPlan,
  usePlanStore,
  zoomAbout,
  type DrawAnchor,
} from '@/lib/plan/store';
import type { Level, Wall } from '@/lib/plan/schema';

/* ------------------------------------------------------------------------------------------------
 * Sizes, all in SCREEN pixels
 *
 * Constant under the user's hand at every zoom, which is the whole reason they are here and not in
 * millimetres. Each is converted to plan millimetres at the moment it is used, by dividing by the
 * current scale.
 * ---------------------------------------------------------------------------------------------- */

/** Half of a 44px touch target: the radius within which a tap counts as landing on something. */
const PICK_RADIUS_PX = 22;
/** Tighter than the pick radius: snapping should feel like precision, not like magnetism. */
const SNAP_RADIUS_PX = 14;
const NODE_RADIUS_PX = 4.5;
const NODE_SELECTED_RADIUS_PX = 7.5;
/** A pointer that moves further than this between down and up was a drag, not a tap. */
const TAP_SLOP_PX = 6;

/* --- Ink ---------------------------------------------------------------------------------------
 * A plan is read as a drawing on paper, so the drawing surface is paper-coloured in either theme.
 * Inverting a floor plan for dark mode makes it read as a photographic negative of itself.
 * ---------------------------------------------------------------------------------------------- */

const PAPER = '#f6f4f0';
const WALL_INK = '#33312d';
const WALL_DOUBTFUL = '#b5761b';
const HIGHLIGHT = '#1668c7';
const GUIDE = '#c2410c';

/** Below this, an automatically extracted element is shaded as something to go and look at. */
const DOUBTFUL_BELOW = 0.6;

export function PlanEditor(): React.JSX.Element {
  const doc = usePlanStore((state) => state.doc);
  const camera = usePlanStore((state) => state.camera);
  const selection = usePlanStore((state) => state.selection);
  const chain = usePlanStore((state) => state.chain);
  const lengthPreview = usePlanStore((state) => state.lengthPreview);
  // The active tool and the snapping toggle are deliberately NOT subscribed to here. Nothing this
  // component draws depends on them directly — the pending segment is drawn because a chain exists,
  // and the snap marks because the pointer resolved to something — and the handlers read them
  // imperatively from the store so they cannot act on a stale render's copy.

  const level = currentLevel(doc);
  const boxRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  /**
   * Where the pointer currently resolves to, for the drawing preview and the snap indicators.
   *
   * A snap the user cannot see is indistinguishable from a bug — the corner they were aiming at
   * simply moves, and nothing says why. So the corner being snapped to is ringed, the guide is
   * drawn, and the pending segment carries its length in millimetres.
   */
  const [hover, setHover] = useState<Snapped | null>(null);

  const footprints = useMemo(() => wallFootprints(level), [level]);
  const selectedNodes = useMemo(
    () => new Set(selection.filter((s) => s.kind === 'node').map((s) => s.id)),
    [selection],
  );
  const selectedWalls = useMemo(
    () => new Set(selection.filter((s) => s.kind === 'wall').map((s) => s.id)),
    [selection],
  );

  // Recomputed from the values this component is subscribed to, so it cannot go stale between
  // renders the way a `getState()` read during render would.
  const anchor = useMemo(() => chainAnchorOf(level, chain), [level, chain]);

  useViewportSize(boxRef);
  useWheelZoom(svgRef);
  useShortcuts();

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<Gesture>({ kind: 'none' });
  const pinch = useRef<PinchState | null>(null);

  /** Pointer position relative to the drawing surface, in CSS pixels. */
  const localPoint = (event: React.PointerEvent): { x: number; y: number } => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (rect === undefined) return { x: 0, y: 0 };
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  /**
   * What the pointer means, given the current tool and whether snapping is on.
   *
   * `dragging` is the corner currently under the finger, if any. It changes both halves of the
   * question: the corner squares up against its OWN neighbours rather than against a drawing chain
   * that does not exist, and it — with its walls — is excluded from the search, because a corner
   * that snaps to where it already is cannot be dragged anywhere.
   */
  const resolve = (at: Point, dragging?: string): Snapped => {
    const state = usePlanStore.getState();
    const level_ = currentLevel(state.doc);
    const anchors =
      dragging !== undefined
        ? neighbourPoints(level_, dragging)
        : ((point) => (point === null ? [] : [point]))(chainAnchor(state));

    return snapPointer(level_, at, anchors, {
      radiusMm: SNAP_RADIUS_PX / state.camera.pxPerMm,
      nodes: state.snapping,
      angle: state.snapping,
      walls: state.snapping,
      ignoreNodes: dragging === undefined ? undefined : new Set([dragging]),
    });
  };

  const onPointerDown = (event: React.PointerEvent<SVGSVGElement>): void => {
    const local = localPoint(event);
    pointers.current.set(event.pointerId, local);
    svgRef.current?.setPointerCapture(event.pointerId);

    if (pointers.current.size === 2) {
      // A second finger turns whatever was happening into a pinch. If a corner drag was open it has
      // to be closed, or its undo group stays open and swallows every later edit.
      if (gesture.current.kind === 'drag-node') usePlanStore.getState().endGesture();
      gesture.current = { kind: 'pinch' };
      pinch.current = readPinch(pointers.current);
      return;
    }
    if (pointers.current.size > 2) return;

    const state = usePlanStore.getState();
    const plan = toPlan(state.camera, local.x, local.y);

    if (state.tool === 'select') {
      const hit = nearestNode(currentLevel(state.doc).nodes, plan, PICK_RADIUS_PX / state.camera.pxPerMm);
      if (hit !== null) {
        state.select([{ kind: 'node', id: hit.node.id }]);
        state.beginGesture('Move corner');
        gesture.current = { kind: 'drag-node', node: hit.node.id };
        return;
      }
    }

    gesture.current = { kind: 'pan', from: local, downAt: local, moved: false };
  };

  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>): void => {
    const local = localPoint(event);
    const known = pointers.current.has(event.pointerId);
    if (known) pointers.current.set(event.pointerId, local);

    const state = usePlanStore.getState();
    const current = gesture.current;

    if (current.kind === 'pinch') {
      const now = readPinch(pointers.current);
      const before = pinch.current;
      if (now !== null && before !== null && before.distance > 0) {
        const zoomed = zoomAbout(state.camera, now.distance / before.distance, before.x, before.y);
        state.setCamera({
          pxPerMm: zoomed.pxPerMm,
          xPx: zoomed.xPx + (now.x - before.x),
          yPx: zoomed.yPx + (now.y - before.y),
        });
      }
      pinch.current = now;
      return;
    }

    if (current.kind === 'drag-node') {
      const snapped = resolve(toPlan(state.camera, local.x, local.y), current.node);
      setHover(snapped);
      state.moveNode(current.node, snapped.point);
      return;
    }

    if (current.kind === 'pan') {
      const travelled = Math.hypot(local.x - current.downAt.x, local.y - current.downAt.y);
      if (!current.moved && travelled < TAP_SLOP_PX) return;
      current.moved = true;
      state.setCamera({
        ...state.camera,
        xPx: state.camera.xPx + (local.x - current.from.x),
        yPx: state.camera.yPx + (local.y - current.from.y),
      });
      current.from = local;
      return;
    }

    // No gesture: a mouse moving over the plan. This is the live preview of the pending segment.
    if (state.tool === 'draw') setHover(resolve(toPlan(state.camera, local.x, local.y)));
  };

  const onPointerUp = (event: React.PointerEvent<SVGSVGElement>): void => {
    const local = localPoint(event);
    pointers.current.delete(event.pointerId);
    if (svgRef.current?.hasPointerCapture(event.pointerId) === true) {
      svgRef.current.releasePointerCapture(event.pointerId);
    }

    const current = gesture.current;
    gesture.current = { kind: 'none' };
    const state = usePlanStore.getState();

    if (current.kind === 'pinch') {
      pinch.current = pointers.current.size >= 2 ? readPinch(pointers.current) : null;
      return;
    }
    if (current.kind === 'drag-node') {
      state.endGesture();
      setHover(null);
      return;
    }
    if (current.kind === 'pan' && current.moved) return;
    if (current.kind === 'none') return;

    handleTap(toPlan(state.camera, local.x, local.y));
  };

  const onPointerCancel = (event: React.PointerEvent<SVGSVGElement>): void => {
    pointers.current.delete(event.pointerId);
    if (gesture.current.kind === 'drag-node') usePlanStore.getState().endGesture();
    gesture.current = { kind: 'none' };
    pinch.current = null;
  };

  const handleTap = (plan: Point): void => {
    const state = usePlanStore.getState();
    const level_ = currentLevel(state.doc);
    const pickMm = PICK_RADIUS_PX / state.camera.pxPerMm;

    if (state.tool === 'draw') {
      const snapped = resolve(plan);
      const target: DrawAnchor =
        snapped.node !== null
          ? { on: 'node', node: snapped.node.id }
          : snapped.wall !== null
            ? { on: 'wall', wall: snapped.wall.wall.id, at: snapped.point }
            : { on: 'empty', at: snapped.point };
      state.drawTo(target);
      setHover(snapped);
      return;
    }

    const node = nearestNode(level_.nodes, plan, pickMm);
    const wall = node === null ? nearestWall(level_, plan, pickMm) : null;
    const picked = node !== null
      ? [{ kind: 'node' as const, id: node.node.id }]
      : wall !== null
        ? [{ kind: 'wall' as const, id: wall.wall.id }]
        : [];

    state.select(picked);
    if (state.tool === 'delete' && picked.length > 0) state.requestDelete();
  };

  const scale = camera.pxPerMm;
  const guide = hover !== null && hover.guideFrom !== null ? guideLine(hover.guideFrom, hover) : null;

  return (
    <div ref={boxRef} className="relative h-full w-full overflow-hidden" style={{ background: PAPER }}>
      <svg
        ref={svgRef}
        className="absolute inset-0 h-full w-full touch-none select-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onPointerLeave={() => setHover(null)}
      >
        <g transform={`translate(${camera.xPx} ${camera.yPx}) scale(${scale})`}>
          {level.walls.map((wall) => (
            <WallShape
              key={wall.id}
              wall={wall}
              footprint={footprints.get(wall.id)}
              level={level}
              selected={selectedWalls.has(wall.id)}
            />
          ))}

          {guide !== null && (
            <line
              x1={guide.a.x}
              y1={guide.a.y}
              x2={guide.b.x}
              y2={guide.b.y}
              stroke={GUIDE}
              strokeWidth={1}
              strokeDasharray="6 6"
              vectorEffect="non-scaling-stroke"
            />
          )}

          {anchor !== null && hover !== null && (
            <line
              x1={anchor.x}
              y1={anchor.y}
              x2={hover.point.x}
              y2={hover.point.y}
              stroke={HIGHLIGHT}
              strokeWidth={2}
              strokeDasharray="8 5"
              vectorEffect="non-scaling-stroke"
            />
          )}

          {lengthPreview !== null && (
            <line
              x1={lengthPreview.from.x}
              y1={lengthPreview.from.y}
              x2={lengthPreview.to.x}
              y2={lengthPreview.to.y}
              stroke={GUIDE}
              strokeWidth={2}
              strokeDasharray="4 4"
              vectorEffect="non-scaling-stroke"
            />
          )}
          {lengthPreview !== null && (
            <circle
              cx={lengthPreview.to.x}
              cy={lengthPreview.to.y}
              r={NODE_SELECTED_RADIUS_PX / scale}
              fill="none"
              stroke={GUIDE}
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
            />
          )}

          {level.nodes.map((node) => {
            const selected = selectedNodes.has(node.id);
            const doubtful = node.meta.source === 'auto' && node.meta.confidence < DOUBTFUL_BELOW;
            return (
              <circle
                key={node.id}
                cx={node.x}
                cy={node.y}
                r={(selected ? NODE_SELECTED_RADIUS_PX : NODE_RADIUS_PX) / scale}
                fill={selected ? HIGHLIGHT : '#ffffff'}
                stroke={doubtful ? WALL_DOUBTFUL : WALL_INK}
                strokeWidth={selected ? 2 : 1.25}
                vectorEffect="non-scaling-stroke"
              />
            );
          })}

          {hover?.node != null && (
            <circle
              cx={hover.node.x}
              cy={hover.node.y}
              r={(NODE_SELECTED_RADIUS_PX + 4) / scale}
              fill="none"
              stroke={GUIDE}
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
            />
          )}
          {hover?.wall != null && hover.node === null && (
            <circle
              cx={hover.point.x}
              cy={hover.point.y}
              r={(NODE_RADIUS_PX + 3) / scale}
              fill="none"
              stroke={GUIDE}
              strokeWidth={2}
              strokeDasharray="3 3"
              vectorEffect="non-scaling-stroke"
            />
          )}
        </g>

        {/* Untransformed, so type stays type. */}
        <g>
          {anchor !== null && hover !== null && (
            <PendingLength camera={camera} from={anchor} to={hover.point} />
          )}
        </g>
      </svg>

      <ScaleBar pxPerMm={scale} />
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------
 * Pieces
 * ---------------------------------------------------------------------------------------------- */

/**
 * One wall, at its real thickness.
 *
 * The outline comes from `wallFootprints`, the same mitred polygons the 3D shell is extruded from,
 * so the two views cannot disagree about where a wall stops. A wall whose corners are missing has no
 * footprint at all — `validate` reports that as an error — and is drawn as a thin dashed line so the
 * user can still see and select the thing they need to repair.
 *
 * Elements the extractor produced and was unsure about are shaded differently. Nothing produces them
 * yet; wiring it now costs nothing and is how a user will know where to look after an extraction run.
 */
function WallShape({
  wall,
  footprint,
  level,
  selected,
}: {
  wall: Wall;
  footprint: Point[] | undefined;
  level: Level;
  selected: boolean;
}): React.JSX.Element | null {
  const doubtful = wall.meta.source === 'auto' && wall.meta.confidence < DOUBTFUL_BELOW;
  const fill = doubtful ? WALL_DOUBTFUL : WALL_INK;

  if (footprint === undefined) {
    const a = level.nodes.find((n) => n.id === wall.a);
    const b = level.nodes.find((n) => n.id === wall.b);
    if (a === undefined || b === undefined) return null;
    return (
      <line
        x1={a.x}
        y1={a.y}
        x2={b.x}
        y2={b.y}
        stroke={selected ? HIGHLIGHT : fill}
        strokeWidth={2}
        strokeDasharray="6 4"
        vectorEffect="non-scaling-stroke"
      />
    );
  }

  return (
    <polygon
      points={footprint.map((p) => `${p.x},${p.y}`).join(' ')}
      fill={selected ? HIGHLIGHT : fill}
      fillOpacity={doubtful ? 0.55 : 0.9}
      stroke={selected ? HIGHLIGHT : 'none'}
      strokeWidth={selected ? 3 : 0}
      vectorEffect="non-scaling-stroke"
    />
  );
}

/** The pending segment's length, in millimetres, beside its midpoint. */
function PendingLength({
  camera,
  from,
  to,
}: {
  camera: { pxPerMm: number; xPx: number; yPx: number };
  from: Point;
  to: Point;
}): React.JSX.Element | null {
  const lengthMm = Math.round(Math.hypot(to.x - from.x, to.y - from.y));
  if (lengthMm === 0) return null;
  const mid = toScreen(camera, { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 });

  return (
    <g transform={`translate(${mid.x} ${mid.y})`}>
      <rect x={-34} y={-26} width={68} height={20} rx={4} fill="#ffffff" fillOpacity={0.92} />
      <text x={0} y={-12} textAnchor="middle" fontSize={12} fontFamily="ui-monospace, monospace" fill={WALL_INK}>
        {lengthMm} mm
      </text>
    </g>
  );
}

/**
 * A bar of a round real length.
 *
 * Without one the drawing has no sense of size at all: a 3-metre room and a 30-metre warehouse look
 * identical on screen if nothing says which is which.
 */
function ScaleBar({ pxPerMm }: { pxPerMm: number }): React.JSX.Element {
  const target = 120 / pxPerMm;
  const magnitude = 10 ** Math.floor(Math.log10(target));
  const step = [1, 2, 5, 10].find((k) => k * magnitude >= target * 0.6) ?? 10;
  const lengthMm = step * magnitude;
  const widthPx = lengthMm * pxPerMm;

  return (
    <div className="pointer-events-none absolute bottom-3 left-3 flex items-end gap-2">
      <div className="border-b-2 border-l-2 border-r-2" style={{ width: widthPx, height: 8, borderColor: WALL_INK }} />
      <span className="font-mono text-[11px] leading-none" style={{ color: WALL_INK }}>
        {lengthMm >= 1000 ? `${lengthMm / 1000} m` : `${lengthMm} mm`}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------
 * Gestures
 * ---------------------------------------------------------------------------------------------- */

type Gesture =
  | { kind: 'none' }
  | { kind: 'pan'; from: { x: number; y: number }; downAt: { x: number; y: number }; moved: boolean }
  | { kind: 'drag-node'; node: string }
  | { kind: 'pinch' };

interface PinchState {
  x: number;
  y: number;
  distance: number;
}

function readPinch(pointers: ReadonlyMap<number, { x: number; y: number }>): PinchState | null {
  const [a, b] = [...pointers.values()];
  if (a === undefined || b === undefined) return null;
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, distance: Math.hypot(a.x - b.x, a.y - b.y) };
}

/** The 90 degree guide, drawn well past the pointer so it reads as a line rather than a segment. */
function guideLine(anchor: Point, hover: Snapped): { a: Point; b: Point } {
  const reach = Math.max(2000, Math.hypot(hover.point.x - anchor.x, hover.point.y - anchor.y) * 1.35);

  return hover.axis === 'horizontal'
    ? { a: { x: anchor.x - reach, y: anchor.y }, b: { x: anchor.x + reach, y: anchor.y } }
    : { a: { x: anchor.x, y: anchor.y - reach }, b: { x: anchor.x, y: anchor.y + reach } };
}

/* ------------------------------------------------------------------------------------------------
 * Wiring
 * ---------------------------------------------------------------------------------------------- */

/** Measure the surface, and frame the plan the first time we learn how big it is. */
function useViewportSize(ref: React.RefObject<HTMLDivElement | null>): void {
  const fitted = useRef(false);

  useEffect(() => {
    const box = ref.current;
    if (box === null) return;

    const observer = new ResizeObserver(() => {
      const { width, height } = box.getBoundingClientRect();
      if (width === 0 || height === 0) return;
      usePlanStore.getState().setViewport(width, height);
      // Once, on the first measurement. Re-framing under someone who has panned somewhere to work is
      // worse than a slightly awkward first crop.
      if (fitted.current) return;
      fitted.current = true;
      usePlanStore.getState().fitToPlan();
    });

    observer.observe(box);
    return () => observer.disconnect();
  }, [ref]);
}

/**
 * Wheel zoom, about the pointer.
 *
 * Registered by hand rather than as an `onWheel` prop so it can be non-passive: React attaches wheel
 * listeners passively, and a passive listener cannot call `preventDefault`, so the page would scroll
 * underneath the plan while the plan zoomed.
 */
function useWheelZoom(ref: React.RefObject<SVGSVGElement | null>): void {
  useEffect(() => {
    const svg = ref.current;
    if (svg === null) return;

    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const rect = svg.getBoundingClientRect();
      const state = usePlanStore.getState();
      // Exponential, so a notch of wheel is the same proportional change at every zoom level.
      const factor = Math.exp(-event.deltaY * 0.0015);
      state.setCamera(zoomAbout(state.camera, factor, event.clientX - rect.left, event.clientY - rect.top));
    };

    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [ref]);
}

/**
 * Desktop shortcuts.
 *
 * Every one of these has a visible control in the toolbar as well — the platform rule for this
 * editor is that a keyboard may not exist. These are an accelerator, never the only way in.
 */
function useShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target;
      // Never steal a key from a field the user is typing a length into.
      if (target instanceof HTMLElement && (target.tagName === 'INPUT' || target.isContentEditable)) return;
      const state = usePlanStore.getState();

      if (event.key === 'Escape') {
        state.endChain();
        state.cancelDelete();
        return;
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        state.requestDelete();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) state.redo();
        else state.undo();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
