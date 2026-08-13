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
 * Read at render time. The homepage, its metadata, its share card and its JSON-LD
 * all resolve this on the server, and only one variant ships. The shared SiteHeader
 * is the one client reader — it is 'use client' for the scroll and menu state, and
 * its CTA has to follow the flag too (lib/site/chrome-cta.ts) or every subpage keeps
 * pointing at the signup funnel the F14 landing closed. That read is safe precisely
 * because of the NEXT_PUBLIC_ prefix: the value is inlined at build time, so the
 * browser gets the same literal the server did.
 */
export const F14_LANDING_ENV = 'NEXT_PUBLIC_F14_LANDING';

export function f14LandingEnabled(): boolean {
  return process.env[F14_LANDING_ENV] === 'true';
}
