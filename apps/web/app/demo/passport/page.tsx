import { notFound, redirect } from 'next/navigation';
import { interestPassportDemo } from '~/lib/passport/demo';

// The gate reads VERCEL_ENV at request time. A build must not freeze it on.
export const dynamic = 'force-dynamic';

/**
 * Preview-only door to the Mia and Leo passport. No session and no database.
 * Anywhere else, including production, this is a 404.
 */
export default function DemoPassportPage() {
  if (!interestPassportDemo()) notFound();
  redirect('/family');
}
