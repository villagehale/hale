'use client';

import { useState } from 'react';

/**
 * The founder's rule: the number itself is never displayed. The `sms:` button is
 * the way in on a phone; this chip is the desktop fallback — it puts the number
 * on the clipboard without printing it, so a Windows reader (where `sms:` is a
 * silent no-op) still has a way to text from their phone. The transient label
 * swap is the only feedback; no digits ever render.
 */
export function CopyNumberButton({
  number,
  className,
  label = 'Copy number',
  copiedLabel = 'copied — text me from your phone',
  ariaLabel = "Copy Hale's phone number to your clipboard",
}: {
  number: string;
  className?: string;
  label?: string;
  copiedLabel?: string;
  ariaLabel?: string;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      aria-label={ariaLabel}
      className={className}
      onClick={() => {
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
