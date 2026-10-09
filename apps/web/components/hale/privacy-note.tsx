import { PRIVACY_URL } from '~/lib/legal-links';

/**
 * The one warm privacy line every colophon shares — plain language for a parent,
 * not a bare statute string. Links to the full policy so the acronyms live where
 * they belong (the Privacy page), not scattered across the app's footers.
 */
export function PrivacyNote() {
  return (
    <span className="meta">
      Never sold.{' '}
      <a href={PRIVACY_URL} className="link">
        Privacy policy
      </a>
    </span>
  );
}
