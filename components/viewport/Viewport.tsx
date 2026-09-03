'use client';

/**
 * components/viewport/Viewport.tsx — the first 3D view of the flat.
 *
 * Scope for this build order item is deliberately narrow: the shell standing up, correctly joined,
 * lit well enough to read, and orbitable. Openings, portal culling, the four camera modes and the
 * swoop, single-sided walls, ceilings, materials and furniture are all later items, and each is
 * bigger than it looks from here.
 */

import { CameraControls, ContactShadows } from '@react-three/drei';
import { Canvas, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef, type ComponentRef } from 'react';
import * as THREE from 'three';

import { toMetres } from '@/lib/geometry/plan-space';
import { sampleFlat } from '@/lib/plan/sample';
import type { Level } from '@/lib/plan/schema';

import { Walls } from './Walls';

/** Light enough to read the walls against, dark enough that the walls are not the same colour. */
const BACKGROUND_COLOUR = '#cbc7c0';
const FLOOR_COLOUR = '#e6e2db';

/** How far the floor slab runs past the outermost wall, in metres. */
const FLOOR_MARGIN_M = 1.5;

/**
 * Where the camera starts: a high three-quarter view, 48 degrees up and 45 degrees round.
 *
 * High enough to read the layout like a plan — which is what the user came to look at — and low
 * enough that the walls still have visible height and the shadows still say which way is up. The
 * top-down overview and the swoop into a room are a later item; this is the one static viewpoint.
 */
const START_ELEVATION_RAD = (48 * Math.PI) / 180;
const START_AZIMUTH_RAD = (45 * Math.PI) / 180;
/** A little air around the building so it does not touch the edges of the window. */
const FRAMING_MARGIN = 1.12;

interface Bounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  topY: number;
}

/**
 * The extent of the plan in world metres, including wall thickness and the tallest wall.
 *
 * Used to frame the camera and to size the floor. Opening on a default camera pointing at nothing
 * in particular is the first thing that makes a 3D tool feel broken, and it is entirely avoidable:
 * the document knows exactly how big the building is.
 */
function planBounds(level: Level): Bounds {
  if (level.nodes.length === 0) return { minX: -5, maxX: 5, minZ: -5, maxZ: 5, topY: 3 };

  const halfThickest = Math.max(0, ...level.walls.map((w) => w.thicknessMm / 2));
  const xs = level.nodes.map((n) => n.x);
  const ys = level.nodes.map((n) => n.y);

  return {
    minX: toMetres(Math.min(...xs) - halfThickest),
    maxX: toMetres(Math.max(...xs) + halfThickest),
    minZ: toMetres(Math.min(...ys) - halfThickest),
    maxZ: toMetres(Math.max(...ys) + halfThickest),
    topY: toMetres(Math.max(0, ...level.walls.map((w) => w.heightMm))),
  };
}

export function Viewport(): React.JSX.Element {
  // One document, built once. Nothing loads from disk this task.
  const doc = useMemo(() => sampleFlat(), []);
  const level = doc.levels[0];
  const bounds = useMemo(() => planBounds(level), [level]);

  return (
    <div className="fixed inset-0">
      <Canvas dpr={[1, 2]} camera={{ fov: 45, near: 0.1, far: 400 }}>
        <color attach="background" args={[BACKGROUND_COLOUR]} />

        {/*
          Lighting v1: even brightness so every surface is legible, and nothing else. No fixtures,
          no bounced-light proxy scene — that is a later item and guesswork before materials exist.
          The hemisphere light does the work; the directional light only gives the walls a faint
          light side and dark side so corners read as corners.
        */}
        <hemisphereLight args={['#ffffff', '#b5afa4', 2.0]} />
        <ambientLight intensity={0.25} />
        <directionalLight position={[12, 18, 8]} intensity={1.4} />

        <Floor bounds={bounds} />
        <Walls level={level} />

        {/*
          Faint contact shadows, so the walls sit on the floor instead of floating above a flat
          drawing of one. `frames={1}` renders the shadow once: nothing in this scene moves yet, and
          re-rendering a shadow map every frame for a static building is pure waste.
        */}
        <ContactShadows
          position={[(bounds.minX + bounds.maxX) / 2, 0.005, (bounds.minZ + bounds.maxZ) / 2]}
          scale={Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) * 1.4}
          resolution={2048}
          far={2}
          blur={2}
          opacity={0.55}
          color="#3a3630"
          frames={1}
        />

        <Framing bounds={bounds} />
      </Canvas>
    </div>
  );
}

function Floor({ bounds }: { bounds: Bounds }): React.JSX.Element {
  const width = bounds.maxX - bounds.minX + FLOOR_MARGIN_M * 2;
  const depth = bounds.maxZ - bounds.minZ + FLOOR_MARGIN_M * 2;

  // One plain slab. Per-room floors need the room polygons triangulated and materials to put on
  // them, and both are later items.
  return (
    <mesh
      rotation={[-Math.PI / 2, 0, 0]}
      position={[(bounds.minX + bounds.maxX) / 2, 0, (bounds.minZ + bounds.maxZ) / 2]}
    >
      <planeGeometry args={[width, depth]} />
      <meshStandardMaterial color={FLOOR_COLOUR} roughness={1} metalness={0} />
    </mesh>
  );
}

/**
 * Orbit controls, framed on the whole flat at load.
 *
 * Drag orbits the model the way a car configurator does — the building stays put and you move round
 * it. Room selection, the swoop and the walkthrough camera are a later item; this is one camera.
 */
function Framing({ bounds }: { bounds: Bounds }): React.JSX.Element {
  const controls = useRef<ComponentRef<typeof CameraControls>>(null);
  const camera = useThree((state) => state.camera);

  // Framed once, when the document arrives — deliberately not on resize, because re-aiming the
  // camera under someone who is in the middle of orbiting is worse than a slightly awkward crop.
  useEffect(() => {
    const instance = controls.current;
    if (instance === null || !(camera instanceof THREE.PerspectiveCamera)) return;

    const target = new THREE.Vector3(
      (bounds.minX + bounds.maxX) / 2,
      bounds.topY / 2,
      (bounds.minZ + bounds.maxZ) / 2,
    );

    // Distance from the bounding sphere and the narrower of the two fields of view, so the whole
    // building fits whatever the window shape. Done in one `setLookAt` rather than aiming and then
    // calling `fitToBox`: those apply on the next frame, so the fit would be computed against the
    // camera's old direction and the flat would open edge-on at eye level.
    const radius = Math.hypot(
      (bounds.maxX - bounds.minX) / 2,
      bounds.topY / 2,
      (bounds.maxZ - bounds.minZ) / 2,
    );
    const verticalFov = (camera.fov * Math.PI) / 180;
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * camera.aspect);
    const distance = (radius / Math.sin(Math.min(verticalFov, horizontalFov) / 2)) * FRAMING_MARGIN;

    const offset = new THREE.Vector3(
      Math.sin(START_AZIMUTH_RAD) * Math.cos(START_ELEVATION_RAD),
      Math.sin(START_ELEVATION_RAD),
      Math.cos(START_AZIMUTH_RAD) * Math.cos(START_ELEVATION_RAD),
    ).multiplyScalar(distance);

    void instance.setLookAt(
      target.x + offset.x,
      target.y + offset.y,
      target.z + offset.z,
      target.x,
      target.y,
      target.z,
      false,
    );
  }, [bounds, camera]);

  return <CameraControls ref={controls} makeDefault minDistance={1} maxDistance={200} />;
}
