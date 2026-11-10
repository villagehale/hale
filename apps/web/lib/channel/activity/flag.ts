/**
 * VIL-423 · source-backed Finder binding. Off until the flag is exactly `true`.
 *
 * When off, the activity lane keeps main's pick path (`toPicks` against the pages
 * already opened). When on, each pick's age, schedule and price must quote the page
 * they were read from, unconfirmed finds stay references, and occurrence URLs stay
 * on the page that stated the date.
 *
 * STRICT equality on the literal `true`, for the same reason `f14Enabled` is:
 * `vercel env add` from a piped `echo` stores a trailing newline.
 */

export const FINDER_SOURCE_BINDING_ENABLED_ENV = 'FINDER_SOURCE_BINDING_ENABLED';

export function finderSourceBindingEnabled(): boolean {
  return process.env[FINDER_SOURCE_BINDING_ENABLED_ENV] === 'true';
}
