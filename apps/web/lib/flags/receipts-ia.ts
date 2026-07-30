/**
 * D4/D20 · the receipts-room IA reframe (VIL-244 · M9). Dark by default: the app's
 * navigation, the demoted daily feed, the week view's multi-kid arrangement and the
 * sign-in ordering all stay byte-for-byte today's IA unless this reads exactly 'true'.
 *
 * STRICT equality on the literal, for the same reason the F14 nudge gate is strict
 * (lib/channel/nudge/run.ts): `vercel env add` fed from a piped `echo` stores a
 * TRAILING NEWLINE, so a value that prints as `true` is really `'true\n'`. A
 * truthiness check would read that as ON and reframe the whole app on a value
 * nobody armed.
 *
 * Server-read only: the name carries no NEXT_PUBLIC_ prefix, so it resolves to
 * undefined inside a client bundle. Read it in a Server Component and pass the
 * resolved boolean down as a prop — never call this from a 'use client' module, or
 * the server and client renders disagree.
 */
export const RECEIPTS_IA_ENV = 'F14_RECEIPTS_IA';

export function receiptsIaEnabled(): boolean {
  return process.env[RECEIPTS_IA_ENV] === 'true';
}
