import { Workspace } from '@/components/editor/Workspace';

/**
 * The editor is entirely interactive — pointer events, a canvas, a client-side store — so this
 * server component exists only to name the boundary and hand off to it. Loading a saved document is
 * a later task; the store opens on the sample flat.
 */
export default function Home() {
  return <Workspace />;
}
