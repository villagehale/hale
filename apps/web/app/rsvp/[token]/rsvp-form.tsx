'use client';

import { useState } from 'react';
import { JOIN_HREF } from '~/components/hale/public-surface';
import { useAnalytics } from '~/lib/analytics/posthog-provider';
import { GUEST_SOFT_CTA, GUEST_SOFT_LINE } from '~/lib/party/guest-copy';
import type { RsvpResponse } from '~/lib/party/tally';

/**
 * VIL-245 · M10 — the guest's half of the page.
 *
 * FOUR FIELDS, AND THE FOURTH IS OPTIONAL. A name, an answer, how many are coming, and
 * — only if they want it — a number for a day-before reminder. There is no email field,
 * no account, no password, and no "create a profile to RSVP": a guest is a stranger
 * doing a host a favour, and every field past the headcount is a field that makes fewer
 * people answer.
 *
 * THE REMINDER BOX IS UNCHECKED AND SAYS EXACTLY WHAT IT DOES. CASL express consent
 * needs the person to know what they are agreeing to receive and from whom, so the
 * label states the sender, the single message, and the way out — before the number
 * field appears at all. Unticking it is not a "no thanks" flow; it is the default.
 *
 * THE ONE SOFT LINE lives on the CONFIRMATION only, below the fold of what they came
 * to do. It is not on the invite, not in the reminder, and never in a message Hale
 * sends them.
 */

const ANSWERS: ReadonlyArray<{ value: RsvpResponse; label: string }> = [
  { value: 'yes', label: "I'll be there" },
  { value: 'maybe', label: 'Maybe' },
  { value: 'no', label: "Can't make it" },
];

type FieldError = 'name' | 'headcount' | 'phone' | null;

export function RsvpForm({ token }: { token: string }) {
  const capture = useAnalytics();
  const [answer, setAnswer] = useState<RsvpResponse | null>(null);
  const [name, setName] = useState('');
  const [headcount, setHeadcount] = useState(1);
  const [wantsReminder, setWantsReminder] = useState(false);
  const [phone, setPhone] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [fieldError, setFieldError] = useState<FieldError>(null);
  const [failed, setFailed] = useState(false);
  const [done, setDone] = useState<{ answer: RsvpResponse; reminderOptIn: boolean } | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (answer === null || submitting) return;
    setSubmitting(true);
    setFieldError(null);
    setFailed(false);

    try {
      const response = await fetch(`/api/rsvp/${token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          displayName: name,
          response: answer,
          headcount: answer === 'no' ? 1 : headcount,
          reminderPhone: wantsReminder && answer !== 'no' ? phone : null,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        field?: FieldError;
      };
      if (!response.ok) {
        // A field the guest can fix is named; anything else is an honest "try again"
        // rather than a success screen for a submission that did not land.
        if (payload.field) setFieldError(payload.field);
        else setFailed(true);
        return;
      }
      setDone({ answer, reminderOptIn: wantsReminder && answer !== 'no' });
    } catch {
      setFailed(true);
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <section className="space-y-6" aria-live="polite">
        <div className="panel p-6 lg:p-8 space-y-3">
          <h2 className="font-display text-[1.5rem] lg:text-[2rem] text-spruce">
            {done.answer === 'no' ? 'Thanks for letting them know.' : "You're on the list."}
          </h2>
          <p className="text-lg text-slate-green leading-relaxed">
            {done.answer === 'no'
              ? 'The host has your reply.'
              : `The host can see that ${headcount === 1 ? "you're" : `${headcount} of you are`} coming.`}
          </p>
          {done.reminderOptIn ? (
            <p className="text-slate-green leading-relaxed">
              I'll text you once, the day before. Reply STOP any time.
            </p>
          ) : null}
        </div>

        {/* The one soft line. Once, here, and nowhere else. */}
        <p className="meta text-faded-sage">
          {GUEST_SOFT_LINE}{' '}
          <a
            href={JOIN_HREF}
            className="underline underline-offset-2"
            onClick={() => capture('rsvp_guest_cta')}
          >
            {GUEST_SOFT_CTA}
          </a>
          .
        </p>
      </section>
    );
  }

  return (
    <form onSubmit={submit} className="panel p-6 lg:p-8 space-y-6">
      <fieldset className="space-y-3">
        <legend className="font-display text-[1.35rem] text-spruce">Can you make it?</legend>
        <div className="flex flex-wrap gap-2">
          {ANSWERS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setAnswer(option.value)}
              aria-pressed={answer === option.value}
              className={answer === option.value ? 'btn-primary' : 'btn-secondary'}
            >
              {option.label}
            </button>
          ))}
        </div>
      </fieldset>

      <label className="field-group">
        <span className="field-label">your name</span>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
          autoComplete="name"
          required
          className="field w-full"
        />
        {fieldError === 'name' ? (
          <span className="field-error">Please add the name the host will recognise.</span>
        ) : null}
      </label>

      {answer !== 'no' ? (
        <label className="field-group">
          <span className="field-label">how many of you</span>
          <input
            type="number"
            min={1}
            max={20}
            value={headcount}
            onChange={(e) => setHeadcount(Number(e.target.value))}
            className="field w-24"
          />
          {fieldError === 'headcount' ? (
            <span className="field-error">Somewhere between 1 and 20.</span>
          ) : null}
        </label>
      ) : null}

      {answer !== 'no' ? (
        <div className="space-y-3">
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={wantsReminder}
              onChange={(e) => setWantsReminder(e.target.checked)}
              className="mt-1"
            />
            <span className="text-slate-green leading-relaxed">
              Text me a reminder the day before. One message from Hale about this party
              only — reply STOP any time. Your number isn't stored unless you tick this.
            </span>
          </label>
          {wantsReminder ? (
            <label className="field-group">
              <span className="field-label">mobile number</span>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                autoComplete="tel"
                required
                className="field w-full"
              />
              {fieldError === 'phone' ? (
                <span className="field-error">
                  That doesn't look like a mobile number — check it and try again.
                </span>
              ) : null}
            </label>
          ) : null}
        </div>
      ) : null}

      {failed ? (
        <p className="field-error" role="alert">
          That didn't go through. Please try again.
        </p>
      ) : null}

      <button type="submit" disabled={answer === null || submitting} className="btn-primary">
        {submitting ? 'sending…' : 'send my RSVP'}
      </button>
    </form>
  );
}
