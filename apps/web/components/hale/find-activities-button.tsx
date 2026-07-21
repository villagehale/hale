'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { type FindActivitiesResult, findActivitiesAction } from '~/lib/village/discover-action';

type Message = {
  tone: 'note' | 'error';
  text: string;
  /** An optional inline link appended after the text (e.g. to the family page
   * where the area is set) — so first-run guidance points at the real editor. */
  link?: { href: string; label: string };
};

/**
 * Triggers on-demand village discovery via the findActivitiesAction Server
 * Action. Calm and honest: a pending state while the model gathers, the outcome
 * surfaced in place (never a silent success). On a successful discovery the
 * action revalidates /village, so the page re-renders with the new candidates;
 * the empty/edge outcomes are explained in plain words rather than swallowed.
 *
 * `variant`/`label` let the same re-runnable action read as the primary CTA on
 * an empty surface and as a quiet "find more near you" at the foot of a
 * populated feed — one entry point, so discovery is never a one-shot.
 */
export function FindActivitiesButton({
  variant = 'primary',
  label = 'find activities near you',
}: {
  variant?: 'primary' | 'secondary';
  label?: string;
}) {
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
          text: 'tell Hale where you are — add your area on the family page and Hale can gather what is near you.',
          link: { href: '/family/members', label: 'add your area' },
        };
      case 'no_non_teen_children':
        return {
          tone: 'note',
          text: 'add a child under thirteen and Hale can gather activities to suit their age.',
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
        className={variant === 'secondary' ? 'btn-secondary' : 'btn-primary'}
        onClick={find}
        disabled={pending}
        aria-live="polite"
      >
        {pending ? 'gathering near you…' : label}
      </button>
      {message ? (
        <p
          className={message.tone === 'error' ? 'meta italic text-berry' : 'meta text-slate-green'}
          role={message.tone === 'error' ? 'alert' : undefined}
        >
          {message.text}
          {message.link ? (
            <>
              {' '}
              <Link href={message.link.href} className="link">
                {message.link.label}
              </Link>
            </>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
