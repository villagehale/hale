'use client';

import { useState, useTransition } from 'react';
import { type FindActivitiesResult, findActivitiesAction } from '~/lib/village/discover-action';

type Message = { tone: 'note' | 'error'; text: string };

/**
 * Triggers on-demand village discovery via the findActivitiesAction Server
 * Action. Calm and honest: a pending state while the model gathers, the outcome
 * surfaced in place (never a silent success). On a successful discovery the
 * action revalidates /village, so the page re-renders with the new candidates;
 * the empty/edge outcomes are explained in plain words rather than swallowed.
 */
export function FindActivitiesButton() {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<Message | null>(null);

  function messageFor(result: FindActivitiesResult): Message | null {
    switch (result.status) {
      case 'discovered':
        return result.insertedCount === 0
          ? { tone: 'note', text: 'nothing solid to gather near you this week — try again later.' }
          : null;
      case 'no_area':
        return {
          tone: 'note',
          text: 'tell me your coarse area first (in settings) and i can gather what is near you.',
        };
      case 'no_non_teen_children':
        return {
          tone: 'note',
          text: 'add a child under thirteen and i can gather stage-appropriate activities.',
        };
      case 'no_family':
        return { tone: 'note', text: 'finish setting up your family first.' };
      case 'unauthenticated':
        return { tone: 'note', text: 'sign in to gather activities near you.' };
      default:
        return null;
    }
  }

  function find() {
    setMessage(null);
    startTransition(async () => {
      try {
        const result = await findActivitiesAction();
        setMessage(messageFor(result));
      } catch {
        setMessage({ tone: 'error', text: 'could not gather activities — please try again.' });
      }
    });
  }

  return (
    <div className="flex flex-col items-center gap-3">
      <button
        type="button"
        className="btn-primary"
        onClick={find}
        disabled={pending}
        aria-live="polite"
      >
        {pending ? 'gathering near you…' : 'find activities near you'}
      </button>
      {message ? (
        <p
          className={message.tone === 'error' ? 'meta italic text-apricot-deep' : 'meta text-slate-green'}
          role={message.tone === 'error' ? 'alert' : undefined}
        >
          {message.text}
        </p>
      ) : null}
    </div>
  );
}
