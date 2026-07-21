'use client';

import { Check, Link2 } from 'lucide-react';
import { useState } from 'react';

/**
 * "Share this age guide" — copies the canonical URL of the current age page to
 * the clipboard. The page itself is the shareable artifact; there is no
 * per-child state to leak because nothing was ever collected. Client-only so it
 * can read the live URL and use the clipboard.
 */
export function ShareAgeLink({ slug, ageLabel }: { slug: string; ageLabel: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    const url = `${window.location.origin}/milestones/${slug}`;
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <>
      <button
        type="button"
        onClick={copy}
        className="btn-secondary"
        aria-label={`Copy the link to the ${ageLabel} milestone guide`}
      >
        {copied ? (
          <Check size={16} strokeWidth={2.25} aria-hidden="true" />
        ) : (
          <Link2 size={16} strokeWidth={2.25} aria-hidden="true" />
        )}
        {copied ? 'Link copied' : 'Share this age guide'}
      </button>
      <output className="sr-only">{copied ? 'Link copied' : ''}</output>
    </>
  );
}
