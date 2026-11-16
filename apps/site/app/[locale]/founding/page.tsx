import { redirect } from 'next/navigation';
import { APP_URL } from '~/lib/app-url';

/**
 * villagehale.com/founding → the app's ads join (OTP + Stripe). Keeps the
 * phone form on the same origin as Auth.js cookies.
 */
export default function FoundingRedirectPage() {
  redirect(`${APP_URL.replace(/\/$/, '')}/founding`);
}
