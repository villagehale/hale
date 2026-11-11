/**
 * VIL-337 · the watched-spots dark-launch gate, on its own.
 *
 * It lives here rather than in the sweep for the reason `f14.ts` was carved out of the
 * nudge sweep: TWO surfaces read it now. The sweep decides whether to poll, and the
 * arming verb (`spots/tool.ts`) decides whether to promise — and a coach tool that
 * imported `./sweep` for one boolean would drag the sweep's transport, its fetch port
 * and its whole module graph into every texted turn.
 */
import { isEnabled } from '@hale/flags';

export const WATCHED_SPOTS_ENABLED_ENV = 'WATCHED_SPOTS_ENABLED';

/**
 * STRICT equality on the literal 'true', for the reason `f14Enabled` is: `vercel env
 * add` from a piped `echo` stores a TRAILING NEWLINE, and a truthiness check would read
 * `'true\n'` as ON and start polling municipalities nobody armed.
 */
export function watchedSpotsEnabled(): boolean {
  return isEnabled('watched-spots');
}

/**
 * Watching a program page outside the PerfectMind registry, read by the model through
 * the live page reader (registration/class-availability.ts). Its own gate, under the one
 * above: with it off a link from any other site is refused at arming, and a live watch
 * on one is skipped unread by the sweep. Exact 'true', for the same reason.
 */
export const ANY_PAGE_SPOT_WATCH_ENABLED_ENV = 'ANY_PAGE_SPOT_WATCH_ENABLED';

export function anyPageSpotWatchEnabled(): boolean {
  return isEnabled('any-page-spot-watch');
}
