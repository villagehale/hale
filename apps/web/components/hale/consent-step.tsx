'use client';

import Link from 'next/link';
import { Check } from 'lucide-react';

/**
 * "You're in control" — the consent moment as a designed screen (mockup 12), the
 * three standing promises made plain before anything is provisioned. Its "Agree &
 * continue" drives the EXISTING tosAccepted submission (same ordering as today:
 * consent before provisioning) — it does not add a second consent record or weaken
 * the ToS semantics. The Terms/Privacy links are the same policy anchors as the
 * shared TosAgreement row, so accepting here is accepting them.
 */

const PROMISES = [
  {
    title: 'Your data is stored in Canada.',
    body: 'Your family’s data is stored in Canada — AI processing runs with our US-based provider, exactly as the Privacy Policy describes. Built to PIPEDA and Quebec Law 25.',
  },
  {
    title: 'Nothing acts without your approval.',
    body: 'Hale observes and suggests. No message is sent, no booking is made, until you say so.',
  },
  {
    title: "A teen’s privacy is held.",
    body: 'For children 13 and older, raw content stays private by default — only a category or summary is surfaced, unless you’re explicitly granted access — or in a safety emergency, where your teen is told.',
  },
] as const;

export function ConsentStep({
  onAgree,
  onBack,
  saving,
}: {
  /** Called when the parent agrees — the caller sets tosAccepted and advances,
   * exactly as the ToS checkbox did. */
  onAgree: () => void;
  /** Back to the setup form — a wrong DOB spotted at the consent moment must be
   * fixable without a reload (which drops the parent to Phase A). */
  onBack?: () => void;
  /** True while completeOnboarding is in flight — disables the button so a
   * double-click can't fire a second provisioning (which would append duplicate
   * consent_records and audit rows). */
  saving: boolean;
}) {
  return (
    <section className="rise rise-1 space-y-10 max-w-2xl">
      <p className="text-lg text-slate-green leading-relaxed">
        Before I start, here&rsquo;s what stays true — every day, not just today.
      </p>

      <ul className="space-y-6">
        {PROMISES.map((promise) => (
          <li key={promise.title} className="flex gap-4">
            <span
              aria-hidden="true"
              className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-sage-tint text-sage"
            >
              <Check size={16} strokeWidth={2.5} />
            </span>
            <div>
              <p className="text-spruce font-medium leading-snug">{promise.title}</p>
              <p className="meta mt-1 text-slate-green leading-relaxed">{promise.body}</p>
            </div>
          </li>
        ))}
      </ul>

      <p className="meta">
        Agreeing accepts the{' '}
        <Link href="/terms" className="link" target="_blank" rel="noopener noreferrer">
          Terms of Service
        </Link>{' '}
        &amp;{' '}
        <Link href="/privacy" className="link" target="_blank" rel="noopener noreferrer">
          Privacy Policy
        </Link>
        .
      </p>

      <div className="flex flex-wrap items-center gap-5 pt-2">
        {onBack ? (
          <button type="button" className="btn-ghost" onClick={onBack} disabled={saving}>
            &larr; back
          </button>
        ) : null}
        <button
          type="button"
          className="btn-primary ml-auto"
          onClick={onAgree}
          disabled={saving}
        >
          {saving ? 'finishing…' : 'Agree & continue →'}
        </button>
      </div>
    </section>
  );
}
