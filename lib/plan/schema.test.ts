/**
 * Shape tests for the parts of the schema that exist to make something IMPOSSIBLE.
 *
 * The type system already refuses most of these at compile time, but the schema's job is guarding
 * the runtime boundaries — a file off disk, an extractor's output, an LLM tool call — where nothing
 * has been through tsc. These lock in the promises the comments in `schema.ts` make.
 */

import { expect, test } from 'vitest';

import { OpeningSchema } from './schema';

const meta = { source: 'user', confidence: 1 } as const;
const doorway = { id: 'd1', wall: 'w1', kind: 'door', offsetMm: 900, widthMm: 900, heightMm: 2100, sillMm: 0, meta };
const swing = { side: 'left', hinge: 'a' } as const;

test('a hinged door must carry a swing', () => {
  expect(OpeningSchema.safeParse({ ...doorway, leaf: 'hinged', swing }).success).toBe(true);
  expect(OpeningSchema.safeParse({ ...doorway, leaf: 'hinged' }).success).toBe(false);
});

test('a slider and a cased opening cannot carry swing data at all', () => {
  expect(OpeningSchema.safeParse({ ...doorway, leaf: 'sliding' }).success).toBe(true);
  expect(OpeningSchema.safeParse({ ...doorway, leaf: 'none' }).success).toBe(true);
  // The solver reads `swing` to subtract a sector of floor. Leftover swing data on a leaf that has
  // none would take floor away from a room that really has it.
  expect(OpeningSchema.safeParse({ ...doorway, leaf: 'sliding', swing }).success).toBe(false);
  expect(OpeningSchema.safeParse({ ...doorway, leaf: 'none', swing }).success).toBe(false);
});

test('a doorway must say which leaf it has, and a window must not', () => {
  expect(OpeningSchema.safeParse(doorway).success).toBe(false);
  expect(OpeningSchema.safeParse({ ...doorway, id: 'v1', kind: 'window', sillMm: 900 }).success).toBe(true);
  expect(OpeningSchema.safeParse({ ...doorway, id: 'v1', kind: 'window', leaf: 'sliding' }).success).toBe(false);
});
