'use client';

import { useState } from 'react';

type State = 'idle' | 'confirming' | 'pending' | 'scheduled' | 'departed' | 'ambiguous' | 'error';

/**
 * The seat the viewer holds, which decides WHAT this button asks them to consent to.
 * `scoped` is every named caregiver role: they have no erasure of their own, the route
 * answers them 403, and offering the button anyway would be an offer Hale cannot keep.
 */
export type DeleteAccountRole = 'primary_parent' | 'co_parent' | 'scoped';

/**
 * Requests erasure (PIPEDA/Law 25 right-to-erasure). Confirm-gated: the first click
 * reveals the real scope and only the explicit confirm posts {confirm:true} to
 * /api/rights/delete.
 *
 * THE CONFIRM COPY IS ROLE-SPECIFIC, AND THAT IS THE WHOLE POINT (VIL-355). A
 * co-parent's request is a DEPARTURE — immediate, no grace window, their thread and
 * their identifier retained, the household's record untouched. Telling them instead
 * that "this removes everything Hale holds about your family — your children, your
 * history" and labelling the button "yes, delete my account" would take consent for an
 * act that does not occur, on the one request where consent honesty is the entire
 * obligation (rule #1). The answer afterwards was already role-aware; the ASK has to be,
 * because that is the moment they decide.
 *
 * Honest states throughout: pending in flight, the scheduled date on a family 202, the
 * departure tally's sentence on a co-parent 202, the 409 asking which household, and
 * the error surfaced rather than swallowed.
 */
export function DeleteAccountButton({ role }: { role: DeleteAccountRole }) {
  const [state, setState] = useState<State>('idle');
  const [scheduledFor, setScheduledFor] = useState<string | null>(null);
  const leaving = role === 'co_parent';

  async function confirmDelete() {
    setState('pending');
    try {
      const res = await fetch('/api/rights/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      });
      if (res.status === 409) {
        setState('ambiguous');
        return;
      }
      if (res.status !== 202) {
        setState('error');
        return;
      }
      const body = (await res.json()) as { status?: string; scheduledDeletionAt?: string };
      if (body.status === 'departed') {
        setState('departed');
        return;
      }
      setScheduledFor(body.scheduledDeletionAt ?? null);
      setState('scheduled');
    } catch {
      setState('error');
    }
  }

  // A scoped seat is not an owner: the household's record is not theirs to erase, and
  // the door that would refuse them is better not shown than shown and refused.
  if (role === 'scoped') {
    return (
      <p className="meta text-slate-green">
        this family’s record belongs to its parents, so there’s nothing here for you to delete. to
        ask what Hale holds about you, email{' '}
        <a className="link" href="mailto:privacy@villagehale.com">
          privacy@villagehale.com
        </a>
        .
      </p>
    );
  }

  if (state === 'departed') {
    return (
      <p className="meta text-slate-green" aria-live="polite">
        you’ve left this family. hale won’t text you about them again, and the family’s own record
        stays with them.
      </p>
    );
  }

  // Two households, one click, two different irreversible acts — so nothing happens
  // until a person says which one they meant.
  if (state === 'ambiguous') {
    return (
      <p className="meta text-slate-green" aria-live="polite">
        you’re part of more than one family, so nothing was changed. email{' '}
        <a className="link" href="mailto:privacy@villagehale.com">
          privacy@villagehale.com
        </a>{' '}
        and say which one you mean.
      </p>
    );
  }

  if (state === 'scheduled') {
    const when = scheduledFor
      ? new Date(scheduledFor).toLocaleDateString(undefined, {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
        })
      : null;
    return (
      <p className="meta text-slate-green" aria-live="polite">
        {when
          ? `deletion scheduled for ${when}. contact us before then to cancel.`
          : 'deletion scheduled. contact us before it completes to cancel.'}
      </p>
    );
  }

  if (state === 'confirming' || state === 'pending' || state === 'error') {
    return (
      <div className="flex flex-col gap-y-3" aria-live="polite">
        <p className="text-spruce leading-relaxed max-w-md">
          {leaving ? (
            <>
              You’ll leave this family <strong>right away</strong> — Hale will stop texting you
              about them, and every app you connected is disconnected. The family’s own record stays
              with them, and so does your side of the conversation and the number you texted from,
              which is the proof you agreed to be texted.
            </>
          ) : (
            <>
              This removes <strong>everything</strong> Hale holds about your family — your children,
              your history, and every connected service. Deletion begins after a grace period, so
              you can still change your mind. This can&rsquo;t be undone once it completes.
            </>
          )}
        </p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <button
            type="button"
            className="btn-secondary"
            onClick={confirmDelete}
            disabled={state === 'pending'}
          >
            {state === 'pending'
              ? leaving
                ? 'leaving…'
                : 'scheduling…'
              : leaving
                ? 'yes, leave this family'
                : 'yes, delete my account'}
          </button>
          <button
            type="button"
            className="link"
            onClick={() => setState('idle')}
            disabled={state === 'pending'}
          >
            {leaving ? 'stay in this family' : 'keep my account'}
          </button>
        </div>
        {state === 'error' ? (
          <p className="meta text-berry">
            {leaving ? 'could not leave — try again.' : 'could not schedule deletion — try again.'}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <button type="button" className="link text-berry" onClick={() => setState('confirming')}>
      {leaving ? 'leave this family' : 'delete my account'}
    </button>
  );
}
