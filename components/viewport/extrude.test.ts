/**
 * Tests for the extrusion. CLAUDE.md's rule is that anything with arithmetic in it gets tests, and
 * this file converts units, decides winding and writes normals — three things that fail silently.
 * An inside-out wall is invisible from outside and looks like a missing wall, not like an error.
 */

import { expect, test } from 'vitest';

import { extrudeFootprint } from './extrude';

/** A 4000 x 230 wall footprint in plan millimetres, centred on the origin. */
const RECTANGLE = [
  { x: -2000, y: -115 },
  { x: 2000, y: -115 },
  { x: 2000, y: 115 },
  { x: -2000, y: 115 },
];

function attribute(name: 'position' | 'normal'): Float32Array {
  const array = extrudeFootprint(RECTANGLE, 2900).getAttribute(name).array;
  return array instanceof Float32Array ? array : new Float32Array(array);
}

test('a four-sided footprint becomes four side faces and two caps', () => {
  // 4 sides x 2 triangles + 2 caps x 2 triangles = 12 triangles, 36 vertices, non-indexed.
  expect(attribute('position').length).toBe(36 * 3);
});

test('millimetres become metres exactly here', () => {
  const positions = attribute('position');
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  for (let i = 0; i < positions.length; i += 3) {
    xs.push(positions[i]);
    ys.push(positions[i + 1]);
    zs.push(positions[i + 2]);
  }

  // Plan (x, y) -> world (x, z), height up in world y, and everything divided by 1000.
  expect(Math.min(...xs)).toBeCloseTo(-2, 6);
  expect(Math.max(...xs)).toBeCloseTo(2, 6);
  expect(Math.min(...zs)).toBeCloseTo(-0.115, 6);
  expect(Math.max(...zs)).toBeCloseTo(0.115, 6);
  expect(Math.min(...ys)).toBe(0);
  expect(Math.max(...ys)).toBeCloseTo(2.9, 6);
});

test('every normal is a unit vector and every position is a real number', () => {
  const normals = attribute('normal');
  const positions = attribute('position');
  for (const value of positions) expect(Number.isFinite(value)).toBe(true);
  for (let i = 0; i < normals.length; i += 3) {
    expect(Math.hypot(normals[i], normals[i + 1], normals[i + 2])).toBeCloseTo(1, 6);
  }
});

test('side faces point outwards and the caps point up and down', () => {
  const normals = attribute('normal');
  const seen = new Set<string>();
  for (let i = 0; i < normals.length; i += 3) {
    seen.add([normals[i], normals[i + 1], normals[i + 2]].map((n) => Math.round(n)).join(','));
  }

  // A rectangle around the origin: the four sides face the four compass directions, away from the
  // middle of the wall. If any of these were flipped the wall would render inside out.
  expect(seen).toEqual(new Set(['1,0,0', '-1,0,0', '0,0,1', '0,0,-1', '0,1,0', '0,-1,0']));
});
