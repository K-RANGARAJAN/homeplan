'use client';

/**
 * components/editor/WallLength.tsx — typing a wall's exact length.
 *
 * This is the feature that makes the tool a MEASURING INSTRUMENT rather than a sketchpad. The eval
 * harness needs thirty real Indian flats with hand-measured walls as its answer key, and this field
 * is how that truth gets recorded. Everything else in the editor can be approximate; this cannot.
 *
 * WHAT MOVES, and why it is stated in the UI rather than only in a comment. Corners are shared, so
 * moving one drags every wall attached to it — that is the point of the design and it is also what
 * makes retyping a length dangerous. The default is `chooseMovingEnd`: the end with FEWER other
 * walls attached moves, because that is the end whose movement disturbs least, with ties going to
 * `b`. The user can flip it, and either way the plan draws a ghost of the change before it is
 * committed. A length field that silently shoves half a flat sideways is how this feature earns a
 * reputation for being possessed.
 */

import { useEffect, useState } from 'react';

import {
  chooseMovingEnd,
  MAX_SENSIBLE_WALL_LENGTH_MM,
  planLengthChange,
  type LengthChange,
  type LengthFailure,
  type LengthOutcome,
  type WallEnd,
} from '@/lib/geometry/edit';
import { indexNodes, wallLengthMm } from '@/lib/geometry/pick';
import type { Level, Wall } from '@/lib/plan/schema';
import { currentLevel, usePlanStore } from '@/lib/plan/store';

/** Only one length field exists at a time — the wrapper renders at most one wall — so a fixed id is safe. */
const ERROR_ID = 'wall-length-error';

export function WallLength(): React.JSX.Element | null {
  const doc = usePlanStore((state) => state.doc);
  const selection = usePlanStore((state) => state.selection);

  const level = currentLevel(doc);
  const selected = selection.length === 1 && selection[0].kind === 'wall' ? selection[0].id : null;
  const wall = selected === null ? null : (level.walls.find((w) => w.id === selected) ?? null);
  const currentMm = wall === null ? null : wallLengthMm(indexNodes(level.nodes), wall);

  if (wall === null || currentMm === null) return null;

  // KEYED ON THE WALL, so selecting a different one remounts the field with that wall's length and
  // its own default moving end. Resetting the state from an effect instead would leave a window in
  // which the field shows one wall's measurement while another is selected — and it is a
  // measurement, so showing it against the wrong wall is the worst thing this component could do.
  return <Field key={wall.id} wall={wall} level={level} currentMm={currentMm} />;
}

function Field({
  wall,
  level,
  currentMm,
}: {
  wall: Wall;
  level: Level;
  currentMm: number;
}): React.JSX.Element {
  const setLengthPreview = usePlanStore((state) => state.setLengthPreview);
  const [typed, setTyped] = useState(() => String(currentMm));
  const [moving, setMoving] = useState<WallEnd>(() => chooseMovingEnd(level, wall));

  const requested = Number.parseInt(typed, 10);
  // An empty or half-typed field is not a mistake to shout about — someone clearing the box on the
  // way to a new number should not be told off for it. A number that IS there and is wrong,
  // including zero and negatives, goes to `planLengthChange` and comes back refused, because being
  // refused with a reason is the whole point. The one number that is neither is the length the wall
  // already has: nothing to do, nothing to say.
  const outcome: LengthOutcome | null =
    !Number.isFinite(requested) || requested === currentMm
      ? null
      : planLengthChange(level, wall.id, requested, moving);
  const change = outcome !== null && outcome.ok ? outcome.change : null;
  const refusal = outcome !== null && !outcome.ok ? refuse(outcome, requested) : null;

  // The plan draws the ghost, and this component does not own the plan — so the preview goes through
  // the store. Synchronising an external system is what an effect is actually for.
  useEffect(() => {
    setLengthPreview(change);
    return () => setLengthPreview(null);
  }, [change, setLengthPreview]);

  const warnings = change === null ? [] : warn(change);

  const commit = (): void => {
    if (change === null) return;
    usePlanStore.getState().setWallLength(wall.id, requested, moving);
    usePlanStore.getState().setLengthPreview(null);
  };

  return (
    <div className="flex flex-col gap-2 border-t border-black/10 p-3 text-sm dark:border-white/10">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs opacity-60">{wall.id}</span>
        <label className="flex items-center gap-2">
          <span className="sr-only">Wall length in millimetres</span>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_SENSIBLE_WALL_LENGTH_MM}
            step={1}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commit();
            }}
            aria-invalid={refusal !== null}
            aria-describedby={refusal === null ? undefined : ERROR_ID}
            /*
              Wide enough to READ a wrong number, not just a right one. Under the 50m cap a real
              length is at most five digits and would fit in half this, but the entry that most needs
              looking at is the one with four extra zeros in it — and a field that hides the mistake
              the user is trying to find is the one place width actually matters. Left-aligned rather
              than right, so an over-long value shows its beginning, which is the part that tells you
              how badly it is wrong.
            */
            className={`h-11 w-44 rounded-lg border px-2 font-mono ${
              refusal === null
                ? 'border-black/15 dark:border-white/20'
                : 'border-red-600 bg-red-50 text-red-900'
            }`}
          />
          <span className="opacity-60">mm</span>
        </label>
        <button
          type="button"
          onClick={commit}
          disabled={change === null}
          className="h-11 rounded-lg border border-blue-600 bg-blue-600 px-3 font-medium text-white disabled:opacity-40"
        >
          Apply
        </button>

        <span className="ml-auto flex items-center gap-2">
          <span className="opacity-60">Move end</span>
          <span className="flex overflow-hidden rounded-lg border border-black/15 dark:border-white/20">
            {(['a', 'b'] as const).map((end) => (
              <button
                key={end}
                type="button"
                aria-pressed={moving === end}
                onClick={() => setMoving(end)}
                className={`h-11 w-20 font-mono text-sm ${
                  moving === end ? 'bg-blue-600 text-white' : 'hover:bg-black/5 dark:hover:bg-white/10'
                }`}
              >
                {end === 'a' ? wall.a : wall.b}
              </button>
            ))}
          </span>
        </span>
      </div>

      {refusal === null ? (
        <p className="text-xs text-black/60 dark:text-white/60">
          {change === null
            ? `This wall is ${currentMm}mm. Type a length; the corner shown will slide along the wall to make it exact.`
            : describe(change.node, change.followers.length, change.achievedLengthMm, requested)}
        </p>
      ) : (
        <p
          id={ERROR_ID}
          role="alert"
          className="rounded-lg border border-red-600/50 bg-red-50 px-3 py-2 text-xs text-red-900"
        >
          {refusal}
        </p>
      )}

      {/*
        Said BEFORE the change, not after. `validate` would report both of these the moment they
        happened, but by then the user has watched a wall vanish, or nothing visible at all in the
        case of a 3mm gap, and has to go and read a panel somewhere else to find out why. A warning
        that only arrives after the fact is not what previewing is for.

        ONE BLOCK, not one per kind: two stacked amber panels under a length field read as an editor
        that is unhappy about everything, which is the fastest way to teach someone to stop reading.
      */}
      {warnings.length > 0 && (
        <div className="rounded-lg border border-amber-500/50 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          {warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
          <p className="mt-1 opacity-80">
            You can still apply this. Moving the other end instead usually avoids it.
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * Why the length was refused, in plain language with the real numbers.
 *
 * A refusal, not a warning, so it is red and it disables Apply — unlike the amber block below it,
 * which describes something the user is allowed to go ahead and do. The distinction has to be
 * visible: an editor where "careful" and "no" look the same teaches you to ignore both.
 */
function refuse(outcome: LengthFailure, requestedMm: number): string | null {
  if (outcome.reason === 'not-positive') {
    return 'A wall has to be longer than nothing. Type a length in millimetres.';
  }
  if (outcome.reason === 'too-long') {
    const cap = `The longest wall this will accept is ${group(outcome.maxMm)}mm (${scaled(outcome.maxMm)}) — longer than any wall in any flat, so a bigger number is a slipped finger rather than a room.`;
    // The typed value is only translated when its digits have stopped meaning anything. Just over
    // the cap the millimetre figure reads perfectly well, and "50,001mm is 50 m" would look like a
    // contradiction of the very limit being quoted.
    return requestedMm >= outcome.maxMm * 10
      ? `${group(requestedMm)}mm is ${scaled(requestedMm)}. ${cap}`
      : `${group(requestedMm)}mm is too long. ${cap}`;
  }
  // `no-such-wall` and `unmeasurable` cannot happen here: this component only renders for a wall it
  // has already measured. Saying nothing beats inventing a message for an unreachable state.
  return null;
}

/**
 * Thousands separators, fixed at three digits.
 *
 * Deliberately not `toLocaleString()`: that follows the browser's locale, which groups Indian numbers
 * as 1,40,00,00,000, and would also differ between the server render and the client one. Construction
 * drawings group in threes everywhere, including India, and this is a dimension.
 */
function group(value: number): string {
  const [whole, fraction] = Math.abs(value).toString().split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

/**
 * The same number at a scale a person can picture. Separators alone do not make 140,000,000,000 real.
 *
 * One decimal place, kept rather than rounded away, because 1,500,000mm reported as "2 km" would be a
 * measuring instrument lying about a measurement — even about one it is in the middle of refusing.
 */
function scaled(mm: number): string {
  const metres = mm / 1000;
  const round1 = (n: number): number => Math.round(n * 10) / 10;
  return metres >= 1000 ? `${group(round1(metres / 1000))} km` : `${group(round1(metres))} m`;
}

/**
 * What `validate` would say afterwards, said beforehand instead.
 *
 * Deliberately NOT every issue the change could cause. `WALL_TOO_SHORT` — under 100mm — is not
 * warned about, because someone typing 90mm into a length field usually means 90mm, and a warning
 * that fires on a deliberate act is exactly how people are trained to dismiss warnings unread. That
 * would cost us the two below, which are cases the user genuinely did not intend.
 */
function warn(change: LengthChange): string[] {
  const messages: string[] = [];

  if (change.collapsing.length === 1) {
    messages.push(
      `Wall ${change.collapsing[0]} would be left with no length at all — its far corner is already at that point.`,
    );
  } else if (change.collapsing.length > 1) {
    messages.push(
      `Walls ${change.collapsing.join(', ')} would be left with no length at all — their far corners are already at that point.`,
    );
  }

  for (const near of change.nearlyCoincident) {
    messages.push(
      `Corner ${near.node} would be only ${near.distanceMm}mm away. That reads as one corner drawn twice: too close to see in the plan, and a hairline gap where the walls fail to meet in 3D.`,
    );
  }

  return messages;
}

/** Said in plain language, with the real numbers — including the length actually achievable. */
function describe(node: string, followers: number, achievedMm: number, requestedMm: number): string {
  const rounding =
    achievedMm === requestedMm
      ? ''
      : ` The nearest whole millimetre this wall can reach on its current angle is ${achievedMm}mm.`;
  const dragged =
    followers === 0
      ? ' Nothing else is attached to it.'
      : ` ${followers} other ${followers === 1 ? 'wall follows' : 'walls follow'} it.`;
  return `Corner ${node} moves.${dragged}${rounding}`;
}
