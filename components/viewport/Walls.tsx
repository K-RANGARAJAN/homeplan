'use client';

/**
 * components/viewport/Walls.tsx — the wall meshes.
 *
 * Geometry is built once per document and never inside the render loop. Rebuilding footprints on
 * every frame is the performance mistake that gets baked in early and is miserable to unpick later,
 * because by then five other things depend on the rebuild happening.
 */

import { useEffect, useMemo } from 'react';
import * as THREE from 'three';

import { wallFootprints } from '@/lib/geometry/walls';
import type { Level } from '@/lib/plan/schema';

import { extrudeFootprint } from './extrude';

export const WALL_COLOUR = '#f3f0ea';

export function Walls({ level }: { level: Level }): React.JSX.Element {
  const meshes = useMemo(() => {
    const footprints = wallFootprints(level);
    return level.walls.flatMap((wall) => {
      const footprint = footprints.get(wall.id);
      // A wall with a dangling node reference has no footprint. `validate` already reports it; the
      // viewport draws the other twenty-four rather than refusing to draw anything.
      if (footprint === undefined) return [];
      return [{ id: wall.id, geometry: extrudeFootprint(footprint, wall.heightMm) }];
    });
  }, [level]);

  // One material for the lot: every wall is the same painted plaster, and a material per mesh would
  // be a shader compile per wall.
  const material = useMemo(
    () => new THREE.MeshStandardMaterial({ color: WALL_COLOUR, roughness: 0.92, metalness: 0 }),
    [],
  );

  useEffect(() => () => meshes.forEach((mesh) => mesh.geometry.dispose()), [meshes]);
  useEffect(() => () => material.dispose(), [material]);

  return (
    <group>
      {meshes.map((mesh) => (
        <mesh key={mesh.id} geometry={mesh.geometry} material={material} />
      ))}
    </group>
  );
}
