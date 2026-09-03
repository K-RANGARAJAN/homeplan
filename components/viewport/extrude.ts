/**
 * components/viewport/extrude.ts — footprints into solid prisms.
 *
 * This lives with the renderer, not in `lib/geometry`, because it is the first file that knows what
 * three.js is. Everything upstream of it is plain numbers in millimetres.
 *
 * WHY NOT `ExtrudeGeometry`. Three's own extruder would do the shape in one line and generate UVs
 * we cannot use: it lays them out per-shape in arbitrary units, and the requirement later is
 * textures tiled at TRUE MILLIMETRE SCALE with a known grain direction — a 600mm tile has to be
 * 600mm on the wall. Retrofitting that means replacing the geometry anyway, so it is written by
 * hand now and written once.
 *
 * The buffer is non-indexed and grouped one face at a time: each side of a wall is six consecutive
 * vertices, in the order bottom-start, bottom-end, top-end / bottom-start, top-end, top-start. That
 * is the structure UVs need — u running along the wall from a known start, v running up from the
 * floor — so they can be added later by filling a second array in the same loop, with nothing else
 * moved. Normals are written per face rather than computed afterwards, because
 * `computeVertexNormals` averages across the sharp edges of a wall and rounds off its corners.
 */

import * as THREE from 'three';

import { toMetres, type Point } from '@/lib/geometry/plan-space';

/**
 * A closed prism: the footprint at floor level, the same footprint at `heightMm`, and the sides
 * between them.
 *
 * Solid and double-ended on purpose for this build order item. Walls will later be single-sided
 * with their normals facing into the room so the ones between you and the room fade out — but that
 * treatment also hides mitre errors, which are the thing this task exists to expose. A wall that
 * disappears when you orbit past it cannot be checked.
 *
 * Plan (x, y) maps to world (x, z); height runs up in world y. Millimetres become metres here and
 * in no other file.
 */
export function extrudeFootprint(footprint: readonly Point[], heightMm: number): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];

  const ring = footprint.map((p) => ({ x: toMetres(p.x), z: toMetres(p.y) }));
  const top = toMetres(heightMm);

  // The centroid is only used to decide which way is "out" for each side face, so the crude average
  // of the corners is good enough — it is inside every footprint this produces.
  const centroid = ring.reduce((acc, p) => ({ x: acc.x + p.x / ring.length, z: acc.z + p.z / ring.length }), {
    x: 0,
    z: 0,
  });

  for (let i = 0; i < ring.length; i += 1) {
    const start = ring[i];
    const end = ring[(i + 1) % ring.length];
    const dx = end.x - start.x;
    const dz = end.z - start.z;
    const edgeLength = Math.hypot(dx, dz);
    if (edgeLength === 0) continue; // A mitre can land on the point next to it; that face has no area.

    // Horizontal perpendicular to the edge, flipped to face away from the middle of the wall.
    const candidate = { x: dz / edgeLength, y: 0, z: -dx / edgeLength };
    const outward =
      (start.x + dx / 2 - centroid.x) * candidate.x + (start.z + dz / 2 - centroid.z) * candidate.z < 0
        ? { x: -candidate.x, y: 0, z: -candidate.z }
        : candidate;

    const bottomStart = { x: start.x, y: 0, z: start.z };
    const bottomEnd = { x: end.x, y: 0, z: end.z };
    const topEnd = { x: end.x, y: top, z: end.z };
    const topStart = { x: start.x, y: top, z: start.z };

    pushTriangle(positions, normals, bottomStart, bottomEnd, topEnd, outward);
    pushTriangle(positions, normals, bottomStart, topEnd, topStart, outward);
  }

  // Caps, fanned from the first corner. A fan is only exactly right for a convex polygon; wall
  // footprints are convex or very nearly so, and the visible consequence of the exception is one
  // sliver of ceiling-facing triangle in the wrong place, on a face nobody looks at from above.
  // Proper triangulation arrives with per-room floors, which genuinely need it.
  for (let i = 1; i + 1 < ring.length; i += 1) {
    const a = ring[0];
    const b = ring[i];
    const c = ring[i + 1];
    pushTriangle(
      positions,
      normals,
      { x: a.x, y: top, z: a.z },
      { x: b.x, y: top, z: b.z },
      { x: c.x, y: top, z: c.z },
      { x: 0, y: 1, z: 0 },
    );
    pushTriangle(
      positions,
      normals,
      { x: a.x, y: 0, z: a.z },
      { x: b.x, y: 0, z: b.z },
      { x: c.x, y: 0, z: c.z },
      { x: 0, y: -1, z: 0 },
    );
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(normals), 3));
  geometry.computeBoundingSphere();
  return geometry;
}

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Append one triangle, wound so its geometric normal agrees with `desired`.
 *
 * Deciding the winding from the maths rather than from the polygon's direction means the caller
 * never has to reason about whether a plan-space clockwise polygon is world-space anticlockwise
 * after y becomes z. Get that wrong and the wall renders inside out: invisible from outside, and
 * visible from inside as a wall that should be behind you.
 */
function pushTriangle(positions: number[], normals: number[], a: Vec3, b: Vec3, c: Vec3, desired: Vec3): void {
  const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  const ac = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
  const geometric = {
    x: ab.y * ac.z - ab.z * ac.y,
    y: ab.z * ac.x - ab.x * ac.z,
    z: ab.x * ac.y - ab.y * ac.x,
  };
  const facingAway = geometric.x * desired.x + geometric.y * desired.y + geometric.z * desired.z < 0;
  const [first, second, third] = facingAway ? [a, c, b] : [a, b, c];

  for (const vertex of [first, second, third]) {
    positions.push(vertex.x, vertex.y, vertex.z);
    normals.push(desired.x, desired.y, desired.z);
  }
}
