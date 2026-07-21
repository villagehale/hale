import { redirect } from 'next/navigation';

/**
 * /sign-up is retired as a standalone door (founder decision 2026-07-21): every
 * join-intent path runs through the public onboarding wizard, which asks for the
 * account at step 6 ("Save your village") — one funnel, no second entrance. The
 * route stays as a redirect so old links, bookmarks, and campaign URLs keep
 * working. Returning parents use /sign-in.
 */
export default function SignUpPage() {
  redirect('/onboarding');
}
