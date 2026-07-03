'use client';

import Link from 'next/link';

/**
 * The single Terms/Privacy agreement checkbox, shared by the onboarding account
 * step (Phase B) and the setup step (Phase C). Extracted so the legal line and
 * its links live in one place and can never drift into two divergent copies. The
 * policy pages open in a new tab so a parent doesn't lose their in-progress setup.
 */
export function TosAgreement({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-3 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.currentTarget.checked)}
        className="mt-1 h-4 w-4 cursor-pointer accent-spruce"
      />
      <span className="text-slate-green leading-relaxed">
        I agree to the{' '}
        <Link href="/terms" className="link" target="_blank" rel="noopener noreferrer">
          Terms of Service
        </Link>{' '}
        &amp;{' '}
        <Link href="/privacy" className="link" target="_blank" rel="noopener noreferrer">
          Privacy Policy
        </Link>
        .
      </span>
    </label>
  );
}
