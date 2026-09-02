'use client';

import { useState } from 'react';
import { useAnalytics } from '~/lib/analytics/posthog-provider';

/**
 * The founder's rule: the number itself is never displayed. The `sms:` button is
 * the way in on a phone; this chip is the desktop fallback — it puts the number
 * on the clipboard without printing it, so a Windows reader (where `sms:` is a
 * silent no-op) still has a way to text from their phone. The transient label
 * swap is the only feedback; no digits ever render.
 *
 * `copy_number_click` is captured on the INTENT, not on the clipboard write: a copy
 * that the browser denies still falls through to the composer, so the parent did the
 * same thing either way. The number is never a property — it is the one identifying
 * value on this component, and it is the one thing the desktop funnel does not need
 * to know (hard rule #1).
 *
 * `placement` mirrors LandingCta: one event, a `cta_placement` breakdown, and the
 * `data-cta` pair making the wiring visible in markup so the site-wide guard
 * (app/cta-wiring.test.ts) can pin every chip the way it pins every composer link.
 */
export function CopyNumberButton({
  number,
  placement,
  className,
  label = 'Copy number',
  copiedLabel = 'copied — text me from your phone',
  ariaLabel = "Copy Hale's phone number to your clipboard",
}: {
  number: string;
  /** Which chip this is — `hero`, `closing`, `text_entry`… See LandingCta. */
  placement?: string;
  className?: string;
  label?: string;
  copiedLabel?: string;
  ariaLabel?: string;
}) {
  const [copied, setCopied] = useState(false);
  const capture = useAnalytics();

  return (
    <button
      type="button"
      aria-label={ariaLabel}
      className={className}
      data-cta="copy_number_click"
      data-cta-placement={placement}
      onClick={() => {
        capture('copy_number_click', placement ? { cta_placement: placement } : {});
        navigator.clipboard
          .writeText(number)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          })
          .catch(() => {
            // Clipboard can be denied (permissions, insecure context). The chip
            // falling back to the composer keeps the action honest instead of
            // pretending the copy happened.
            window.location.href = `sms:${number}`;
          });
      }}
    >
      {copied ? copiedLabel : label}
    </button>
  );
}
