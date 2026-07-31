'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * The email fallback CTA. A bare `mailto:` silently does nothing on any device
 * without a configured mail handler (most desktop browsers), so the address is
 * always visible beside a one-tap Copy — the mailto stays as the bonus path,
 * never the only one.
 */
export function EmailCta({
  email,
  buttonClassName,
  copyClassName = 'btn-secondary',
}: {
  email: string;
  buttonClassName: string;
  copyClassName?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <div className="flex flex-wrap items-center justify-center gap-3">
      <a href={`mailto:${email}`} className={buttonClassName}>
        Email me
      </a>
      <button
        type="button"
        className={copyClassName}
        aria-live="polite"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(email);
            setCopied(true);
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => setCopied(false), 2000);
          } catch {
            // Clipboard unavailable (permissions / insecure context): the visible
            // address stays selectable — nothing else to do.
          }
        }}
      >
        {copied ? 'Copied ✓' : `Copy ${email}`}
      </button>
    </div>
  );
}
