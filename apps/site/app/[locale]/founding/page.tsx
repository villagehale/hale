import { ATTRIBUTION_KEYS } from '@hale/types';
import { redirect } from 'next/navigation';
import { APP_URL } from '~/lib/app-url';

interface PageProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * villagehale.com/founding → the app's ads join (OTP + Stripe). Keeps the
 * phone form on the same origin as Auth.js cookies. Forwards first-touch
 * click ids so AttributionCapture (a client effect) is not required on this
 * immediate server redirect.
 */
export default async function FoundingRedirectPage({ searchParams }: PageProps) {
  const search = (await searchParams) ?? {};
  const qs = new URLSearchParams();
  for (const key of ATTRIBUTION_KEYS) {
    const raw = search[key];
    const value = Array.isArray(raw) ? raw[0] : raw;
    const trimmed = value?.trim();
    if (trimmed) qs.set(key, trimmed);
  }
  const suffix = qs.size > 0 ? `?${qs.toString()}` : '';
  redirect(`${APP_URL.replace(/\/$/, '')}/founding${suffix}`);
}
