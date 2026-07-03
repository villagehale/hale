'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useAnalytics } from '~/lib/analytics/posthog-provider';

type State = 'idle' | 'pending' | 'sent' | 'error';

const LABEL: Record<State, string> = {
  idle: 'add to my week',
  pending: 'adding…',
  sent: 'sent for your approval',
  error: 'could not add — try again',
};

/**
 * Posts a village candidate's accept to /api/village/:id/accept. Honest about
 * what actually happens: accepting does NOT add the activity to the week — it
 * re-enters the pipeline as a draft the parent must approve (rule #4). So the
 * success state reads "sent for your approval" and links to /approvals, never
 * "added to your week". Pending while in flight, the error surfaced (never a
 * silent success). The worker drafts the routine action; this only hands off.
 *
 * `initiallyAccepted` seeds the "sent" state from SERVER data (a live, non-rejected
 * draft — listFamilyAcceptedCandidateIds) so a card the family already accepted
 * shows the sent state on load and survives the streamed feed remounting this
 * button — its optimistic local state alone would reset on every re-render.
 */
export function AcceptButton({
  href,
  initiallyAccepted = false,
}: {
  href: string;
  initiallyAccepted?: boolean;
}) {
  const [state, setState] = useState<State>(initiallyAccepted ? 'sent' : 'idle');
  const capture = useAnalytics();

  async function accept() {
    setState('pending');
    try {
      const res = await fetch(href, { method: 'POST' });
      const sent = res.status === 202;
      if (sent) {
        capture('add_to_week');
        capture('first_activity_added');
      }
      setState(sent ? 'sent' : 'error');
    } catch {
      setState('error');
    }
  }

  if (state === 'sent') {
    return (
      <p className="meta text-slate-green" aria-live="polite">
        sent for your approval —{' '}
        <Link href="/approvals" className="link">
          waiting for you
        </Link>
      </p>
    );
  }

  return (
    <button
      type="button"
      className="btn-primary"
      onClick={accept}
      disabled={state === 'pending'}
      aria-live="polite"
    >
      {LABEL[state]}
    </button>
  );
}
