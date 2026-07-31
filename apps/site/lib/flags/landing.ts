/**
 * D20/D21 · the persona-led landing pivot (VIL-250 · M14). Dark by default: the
 * homepage stays byte-for-byte today's village landing unless this reads exactly
 * 'true'. Both variants live in the repo until the removal PR after the flip.
 *
 * STRICT equality on the literal, matching the app-side receipts gate
 * (apps/web/lib/flags/receipts-ia.ts): `vercel env add` fed from a piped `echo`
 * stores a TRAILING NEWLINE, so a value that prints as `true` is really
 * `'true\n'`. A truthiness check would repoint the whole homepage on a value
 * nobody armed.
 *
 * Read in a Server Component at render time — never from a 'use client' module.
 * The NEXT_PUBLIC_ prefix is the site's convention for build-time-visible flags
 * (NEXT_PUBLIC_SHOW_TESTIMONIALS), but nothing here needs the value in the
 * browser: the branch is resolved on the server and only one variant ships.
 */
export const F14_LANDING_ENV = 'NEXT_PUBLIC_F14_LANDING';

export function f14LandingEnabled(): boolean {
  return process.env[F14_LANDING_ENV] === 'true';
}
