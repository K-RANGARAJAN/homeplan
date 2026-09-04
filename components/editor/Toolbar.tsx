'use client';

/**
 * components/editor/Toolbar.tsx — tools, and everything a key would otherwise be needed for.
 *
 * The platform rule for this editor is that a keyboard may not exist, so every action bound to a key
 * also has a control here: undo, redo, delete, ending a wall chain, turning snapping off. Nothing is
 * hover-only and nothing is behind a right-click, because neither survives contact with a phone.
 * Buttons are 44px so a thumb can hit them.
 *
 * Exactly one tool is active at a time and it is always visibly indicated — an editor whose mode you
 * have to infer from what happens when you tap is an editor that surprises you.
 */

import { describeDeletion } from '@/lib/plan/delete';
import { usePlanStore, type Tool } from '@/lib/plan/store';

const TOOLS: { id: Tool; label: string; hint: string }[] = [
  { id: 'select', label: 'Select', hint: 'Tap a corner or wall. Drag a corner to move it.' },
  { id: 'draw', label: 'Draw wall', hint: 'Tap to start, tap again for each corner. Done ends the run.' },
  { id: 'delete', label: 'Delete', hint: 'Tap what should go.' },
];

export function Toolbar(): React.JSX.Element {
  const tool = usePlanStore((state) => state.tool);
  const snapping = usePlanStore((state) => state.snapping);
  const chain = usePlanStore((state) => state.chain);
  const canUndo = usePlanStore((state) => state.history.past.length > 0);
  const canRedo = usePlanStore((state) => state.history.future.length > 0);
  const selectionCount = usePlanStore((state) => state.selection.length);
  const notice = usePlanStore((state) => state.notice);
  const pendingDelete = usePlanStore((state) => state.pendingDelete);

  const store = usePlanStore.getState;
  const hint = TOOLS.find((t) => t.id === tool)?.hint ?? '';

  return (
    <div className="flex flex-col gap-2 border-b border-black/10 bg-white/80 p-2 backdrop-blur dark:border-white/10 dark:bg-black/40">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex overflow-hidden rounded-lg border border-black/15 dark:border-white/20">
          {TOOLS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              aria-pressed={tool === entry.id}
              onClick={() => store().setTool(entry.id)}
              className={`h-11 min-w-[88px] px-3 text-sm font-medium transition-colors ${
                tool === entry.id
                  ? 'bg-blue-600 text-white'
                  : 'bg-transparent text-inherit hover:bg-black/5 dark:hover:bg-white/10'
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>

        {/* Ending a wall run needs a visible control: Escape is an accelerator, not the mechanism. */}
        <Button onClick={() => store().endChain()} disabled={chain === null}>
          Done
        </Button>

        <Button onClick={() => store().undo()} disabled={!canUndo}>
          Undo
        </Button>
        <Button onClick={() => store().redo()} disabled={!canRedo}>
          Redo
        </Button>
        <Button onClick={() => store().requestDelete()} disabled={selectionCount === 0}>
          Delete
        </Button>
        <Button onClick={() => store().fitToPlan()}>Fit</Button>

        {/* One toggle for both kinds of snap, as specified: corners and 90 degrees together. */}
        <label className="flex h-11 items-center gap-2 rounded-lg border border-black/15 px-3 text-sm dark:border-white/20">
          <input
            type="checkbox"
            className="h-5 w-5 accent-blue-600"
            checked={snapping}
            onChange={(event) => store().setSnapping(event.target.checked)}
          />
          Snap to corners and 90&deg;
        </label>
      </div>

      <p className="text-xs text-black/60 dark:text-white/60">{hint}</p>

      {pendingDelete !== null && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/50 bg-amber-50 p-3 text-sm text-amber-900">
          <span>
            That also removes {describeDeletion(pendingDelete)}
            {pendingDelete.rooms.length > 0 ? ' — a room whose outline runs along it cannot survive losing a wall' : ''}.
          </span>
          <span className="ml-auto flex gap-2">
            <Button onClick={() => store().cancelDelete()}>Keep</Button>
            <Button onClick={() => store().confirmDelete()} tone="danger">
              Delete anyway
            </Button>
          </span>
        </div>
      )}

      {notice !== null && (
        <p className="rounded-lg bg-black/5 px-3 py-2 text-xs dark:bg-white/10" role="status">
          {notice}
        </p>
      )}
    </div>
  );
}

function Button({
  children,
  onClick,
  disabled = false,
  tone = 'plain',
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tone?: 'plain' | 'danger';
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`h-11 rounded-lg border px-3 text-sm font-medium disabled:opacity-40 ${
        tone === 'danger'
          ? 'border-red-600 bg-red-600 text-white'
          : 'border-black/15 hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10'
      }`}
    >
      {children}
    </button>
  );
}
