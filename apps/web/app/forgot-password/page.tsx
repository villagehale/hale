import { permanentRedirect } from 'next/navigation';

/**
 * Retired email door. The middleware 308s first and drops any query. This page
 * is the second gate, so the form cannot render if that rule is bypassed.
 */
export default function Page(): never {
  permanentRedirect('/sign-in');
}
