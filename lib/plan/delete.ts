/**
 * lib/plan/delete.ts — working out everything that has to go.
 *
 * Deleting in a document held together by shared references is never a one-element operation. Take
 * out a corner and the walls pinned to it have no position. Take out a wall and its doors have no
 * host, its wardrobe has no anchor, and any room whose outline ran along it can no longer close.
 * Leave those behind and the editor hands the user a document full of errors it created itself,
 * which is the opposite of the repair tool it is meant to be.
 *
 * So this computes the whole cascade FIRST, as a list of ids, and returns it. The editor shows it —
 * "this also removes 2 walls and the master bathroom" — before anything happens, and then applies
 * exactly what it showed. Preview and effect are the same computation, so they cannot disagree.
 *
 * Pure. No React, no store.
 */

import type { Level } from './schema';

/**
 * What the editor can select, and — not coincidentally — what it can delete.
 *
 * Only corners and walls. Openings, rooms and items are later passes; when they arrive they become
 * selectable and this union grows, and every switch over it stops compiling until it is handled,
 * which is the point of keeping it a union rather than a string.
 */
export interface Selected {
  kind: 'node' | 'wall';
  id: string;
}

export interface Deletion {
  nodes: string[];
  walls: string[];
  openings: string[];
  items: string[];
  rooms: string[];
}

/** Nothing selected, or a selection that resolves to nothing. */
export function isEmptyDeletion(deletion: Deletion): boolean {
  return (
    deletion.nodes.length === 0 &&
    deletion.walls.length === 0 &&
    deletion.openings.length === 0 &&
    deletion.items.length === 0 &&
    deletion.rooms.length === 0
  );
}

/**
 * Everything that must go if `targets` go.
 *
 * The rules, each of which exists because the alternative is a document the validator rejects:
 *
 *   - A selected corner takes every wall pinned to it. (`WALL_ORPHAN_NODE` otherwise.)
 *   - A deleted wall takes its openings and any item anchored to it. (`OPENING_ORPHAN_WALL`,
 *     `ITEM_ORPHAN_ANCHOR`.)
 *   - A deleted wall takes any room whose outline ran along it. (`ROOM_ORPHAN_WALL`.) Deleting the
 *     room rather than leaving a hole in its loop is the aggressive choice, and it is the right one
 *     while rooms cannot yet be edited: a room whose outline is broken is an error the user has no
 *     tool to fix. It is named in the warning, so nothing disappears unannounced.
 *   - Items anchored to anything that goes, go — transitively, because item anchors chain.
 *   - A corner that loses its LAST wall goes too. Otherwise every delete leaves a draggable dot
 *     attached to nothing, which is the `NODE_UNREFERENCED` warning and, more to the point, litter.
 *     Only corners touched by this deletion are swept: an orphan somewhere else in the plan is not
 *     this operation's business.
 */
export function planDeletion(level: Level, targets: readonly Selected[]): Deletion {
  const nodes = new Set<string>();
  const walls = new Set<string>();

  // Seeded only from elements that are actually there. A selection can name something that has
  // already gone — an undo landed while a menu was open — and reporting "1 wall" for a wall that
  // does not exist would put a warning in front of the user about nothing at all.
  const existingNodes = new Set(level.nodes.map((n) => n.id));
  const existingWalls = new Set(level.walls.map((w) => w.id));
  for (const target of targets) {
    if (target.kind === 'node') {
      if (existingNodes.has(target.id)) nodes.add(target.id);
    } else if (existingWalls.has(target.id)) {
      walls.add(target.id);
    }
  }

  // Corners touched by the deletion, whether or not they were selected — the candidates for the
  // orphan sweep at the end.
  const touched = new Set<string>(nodes);
  for (const wall of level.walls) {
    if (!nodes.has(wall.a) && !nodes.has(wall.b) && !walls.has(wall.id)) continue;
    walls.add(wall.id);
    touched.add(wall.a);
    touched.add(wall.b);
  }

  const rooms = new Set(
    level.rooms.filter((room) => room.wallLoop.some((id) => walls.has(id))).map((room) => room.id),
  );
  const openings = new Set(
    level.openings.filter((opening) => walls.has(opening.wall)).map((opening) => opening.id),
  );

  // Item anchors form chains (each item has exactly one anchor), so a fixpoint over the whole list
  // settles in as many passes as the chain is long. Cycles are impossible to loop on here because
  // the set only ever grows.
  const items = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const item of level.items) {
      if (items.has(item.id)) continue;
      const anchor = item.anchor;
      const doomed =
        anchor.on === 'wall'
          ? walls.has(anchor.wall)
          : anchor.on === 'room'
            ? rooms.has(anchor.room)
            : items.has(anchor.item);
      if (!doomed) continue;
      items.add(item.id);
      grew = true;
    }
  }

  for (const nodeId of touched) {
    if (nodes.has(nodeId)) continue;
    const survives = level.walls.some(
      (wall) => !walls.has(wall.id) && (wall.a === nodeId || wall.b === nodeId),
    );
    if (!survives) nodes.add(nodeId);
  }

  return {
    nodes: [...nodes],
    walls: [...walls],
    openings: [...openings],
    items: [...items],
    rooms: [...rooms],
  };
}

/** "2 walls, 1 room" — for the warning shown before anything is removed. */
export function describeDeletion(deletion: Deletion): string {
  const parts: string[] = [];
  const say = (n: number, singular: string, plural: string): void => {
    if (n > 0) parts.push(`${n} ${n === 1 ? singular : plural}`);
  };
  say(deletion.nodes.length, 'corner', 'corners');
  say(deletion.walls.length, 'wall', 'walls');
  say(deletion.openings.length, 'opening', 'openings');
  say(deletion.rooms.length, 'room', 'rooms');
  say(deletion.items.length, 'item', 'items');
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
