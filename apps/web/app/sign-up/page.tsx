import { redirect } from 'next/navigation';
import { MARKETING_SITE_URL } from '~/lib/legal-links';

/**
 * /sign-up is retired as a standalone door (founder decision 2026-07-21), and as of
 * F14 the onboarding wizard it used to forward into is retired too: a family born on
 * the web has no phone number, and Hale cannot run a week for a family it cannot
 * text. Joining therefore starts on the marketing site, which says so.
 *
 * The route stays as a redirect so old links, bookmarks and campaign URLs keep
 * working. Returning parents use /sign-in.
 */
export default function SignUpPage() {
  redirect(MARKETING_SITE_URL);
}
