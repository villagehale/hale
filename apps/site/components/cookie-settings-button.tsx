'use client';

import { CONSENT_OPEN_EVENT } from '~/lib/site/consent';

/** Reopens the consent banner. Styled like the other legal-row links. */
export function CookieSettingsButton({ label }: { label: string }) {
  return (
    <button
      type="button"
      className="text-[13px] text-slate-green underline decoration-rule underline-offset-[4px] transition-colors hover:text-spruce hover:decoration-current"
      onClick={() => window.dispatchEvent(new Event(CONSENT_OPEN_EVENT))}
    >
      {label}
    </button>
  );
}
