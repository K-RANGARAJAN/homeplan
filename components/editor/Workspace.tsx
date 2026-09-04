'use client';

/**
 * components/editor/Workspace.tsx — the 2D plan and the 3D shell, side by side.
 *
 * Both read the same store, so an edit in the plan is already an edit in the 3D view; there is no
 * sync step and there is nothing that could fall out of step. That is the "one document, many
 * renderings" principle made visible, and in practice it is also the fastest way to find a geometry
 * bug — draw a wall, and if the shell that stands up is not the wall you drew, the problem is
 * between the two and nowhere else.
 *
 * Split on a desktop, switchable on a phone, because two half-width panes on a 390px screen are two
 * useless panes.
 */

import { useState } from 'react';

import { Viewport } from '@/components/viewport/Viewport';

import { Issues } from './Issues';
import { PlanEditor } from './PlanEditor';
import { Toolbar } from './Toolbar';
import { WallLength } from './WallLength';

type Pane = 'plan' | 'model';

export function Workspace(): React.JSX.Element {
  const [pane, setPane] = useState<Pane>('plan');

  return (
    <div className="flex h-dvh flex-col">
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <section
          className={`min-h-0 min-w-0 flex-1 flex-col md:flex ${pane === 'plan' ? 'flex' : 'hidden'}`}
        >
          <Toolbar />
          <div className="relative min-h-0 flex-1">
            <PlanEditor />
          </div>
          <WallLength />
          <Issues />
        </section>

        <section
          className={`relative min-h-0 min-w-0 flex-1 border-black/10 md:block md:border-l dark:border-white/10 ${
            pane === 'model' ? 'block' : 'hidden'
          }`}
        >
          <Viewport />
        </section>
      </div>

      {/* Phone-sized viewports get a switch instead of a split. 44px tall, like every other target. */}
      <nav className="flex border-t border-black/10 md:hidden dark:border-white/10">
        {(
          [
            ['plan', 'Plan'],
            ['model', '3D'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-pressed={pane === id}
            onClick={() => setPane(id)}
            className={`h-12 flex-1 text-sm font-medium ${
              pane === id ? 'bg-blue-600 text-white' : ''
            }`}
          >
            {label}
          </button>
        ))}
      </nav>
    </div>
  );
}
