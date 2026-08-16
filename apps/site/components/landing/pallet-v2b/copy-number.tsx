'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * The desktop path to the number, without ever printing the number.
 *
 * A laptop cannot open an `sms:` composer and cannot scan its own screen, so the
 * number still has to reach the phone — it reaches it through the clipboard or
 * the QR code beside this button, never as digits a reader (or a scraper) can
 * lift off the page. The label never changes shape enough to reflow the row.
 *
 * Variant-scoped on purpose: the shared component landing on main in
 * fix/landing-turtle-hide-number should replace this once it merges.
 */
export function CopyNumberButton({
  number,
  className = 'v2b-copy',
}: {
  number: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const copy = async () => {
    await navigator.clipboard.writeText(number);
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2400);
  };

  return (
    <button
      type="button"
      className={className}
      data-state={copied ? 'copied' : 'idle'}
      onClick={copy}
    >
      {copied ? 'Copied to your clipboard' : 'Copy my number'}
      <span aria-live="polite" className="sr-only">
        {copied ? 'Number copied to your clipboard.' : ''}
      </span>
    </button>
  );
}
