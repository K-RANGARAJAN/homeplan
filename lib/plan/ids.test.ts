import { describe, expect, test } from 'vitest';

import { freshId, levelIds } from './ids';
import { sampleFlat } from './sample';

describe('levelIds', () => {
  test('collects ids from every collection, not just one', () => {
    const ids = levelIds(sampleFlat().levels[0]);
    expect(ids.has('n1')).toBe(true);
    expect(ids.has('w1')).toBe(true);
    expect(ids.has('d1')).toBe(true);
    expect(ids.has('r1')).toBe(true);
  });
});

describe('freshId', () => {
  test('counts up from the highest in use', () => {
    expect(freshId('w', levelIds(sampleFlat().levels[0]))).toBe('w26');
  });

  test('does not refill a gap left by a deletion', () => {
    const taken = new Set(['n1', 'n2', 'n5']);
    expect(freshId('n', taken)).toBe('n6');
  });

  test('mutates the set, so two ids minted in one operation cannot collide', () => {
    const taken = new Set(['n1']);
    expect(freshId('n', taken)).toBe('n2');
    expect(freshId('n', taken)).toBe('n3');
  });

  test('ignores ids that do not follow the convention, and still avoids them', () => {
    const taken = new Set(['w3x', 'w4']);
    expect(freshId('w', taken)).toBe('w5');
  });

  test('starts at 1 in an empty plan', () => {
    expect(freshId('n', new Set())).toBe('n1');
  });
});
