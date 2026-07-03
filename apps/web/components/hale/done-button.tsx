'use client';

import { Check } from 'lucide-react';
import { useState } from 'react';
import { markCompanionItemDone } from '~/lib/companion/log';
import type { MarkDoneInput, MarkDoneResult } from '~/lib/companion/log-types';

/**
 * Builds the mark-done server-action input for a curated companion item. A health
 * item carries its stable key so the read can flip that exact item; a milestone is
 * identified by its curated `what` alone. Pure + exported so the wiring is unit
 * tested without a DOM, and the two shapes can't drift from the schema.
 */
export function buildDoneInput(
  item:
    | { target: 'milestone'; childId: string; what: string }
    | { target: 'health'; childId: string; what: string; healthKey: string },
): MarkDoneInput {
  return item;
}

type State = 'idle' | 'pending' | 'done' | 'error';

const LABEL: Record<Exclude<State, 'done'>, string> = {
  idle: 'mark done',
  pending: 'saving…',
  error: 'couldn’t save — try again',
};

/** A sage "done" pill — the settled state, shown when the item is already marked
 * done (persisted) or right after a successful tap. */
function DonePill() {
  return (
    <span className="pill pill-sage">
      <Check size={14} strokeWidth={2.5} aria-hidden="true" />
      done
    </span>
  );
}

/**
 * The done affordance on a curated companion item (a milestone or a health
 * checkup). When the item is already done it renders a static sage pill. Otherwise
 * it is a button that marks the item done through the SAME episode write path a
 * quick-log uses (markCompanionItemDone) — a real audited write (rule #6), never a
 * cosmetic toggle. On success it flips to the pill; on a preview (no auth/db) it
 * stays honest and says nothing was saved.
 */
export function DoneButton({
  item,
  alreadyDone,
}: {
  item: Parameters<typeof buildDoneInput>[0];
  alreadyDone: boolean;
}) {
  const [state, setState] = useState<State>(alreadyDone ? 'done' : 'idle');
  const [preview, setPreview] = useState(false);

  if (state === 'done') return <DonePill />;

  async function mark() {
    if (state === 'pending') return;
    setPreview(false);
    setState('pending');
    const result: MarkDoneResult = await markCompanionItemDone(buildDoneInput(item));
    switch (result.status) {
      case 'done':
        setState('done');
        break;
      case 'preview':
        setState('idle');
        setPreview(true);
        break;
      default:
        setState('error');
    }
  }

  return (
    <span className="inline-flex items-center gap-3">
      <button
        type="button"
        className="pill pill-action pill-sage"
        onClick={mark}
        disabled={state === 'pending'}
        aria-live="polite"
      >
        <Check size={14} strokeWidth={2.5} aria-hidden="true" />
        {LABEL[state]}
      </button>
      {preview ? (
        <span className="meta italic text-slate-green">
          development preview — not saved.
        </span>
      ) : null}
    </span>
  );
}
