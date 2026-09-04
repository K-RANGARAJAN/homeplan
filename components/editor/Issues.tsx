'use client';

/**
 * components/editor/Issues.tsx — live validation, kept out of the way.
 *
 * `validate()` runs on every document change and the result is always on screen, because the whole
 * point of this editor is to REPAIR a plan and you cannot repair what you cannot see. But it is a
 * count that expands, not a permanent panel: on a phone a list of eight warnings would eat half the
 * drawing.
 *
 * NOT DEBOUNCED, and that is a measurement rather than a hope: the sample flat — eighteen corners,
 * twenty-five walls, eight rooms — validates in about 15 microseconds, and the mitred wall footprints
 * the plan is drawn from take about 35. Sixty of those a second is a rounding error. A debounce would
 * add lag to the one signal that is supposed to be immediate, so it is worth adding when a plan turns
 * up where it measurably costs something, and not one moment before.
 *
 * Tapping an issue selects and centres what it names. That is what `Issue.refs` carrying a collection
 * kind is for: a bare list of ids would have to be searched against all five collections to find out
 * what to highlight.
 */

import { useState } from 'react';

import { usePlanStore } from '@/lib/plan/store';
import type { Issue } from '@/lib/plan/validate';

export function Issues(): React.JSX.Element {
  const issues = usePlanStore((state) => state.issues);
  const focus = usePlanStore((state) => state.focus);
  const [open, setOpen] = useState(false);

  const errors = issues.filter((issue) => issue.severity === 'error').length;
  const warnings = issues.length - errors;

  return (
    <div className="border-t border-black/10 dark:border-white/10">
      <button
        type="button"
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
        className="flex h-11 w-full items-center gap-2 px-3 text-left text-sm"
      >
        <span className="shrink-0">
          <Dot tone={errors > 0 ? 'error' : warnings > 0 ? 'warning' : 'clean'} />
        </span>
        <span className="min-w-0 flex-1 truncate font-medium">
          {issues.length === 0
            ? 'No problems'
            : `${errors > 0 ? `${errors} ${errors === 1 ? 'error' : 'errors'}` : ''}${errors > 0 && warnings > 0 ? ', ' : ''}${warnings > 0 ? `${warnings} ${warnings === 1 ? 'warning' : 'warnings'}` : ''}`}
        </span>
        {issues.length > 0 && <span className="shrink-0 opacity-60">{open ? 'Hide' : 'Show'}</span>}
      </button>

      {open && issues.length > 0 && (
        <ul className="max-h-56 overflow-y-auto overscroll-contain border-t border-black/10 dark:border-white/10">
          {issues.map((issue, index) => (
            <li key={`${issue.code}-${index}`}>
              <button
                type="button"
                onClick={() => focus(issue.refs)}
                className="flex min-h-11 w-full items-start gap-2 px-3 py-2 text-left text-xs hover:bg-black/5 dark:hover:bg-white/10"
              >
                <span className="shrink-0 pt-[3px]">
                  <Dot tone={issue.severity} />
                </span>
                {/*
                  `min-w-0` is what stops this row overflowing, and it is not optional. A flex item
                  defaults to `min-width: auto`, which means it refuses to shrink below its longest
                  unbreakable word — and these rows carry codes like OPENING_NO_LEAF_ON_EXTERNAL_WALL.
                  The row then grows wider than the list; the list has `overflow-y: auto`, which per
                  the spec computes `overflow-x` to `auto` as well; and once that has been swiped
                  sideways on a phone, every row is cut off on its left edge, code first. Letting the
                  column shrink, and letting the words break, means there is nothing to scroll.
                */}
                <span className="min-w-0 flex-1">
                  <span className="block break-all font-mono opacity-50">{issue.code}</span>
                  {/* Prose: break a word only when it would otherwise overflow, never mid-word by choice. */}
                  <span className="block break-words">{issue.message}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Errors and warnings must be distinguishable without reading, and not by colour alone. */
function Dot({ tone }: { tone: Issue['severity'] | 'clean' }): React.JSX.Element {
  const style =
    tone === 'error'
      ? 'bg-red-600'
      : tone === 'warning'
        ? 'bg-amber-500'
        : 'bg-emerald-600';
  const shape = tone === 'error' ? 'rounded-[2px]' : tone === 'warning' ? 'rotate-45' : 'rounded-full';
  return <span className={`inline-block h-2.5 w-2.5 ${shape} ${style}`} aria-hidden />;
}
