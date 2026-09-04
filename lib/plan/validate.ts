/**
 * lib/plan/validate.ts — does this document make sense?
 *
 * `PlanDocSchema` checks SHAPE: the right fields, the right kinds of value, integer millimetres.
 * This checks SENSE: the questions you can only answer with the whole document in hand at once.
 * Does this wall's node exist? Does this room's outline close? Does this door fit in its wall?
 *
 * Nothing downstream should have to ask those. The 2D editor runs this continuously and shades the
 * problems; the 3D shell refuses to build while any `error` is present; the eval harness counts the
 * issues an extraction run leaves behind.
 *
 * A broken document is a NORMAL input here — it is what extraction produces and what the editor
 * exists to repair — so this reports and never throws, and never mutates. Throwing would make a
 * repairable plan unopenable, which is precisely backwards.
 *
 * Pure. No I/O, no React, no three.js.
 */

import type { Item, Level, Opening, PlanDoc, PlanNode, Room, Wall } from './schema';

/* ------------------------------------------------------------------------------------------------
 * Issue
 * ---------------------------------------------------------------------------------------------- */

export type Severity =
  /**
   * Cannot be rendered in 3D or reasoned about — a broken reference, impossible geometry — or is
   * certainly wrong however it renders, with no document in which it would be correct.
   */
  | 'error'
  /** Renderable, but probably not what the user meant: two corners 3mm apart, a room with no door. */
  | 'warning';

/**
 * Which collection a referenced ID lives in.
 *
 * `refs` is a tagged structure rather than a flat `Id[]` for two reasons. First, the editor has to
 * highlight the thing, and to do that it must know which array to look in — with a bare string it
 * would have to search all five collections. Second, and decisively, one of the checks below is
 * *"this ID is used by both a node and a room"*; a flat list of strings cannot express which
 * elements are involved in exactly the case where knowing matters most.
 */
export type RefKind = 'doc' | 'level' | 'node' | 'wall' | 'opening' | 'room' | 'item';

export interface IssueRef {
  kind: RefKind;
  id: string;
}

/**
 * Stable machine-readable codes. The UI matches on these and so do the tests, which leaves the
 * message text free to be improved without breaking either. Adding a code is a normal change;
 * renaming one is a breaking change.
 */
export type IssueCode =
  // Identity
  | 'DUPLICATE_ID'
  | 'DUPLICATE_LEVEL_ID'
  // Reference integrity
  | 'WALL_ORPHAN_NODE'
  | 'OPENING_ORPHAN_WALL'
  | 'ROOM_ORPHAN_WALL'
  | 'ITEM_ORPHAN_ANCHOR'
  | 'ITEM_ANCHOR_CYCLE'
  // Walls
  | 'WALL_ZERO_LENGTH'
  | 'WALL_TOO_SHORT'
  | 'NODES_NEARLY_COINCIDENT'
  | 'NODE_UNREFERENCED'
  // Openings
  | 'OPENING_WIDER_THAN_WALL'
  | 'OPENING_PAST_WALL_END'
  | 'OPENING_TALLER_THAN_WALL'
  | 'OPENING_OVERLAP'
  | 'OPENING_NO_LEAF_ON_EXTERNAL_WALL'
  // Rooms
  | 'ROOM_LOOP_BROKEN'
  | 'ROOM_LOOP_REPEATED_WALL'
  | 'ROOM_NO_DOOR'
  | 'ROOM_NAME_DUPLICATE'
  // Items
  | 'ITEM_ANCHOR_PAST_WALL_END'
  // Document
  | 'SCALE_UNCONFIRMED';

export interface Issue {
  severity: Severity;
  code: IssueCode;
  /** Plain language, for a homeowner, always naming the real numbers. Never "does not fit". */
  message: string;
  refs: IssueRef[];
  /** The level the issue was found on, or `null` for a document-level issue such as the scale gate. */
  levelId: string | null;
}

/* ------------------------------------------------------------------------------------------------
 * Tolerances
 *
 * These are NOT epsilons. Millimetres are integers, so every comparison in this file is exact and
 * no float slop exists to absorb. These two numbers are judgements about real distances: below them
 * a human almost certainly did not mean what the document says. Change them because a plan proved
 * them wrong, not because a comparison misbehaved.
 * ---------------------------------------------------------------------------------------------- */

/** Under this, a wall is more likely an extraction artifact than a real piece of building. */
const MIN_SENSIBLE_WALL_LENGTH_MM = 100;

/**
 * Two corners closer than this are one corner that failed to merge. It shows as a hairline gap in 3D.
 *
 * Exported, unlike its neighbour, because the 2D editor warns about this case BEFORE committing an
 * edit that would cause it. Two copies of the number would be two definitions of the same rule
 * waiting to disagree, and the disagreement would be silent: the preview would promise one thing and
 * the issue panel report another.
 */
export const NODE_MERGE_TOLERANCE_MM = 5;

/* ------------------------------------------------------------------------------------------------
 * Local geometry helpers
 *
 * One distance calculation, kept local on purpose: `lib/geometry` is a later task and importing a
 * module that does not exist yet to save four lines is a bad trade.
 *
 * Everything that DECIDES compares squared distances, which for integer millimetre coordinates is
 * exact integer arithmetic — no square root, no rounding, no epsilon. Only the numbers printed in
 * messages take a square root, and those are rounded to the nearest millimetre because "2795.084mm"
 * helps nobody.
 * ---------------------------------------------------------------------------------------------- */

function distanceSq(p: PlanNode, q: PlanNode): number {
  const dx = p.x - q.x;
  const dy = p.y - q.y;
  return dx * dx + dy * dy;
}

/** Rounded to the nearest mm. For display only — never compare against this. */
function distanceMm(p: PlanNode, q: PlanNode): number {
  return Math.round(Math.sqrt(distanceSq(p, q)));
}

/** Exact: is `valueMm` longer than the wall whose squared length is `lengthSq`? */
function exceedsLength(valueMm: number, lengthSq: number): boolean {
  return valueMm > 0 && valueMm * valueMm > lengthSq;
}

function issue(
  severity: Severity,
  code: IssueCode,
  levelId: string | null,
  refs: IssueRef[],
  message: string,
): Issue {
  return { severity, code, message, refs, levelId };
}

/** "2 nodes and 1 room" — used when one ID has been claimed by several elements. */
function listCollections(counts: Map<RefKind, number>): string {
  const parts = [...counts.entries()].map(([kind, n]) => `${n} ${n === 1 ? kind : `${kind}s`}`);
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/* ------------------------------------------------------------------------------------------------
 * Entry point
 * ---------------------------------------------------------------------------------------------- */

/**
 * Report everything wrong with `doc`. `[]` means clean.
 *
 * Never stops at the first problem: someone fixing ten things wants to see ten things. The ORDER is
 * deliberate — identity, then reference integrity, then geometry — because a broken reference makes
 * every later statement about that element noise. An opening whose wall does not exist is reported
 * once, as a broken reference, and is not then also accused of not fitting a wall we cannot measure.
 */
export function validate(doc: PlanDoc): Issue[] {
  const issues: Issue[] = [];

  issues.push(...checkLevelIdentity(doc));
  for (const level of doc.levels) issues.push(...validateLevel(level));
  issues.push(...checkScale(doc));

  return issues;
}

/**
 * Two levels sharing an ID makes "which floor is this?" unanswerable, and every level lookup picks
 * one of them arbitrarily. Not in the original spec for this file; see the reply that shipped it.
 */
function checkLevelIdentity(doc: PlanDoc): Issue[] {
  const issues: Issue[] = [];
  const counts = new Map<string, number>();
  for (const level of doc.levels) counts.set(level.id, (counts.get(level.id) ?? 0) + 1);

  for (const [id, n] of counts) {
    if (n < 2) continue;
    issues.push(
      issue('error', 'DUPLICATE_LEVEL_ID', null, [{ kind: 'level', id }], `${n} levels in this plan share the id "${id}". Level ids must be unique, or nothing can say which floor it is on.`),
    );
  }
  return issues;
}

/**
 * The scale gate, restated as an issue so the 3D shell has exactly one thing to check.
 *
 * A warning, not an error: editing a plan before confirming the scale is a normal, expected state —
 * it is where every uploaded plan starts. What must not happen is REACHING 3D like this, and that
 * is a rule about the 3D entry point, not about the document being wrong.
 */
function checkScale(doc: PlanDoc): Issue[] {
  if (doc.scale.status === 'confirmed') return [];
  return [
    issue('warning', 'SCALE_UNCONFIRMED', null, [{ kind: 'doc', id: doc.id }], `The scale of this plan has not been confirmed, so no dimension in it is known to be real yet. Confirm it by clicking the two ends of one wall whose length you know.`),
  ];
}

/* ------------------------------------------------------------------------------------------------
 * Per level
 * ---------------------------------------------------------------------------------------------- */

function validateLevel(level: Level): Issue[] {
  const nodeById = new Map(level.nodes.map((n) => [n.id, n]));
  const wallById = new Map(level.walls.map((w) => [w.id, w]));
  const roomById = new Map(level.rooms.map((r) => [r.id, r]));
  const itemById = new Map(level.items.map((i) => [i.id, i]));

  const identity = checkIdentity(level);

  /**
   * Walls whose endpoints cannot be resolved, and walls with no length. Both make every downstream
   * measurement of that wall meaningless, so openings and items on them skip their fit checks —
   * otherwise one missing node produces a page of consequential nonsense.
   */
  const unmeasurable = new Set<string>();

  /**
   * Which rooms each wall bounds. A wall named by two room loops is internal; a wall named by
   * exactly one has outdoors on its other side. The document has no `external` flag, and deriving
   * it from the room graph is better than adding one — a flag would be a second source of truth
   * that goes stale the moment a room is redrawn.
   */
  const roomsByWall = new Map<string, Room[]>();
  for (const r of level.rooms) {
    for (const wallId of new Set(r.wallLoop)) {
      const list = roomsByWall.get(wallId) ?? [];
      list.push(r);
      roomsByWall.set(wallId, list);
    }
  }

  const references = checkReferences(level, { nodeById, wallById, roomById, itemById }, unmeasurable);
  const walls = checkWalls(level, nodeById, unmeasurable);
  const openings = checkOpenings(level, nodeById, wallById, roomsByWall, unmeasurable);
  const rooms = checkRooms(level, wallById);
  const items = checkItems(level, nodeById, wallById, unmeasurable);

  return [...identity, ...references, ...walls, ...openings, ...rooms, ...items];
}

/* --- Identity -----------------------------------------------------------------------------------
 * If two walls are both called `w3`, every lookup by ID is a coin flip — and every map built from
 * these arrays, here and everywhere else, silently keeps whichever one came last. Undo, chat ("move
 * w3 left"), and highlighting all break in ways that look random.
 * ---------------------------------------------------------------------------------------------- */

function checkIdentity(level: Level): Issue[] {
  const claims = new Map<string, Map<RefKind, number>>();
  const claim = (id: string, kind: RefKind): void => {
    const byKind = claims.get(id) ?? new Map<RefKind, number>();
    byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
    claims.set(id, byKind);
  };

  for (const n of level.nodes) claim(n.id, 'node');
  for (const w of level.walls) claim(w.id, 'wall');
  for (const o of level.openings) claim(o.id, 'opening');
  for (const r of level.rooms) claim(r.id, 'room');
  for (const i of level.items) claim(i.id, 'item');

  const issues: Issue[] = [];
  for (const [id, byKind] of claims) {
    const total = [...byKind.values()].reduce((sum, n) => sum + n, 0);
    if (total < 2) continue;
    const refs: IssueRef[] = [...byKind.keys()].map((kind) => ({ kind, id }));
    issues.push(
      issue('error', 'DUPLICATE_ID', level.id, refs, `The id "${id}" is used by ${listCollections(byKind)} on level "${level.name}". Ids must be unique within a level, otherwise every reference to "${id}" is ambiguous.`),
    );
  }
  return issues;
}

/* --- Reference integrity ------------------------------------------------------------------------
 * Every one of these is an error, because the element genuinely cannot be placed: a wall with no
 * endpoints has no location, an opening with no wall has no host, an item anchored to nothing has
 * no derivable transform. The 3D shell would either crash or quietly skip the element, and quietly
 * skipping is worse — the user sees a missing wall and no reason for it.
 * ---------------------------------------------------------------------------------------------- */

interface LevelIndex {
  nodeById: Map<string, PlanNode>;
  wallById: Map<string, Wall>;
  roomById: Map<string, Room>;
  itemById: Map<string, Item>;
}

function checkReferences(level: Level, index: LevelIndex, unmeasurable: Set<string>): Issue[] {
  const issues: Issue[] = [];

  for (const wall of level.walls) {
    const missing = [wall.a, wall.b].filter((id) => !index.nodeById.has(id));
    if (missing.length === 0) continue;
    unmeasurable.add(wall.id);
    issues.push(
      issue('error', 'WALL_ORPHAN_NODE', level.id, [{ kind: 'wall', id: wall.id }, ...missing.map((id): IssueRef => ({ kind: 'node', id }))], `Wall ${wall.id} is pinned to ${missing.length === 1 ? 'a corner' : 'corners'} ${missing.map((id) => `"${id}"`).join(' and ')}, which ${missing.length === 1 ? 'does' : 'do'} not exist on level "${level.name}", so the wall has no position.`),
    );
  }

  for (const opening of level.openings) {
    if (index.wallById.has(opening.wall)) continue;
    issues.push(
      issue('error', 'OPENING_ORPHAN_WALL', level.id, [{ kind: 'opening', id: opening.id }, { kind: 'wall', id: opening.wall }], `The ${opening.kind} ${opening.id} is in wall "${opening.wall}", which does not exist on level "${level.name}".`),
    );
  }

  for (const room of level.rooms) {
    const missing = room.wallLoop.filter((id) => !index.wallById.has(id));
    if (missing.length === 0) continue;
    issues.push(
      issue('error', 'ROOM_ORPHAN_WALL', level.id, [{ kind: 'room', id: room.id }, ...missing.map((id): IssueRef => ({ kind: 'wall', id }))], `Room "${room.name}" (${room.id}) is bounded by ${missing.length === 1 ? 'wall' : 'walls'} ${missing.map((id) => `"${id}"`).join(', ')}, which ${missing.length === 1 ? 'does' : 'do'} not exist on level "${level.name}", so its outline cannot be traced.`),
    );
  }

  for (const item of level.items) {
    const anchor = item.anchor;
    const target =
      anchor.on === 'wall'
        ? { kind: 'wall' as const, id: anchor.wall, exists: index.wallById.has(anchor.wall), noun: 'wall' }
        : anchor.on === 'item'
          ? { kind: 'item' as const, id: anchor.item, exists: index.itemById.has(anchor.item), noun: 'item' }
          : { kind: 'room' as const, id: anchor.room, exists: index.roomById.has(anchor.room), noun: 'room' };
    if (target.exists) continue;
    issues.push(
      issue('error', 'ITEM_ORPHAN_ANCHOR', level.id, [{ kind: 'item', id: item.id }, { kind: target.kind, id: target.id }], `${describeItem(item)} is placed against ${target.noun} "${target.id}", which does not exist on level "${level.name}", so it has nowhere to be.`),
    );
  }

  issues.push(...checkAnchorCycles(level, index.itemById));
  return issues;
}

/**
 * `i1` anchored to `i2` anchored to `i1`.
 *
 * Deriving a world transform walks the anchor chain, so a cycle of any length is an infinite
 * recursion in the renderer, the solver and the screenshot pass alike — and it is easy to create by
 * accident with two "put the lamp next to the sofa" style edits.
 *
 * Each item has at most ONE anchor, so this graph is a chain per item, not a tree: following the
 * chain until it repeats or ends is enough, and each item is walked once. The cycle is reported
 * once, on the whole loop, rather than once per member.
 */
function checkAnchorCycles(level: Level, itemById: Map<string, Item>): Issue[] {
  const issues: Issue[] = [];
  const settled = new Set<string>();

  for (const start of level.items) {
    if (settled.has(start.id)) continue;

    const path: string[] = [];
    const indexOnPath = new Map<string, number>();
    let cursor: string | undefined = start.id;

    while (cursor !== undefined && !settled.has(cursor)) {
      const seenAt = indexOnPath.get(cursor);
      if (seenAt !== undefined) {
        const cycle = path.slice(seenAt);
        issues.push(
          issue('error', 'ITEM_ANCHOR_CYCLE', level.id, cycle.map((id): IssueRef => ({ kind: 'item', id })), cycle.length === 1 ? `Item ${cycle[0]} is anchored to itself, so it has no position.` : `Items ${cycle.join(', ')} are anchored to each other in a loop (${[...cycle, cycle[0]].join(' → ')}), so none of them has a position.`),
        );
        break;
      }
      indexOnPath.set(cursor, path.length);
      path.push(cursor);

      const item = itemById.get(cursor);
      // A dangling anchor target was already reported as ITEM_ORPHAN_ANCHOR; the chain just ends.
      cursor = item !== undefined && item.anchor.on === 'item' ? item.anchor.item : undefined;
    }

    for (const id of path) settled.add(id);
  }

  return issues;
}

/* --- Walls --------------------------------------------------------------------------------------
 * A wall with no length has no direction, and direction is what "left side", "offset along it" and
 * the mitre at each end are all defined in terms of. Everything about such a wall — which way a door
 * swings, which side a wardrobe stands on — is undefined rather than merely wrong.
 * ---------------------------------------------------------------------------------------------- */

function checkWalls(level: Level, nodeById: Map<string, PlanNode>, unmeasurable: Set<string>): Issue[] {
  const issues: Issue[] = [];

  for (const wall of level.walls) {
    if (unmeasurable.has(wall.id)) continue; // Endpoints missing; already reported.

    if (wall.a === wall.b) {
      unmeasurable.add(wall.id);
      issues.push(
        issue('error', 'WALL_ZERO_LENGTH', level.id, [{ kind: 'wall', id: wall.id }, { kind: 'node', id: wall.a }], `Wall ${wall.id} starts and ends at the same corner (${wall.a}), so it has no length or direction and cannot be built.`),
      );
      continue;
    }

    const a = nodeById.get(wall.a);
    const b = nodeById.get(wall.b);
    if (a === undefined || b === undefined) continue; // Unreachable: guarded by `unmeasurable`.

    const lengthSq = distanceSq(a, b);
    if (lengthSq === 0) {
      unmeasurable.add(wall.id);
      issues.push(
        issue('error', 'WALL_ZERO_LENGTH', level.id, [{ kind: 'wall', id: wall.id }, { kind: 'node', id: a.id }, { kind: 'node', id: b.id }], `Wall ${wall.id} runs between two different corners (${a.id} and ${b.id}) that sit at the same point (${a.x}, ${a.y}), so it has no length or direction.`),
      );
      continue;
    }

    if (lengthSq < MIN_SENSIBLE_WALL_LENGTH_MM * MIN_SENSIBLE_WALL_LENGTH_MM) {
      issues.push(
        issue('warning', 'WALL_TOO_SHORT', level.id, [{ kind: 'wall', id: wall.id }], `Wall ${wall.id} is only ${distanceMm(a, b)}mm long, shorter than ${MIN_SENSIBLE_WALL_LENGTH_MM}mm. That is usually a leftover from reading the plan image rather than a real wall.`),
      );
    }
  }

  issues.push(...checkNodeProximity(level));
  issues.push(...checkUnreferencedNodes(level));
  return issues;
}

/**
 * Two corners a few millimetres apart are one corner that failed to merge. Left alone they produce
 * the hairline gap at a junction that is the signature bug of hand-rolled floor planners, and no
 * amount of mitring fixes it because the two walls genuinely do not meet.
 *
 * O(n^2) over the level's corners, deliberately: a flat has tens to low hundreds of them, and a
 * spatial index (rbush, already a dependency for the solver's broad phase) is the answer if a plan
 * ever appears where this is measurable. It is not worth the indirection before then.
 */
function checkNodeProximity(level: Level): Issue[] {
  const issues: Issue[] = [];
  const toleranceSq = NODE_MERGE_TOLERANCE_MM * NODE_MERGE_TOLERANCE_MM;

  for (let i = 0; i < level.nodes.length; i += 1) {
    for (let j = i + 1; j < level.nodes.length; j += 1) {
      const a = level.nodes[i];
      const b = level.nodes[j];
      const d = distanceSq(a, b);
      if (d === 0 || d >= toleranceSq) continue;
      issues.push(
        issue('warning', 'NODES_NEARLY_COINCIDENT', level.id, [{ kind: 'node', id: a.id }, { kind: 'node', id: b.id }], `Corners ${a.id} (${a.x}, ${a.y}) and ${b.id} (${b.x}, ${b.y}) are ${distanceMm(a, b)}mm apart, closer than ${NODE_MERGE_TOLERANCE_MM}mm. That is almost certainly one corner drawn twice, and it will show as a hairline gap in 3D.`),
      );
    }
  }
  return issues;
}

/** Added beyond the spec: see the reply. Litter from editing; a handle in the 2D plan attached to nothing. */
function checkUnreferencedNodes(level: Level): Issue[] {
  const used = new Set<string>();
  for (const wall of level.walls) {
    used.add(wall.a);
    used.add(wall.b);
  }
  return level.nodes
    .filter((node) => !used.has(node.id))
    .map((node) =>
      issue('warning', 'NODE_UNREFERENCED', level.id, [{ kind: 'node', id: node.id }], `Corner ${node.id} (${node.x}, ${node.y}) is not used by any wall. It is harmless, but it is a draggable point in the plan that does nothing.`),
    );
}

/* --- Openings -----------------------------------------------------------------------------------
 * Walls are built in PIECES around their openings, never by subtracting a hole. A piece of wall
 * whose length works out negative — because the door runs off the end, or two doors overlap — is
 * not a rendering glitch; it is geometry the extruder cannot produce at all.
 * ---------------------------------------------------------------------------------------------- */

function checkOpenings(level: Level, nodeById: Map<string, PlanNode>, wallById: Map<string, Wall>, roomsByWall: Map<string, Room[]>, unmeasurable: Set<string>): Issue[] {
  const issues: Issue[] = [];
  const byWall = new Map<string, Opening[]>();

  for (const opening of level.openings) {
    const wall = wallById.get(opening.wall);
    if (wall === undefined) continue; // OPENING_ORPHAN_WALL already reported.

    const list = byWall.get(wall.id) ?? [];
    list.push(opening);
    byWall.set(wall.id, list);

    // Height is independent of wall length, so it is still worth checking on an unmeasurable wall.
    const topMm = opening.sillMm + opening.heightMm;
    if (topMm > wall.heightMm) {
      issues.push(
        issue('error', 'OPENING_TALLER_THAN_WALL', level.id, [{ kind: 'opening', id: opening.id }, { kind: 'wall', id: wall.id }], `The ${opening.kind} ${opening.id} reaches ${topMm}mm above the floor (${opening.sillMm}mm sill plus ${opening.heightMm}mm of ${opening.kind}), but wall ${wall.id} is only ${wall.heightMm}mm tall.`),
      );
    }

    // A doorway with no leaf, in a wall with outdoors on its other side, is a hole in the building.
    // There is no flat in which that is deliberate, which is why this is an error rather than a
    // warning: every warning above has a legitimate case, and this one has none.
    //
    // Only flagged when the wall bounds EXACTLY one room. A wall in no room loop at all is a wall
    // whose surroundings are not described yet — which is every wall in a half-drawn plan — and
    // guessing "external" there would make the editor shout at a user who has simply not finished.
    const bounding = roomsByWall.get(wall.id) ?? [];
    if (opening.kind === 'door' && opening.leaf === 'none' && bounding.length === 1) {
      const room = bounding[0];
      issues.push(
        issue('error', 'OPENING_NO_LEAF_ON_EXTERNAL_WALL', level.id, [{ kind: 'opening', id: opening.id }, { kind: 'wall', id: wall.id }, { kind: 'room', id: room.id }], `The ${opening.widthMm}mm opening ${opening.id} has no door in it, but wall ${wall.id} is the outside wall of "${room.name}" — it bounds no other room, so the far side is outdoors. Give it a door, or make it a window.`),
      );
    }

    if (unmeasurable.has(wall.id)) continue; // Length unknown; the fit checks below would be noise.

    const a = nodeById.get(wall.a);
    const b = nodeById.get(wall.b);
    if (a === undefined || b === undefined) continue;

    const lengthSq = distanceSq(a, b);
    const wallLengthMm = distanceMm(a, b);

    // Checked first and reported on its own, because "your door is wider than the wall" is a
    // different conversation from "your door is in the wrong place", and the offset check below
    // would describe the first as the second.
    if (exceedsLength(opening.widthMm, lengthSq)) {
      issues.push(
        issue('error', 'OPENING_WIDER_THAN_WALL', level.id, [{ kind: 'opening', id: opening.id }, { kind: 'wall', id: wall.id }], `The ${opening.kind} ${opening.id} is ${opening.widthMm}mm wide, but wall ${wall.id} is only ${wallLengthMm}mm long, so it cannot fit anywhere on that wall.`),
      );
      continue;
    }

    const endMm = opening.offsetMm + opening.widthMm;
    if (exceedsLength(endMm, lengthSq)) {
      issues.push(
        issue('error', 'OPENING_PAST_WALL_END', level.id, [{ kind: 'opening', id: opening.id }, { kind: 'wall', id: wall.id }], `The ${opening.widthMm}mm ${opening.kind} ${opening.id} starts ${opening.offsetMm}mm along wall ${wall.id} and would end ${endMm - wallLengthMm}mm past the end of that wall, which is ${wallLengthMm}mm long.`),
      );
    }
  }

  for (const [wallId, openings] of byWall) {
    // Sorted so a pair is always reported in the order it appears along the wall, which is the
    // order the user sees in the 2D editor.
    const ordered = [...openings].sort((p, q) => p.offsetMm - q.offsetMm || p.id.localeCompare(q.id));
    for (let i = 0; i < ordered.length; i += 1) {
      for (let j = i + 1; j < ordered.length; j += 1) {
        const first = ordered[i];
        const second = ordered[j];
        const firstEnd = first.offsetMm + first.widthMm;
        const secondEnd = second.offsetMm + second.widthMm;
        // Touching end-to-end is legal; only a genuine share of the wall is not.
        const overlapMm = Math.min(firstEnd, secondEnd) - Math.max(first.offsetMm, second.offsetMm);
        if (overlapMm <= 0) continue;
        issues.push(
          issue('error', 'OPENING_OVERLAP', level.id, [{ kind: 'opening', id: first.id }, { kind: 'opening', id: second.id }, { kind: 'wall', id: wallId }], `On wall ${wallId}, the ${first.kind} ${first.id} (${first.offsetMm}mm to ${firstEnd}mm) overlaps the ${second.kind} ${second.id} (${second.offsetMm}mm to ${secondEnd}mm) by ${overlapMm}mm. Two openings cannot share the same piece of wall.`),
        );
      }
    }
  }

  return issues;
}

/* --- Rooms --------------------------------------------------------------------------------------
 * The room loop becomes the floor polygon the solver subtracts free space from, and the cell in the
 * portal-culling graph. An outline that does not close produces neither: the polygon is garbage and
 * the room is invisible to culling, which shows up as rooms disappearing while walking through the
 * flat rather than as an obvious error.
 *
 * A loop of fewer than 3 walls is not checked here — `RoomSchema.wallLoop` is `z.array(Id).min(3)`,
 * so such a document cannot get past parsing, and re-checking it here would be a second definition
 * of the same rule waiting to disagree with the first.
 * ---------------------------------------------------------------------------------------------- */

function checkRooms(level: Level, wallById: Map<string, Wall>): Issue[] {
  const issues: Issue[] = [];

  // Any leaf counts as a way in, including a cased opening — walking through a doorway does not
  // require it to have a door hanging in it.
  const doorWalls = new Set(level.openings.filter((o) => o.kind === 'door').map((o) => o.wall));
  const roomsByName = new Map<string, string[]>();

  for (const room of level.rooms) {
    const byName = roomsByName.get(room.name) ?? [];
    byName.push(room.id);
    roomsByName.set(room.name, byName);

    const counts = new Map<string, number>();
    for (const id of room.wallLoop) counts.set(id, (counts.get(id) ?? 0) + 1);
    for (const [wallId, n] of counts) {
      if (n < 2) continue;
      issues.push(
        issue('error', 'ROOM_LOOP_REPEATED_WALL', level.id, [{ kind: 'room', id: room.id }, { kind: 'wall', id: wallId }], `Room "${room.name}" (${room.id}) lists wall ${wallId} ${n} times in its outline. A wall can only be one side of a room once.`),
      );
    }

    const walls = room.wallLoop.map((id) => wallById.get(id));
    if (walls.some((w) => w === undefined)) continue; // ROOM_ORPHAN_WALL already reported.

    for (let i = 0; i < walls.length; i += 1) {
      const current = walls[i];
      const next = walls[(i + 1) % walls.length];
      if (current === undefined || next === undefined) continue;
      if (current.a === next.a || current.a === next.b || current.b === next.a || current.b === next.b) continue;
      // Naming the exact pair is the actionable part: "the outline does not close" sends the user
      // hunting round the whole room, and the break is nearly always at one corner.
      issues.push(
        issue('error', 'ROOM_LOOP_BROKEN', level.id, [{ kind: 'room', id: room.id }, { kind: 'wall', id: current.id }, { kind: 'wall', id: next.id }], `The outline of room "${room.name}" (${room.id}) does not close: wall ${current.id} (corners ${current.a} to ${current.b}) and the next wall ${next.id} (corners ${next.a} to ${next.b}) do not meet at a shared corner.`),
      );
    }

    if (!room.wallLoop.some((id) => doorWalls.has(id))) {
      issues.push(
        issue('warning', 'ROOM_NO_DOOR', level.id, [{ kind: 'room', id: room.id }], `Room "${room.name}" (${room.id}) has no door on any of its ${room.wallLoop.length} walls. That is correct for a balcony, but otherwise it means a door was missed — and there is no way to walk into the room in 3D.`),
      );
    }
  }

  // Added beyond the spec: see the reply.
  for (const [name, ids] of roomsByName) {
    if (ids.length < 2) continue;
    issues.push(
      issue('warning', 'ROOM_NAME_DUPLICATE', level.id, ids.map((id): IssueRef => ({ kind: 'room', id })), `${ids.length} rooms on level "${level.name}" are called "${name}" (${ids.join(', ')}). Asking for "the ${name.toLowerCase()}" will be ambiguous — give them distinct names.`),
    );
  }

  return issues;
}

/* --- Items --------------------------------------------------------------------------------------
 * Only the part of placement the DOCUMENT can answer: an anchor that points off the end of its wall
 * is wrong no matter how big the item turns out to be.
 *
 * Whether two pieces of furniture overlap, whether there is room to walk between them, whether a
 * wardrobe door can open — none of that is here. Those need footprints, the document does not store
 * item sizes (the furniture kernel computes them), and inventing an approximation here would give
 * the user a second, quieter, wronger opinion than the placement solver's.
 * ---------------------------------------------------------------------------------------------- */

function checkItems(level: Level, nodeById: Map<string, PlanNode>, wallById: Map<string, Wall>, unmeasurable: Set<string>): Issue[] {
  const issues: Issue[] = [];

  for (const item of level.items) {
    if (item.anchor.on !== 'wall') continue;
    const wall = wallById.get(item.anchor.wall);
    if (wall === undefined || unmeasurable.has(wall.id)) continue;

    const a = nodeById.get(wall.a);
    const b = nodeById.get(wall.b);
    if (a === undefined || b === undefined) continue;

    if (!exceedsLength(item.anchor.offsetMm, distanceSq(a, b))) continue;
    issues.push(
      issue('error', 'ITEM_ANCHOR_PAST_WALL_END', level.id, [{ kind: 'item', id: item.id }, { kind: 'wall', id: wall.id }], `${describeItem(item)} is placed ${item.anchor.offsetMm}mm along wall ${wall.id}, but that wall is only ${distanceMm(a, b)}mm long, so the position is off the end of it.`),
    );
  }

  return issues;
}

/** "The wardrobe (i3)" / "Item i3 (wardrobe)" — whichever the item can actually support. */
function describeItem(item: Item): string {
  return item.name === undefined ? `The ${item.category} ${item.id}` : `"${item.name}" (${item.id})`;
}
