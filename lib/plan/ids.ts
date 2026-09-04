/**
 * lib/plan/ids.ts — minting the next `n19` or `w26`.
 *
 * Ids in this document are short and human-readable on purpose: the chat layer will name elements by
 * id in every tool call, and a person has to be able to read them in a log and match them to what
 * they see on screen. `w26` does that; a uuid does not.
 *
 * The cost of short ids is that they have to be allocated, and `validate` requires them to be unique
 * across EVERY collection on a level, not just within one — `DUPLICATE_ID` is reported when a node
 * and a room share a name. So allocation looks at all of them at once.
 *
 * Pure. No React, no store.
 */

import type { Level } from './schema';

/** Every id in use on a level, in one set. */
export function levelIds(level: Level): Set<string> {
  const taken = new Set<string>();
  for (const n of level.nodes) taken.add(n.id);
  for (const w of level.walls) taken.add(w.id);
  for (const o of level.openings) taken.add(o.id);
  for (const r of level.rooms) taken.add(r.id);
  for (const i of level.items) taken.add(i.id);
  return taken;
}

/**
 * The next free `prefix` + number.
 *
 * Counts UP FROM THE HIGHEST already in use, rather than filling gaps. Reusing `w7` after the
 * original `w7` was deleted would make an undo history, a chat transcript and a screenshot
 * annotation all refer to two different walls by the same name, which is the sort of confusion that
 * only ever surfaces in front of someone else.
 *
 * `taken` is threaded through as a mutable set so a caller minting several ids in one operation —
 * splitting a wall needs a node and a wall — cannot hand out the same one twice.
 */
export function freshId(prefix: string, taken: Set<string>): string {
  const pattern = new RegExp(`^${prefix}(\\d+)$`);
  let highest = 0;
  for (const id of taken) {
    const match = pattern.exec(id);
    if (match !== null) highest = Math.max(highest, Number(match[1]));
  }

  let candidate = `${prefix}${highest + 1}`;
  // The scan above only sees ids that follow the convention. A document that arrived with a literal
  // `w4x` and a `w4` is still handled, rather than producing a duplicate the validator has to catch.
  while (taken.has(candidate)) {
    highest += 1;
    candidate = `${prefix}${highest + 1}`;
  }
  taken.add(candidate);
  return candidate;
}

/** Prefixes, in one place so the editor and the extractor cannot disagree about them. */
export const ID_PREFIX = { node: 'n', wall: 'w', opening: 'o', room: 'r', item: 'i' } as const;
