import type { ActivityFinder } from '~/lib/channel/activity/lane';

/**
 * VIL-313 · ONE BOUNDED LOOK AT THE LIVE WEB, from a call.
 *
 * WHAT IT REPLACES. Founder call CA170c1fb0: the parent asked, out loud and explicitly,
 * for Hale to search. The answer was "nothing verified in my list" — not because the web
 * said nothing, but because relay-deps.ts passed `activity: null` and the call had no
 * verb that could reach it. A surface whose whole promise is "I answer" answering an
 * explicit search request with a read of a table it already knew was empty.
 *
 * WHY THE SAME LANE AND NOT A SECOND ONE. `find_activities` already is the site-scoped
 * search-then-fetch: phase 0 de-identifies (deidentify.ts), the grounding turn searches
 * and — where the parent named a place — OPENS its pages, and `readEvidence` counts what
 * was actually read rather than what was skimmed (evidence.ts). A voice-only searcher
 * would be a second implementation of the one thing in this codebase that must not have
 * two: the border every family fact crosses. So the call gets the lane, and what it adds
 * is the only thing a call needs that a text does not — a wall.
 *
 * THE WALL IS A CEILING ON SILENCE, NOT A PREDICTION THAT THE SEARCH FITS. The inline
 * lane's own measurements are 16-23 seconds for a grounding turn and roughly 52 with
 * fetches (lane.ts, `MAX_INLINE_FETCHES`), so most calls will hit
 * {@link VOICE_LOOKUP_BUDGET_MS} and come back `over_budget`. That is the DESIGNED common
 * path rather than a failure of it, and it is only honest because of the other half of
 * this ticket: the fallback sentence is "I'll text you what I find", and a sentence like
 * that is now a row on the open-loops ledger that the hourly sweep pays as a real SMS
 * (voice-promise.ts). The parent gets the answer — by text, in the hour — instead of
 * getting "nothing in my list" and nothing else, forever.
 */

/**
 * How long a caller may hold a silent line for one live lookup.
 *
 * SIX SECONDS. It is not a guess at how long a search takes; it is how long a person will
 * wait after being told Hale is looking, and it is the same order as the eight seconds
 * {@link VOICE_CLIENT_OPTIONS} gives the turn's own model call for the same reason. Past
 * it the caller has stopped believing the line is live, and every further second is spent
 * on a worse version of an answer they could have had by text.
 *
 * IT FITS INSIDE THE TURN'S OWN DEADLINE, and that is a fact about where it is spent
 * rather than a coincidence. `VOICE_CLIENT_OPTIONS.timeout` bounds ONE model request's
 * time-to-headers; a tool runs BETWEEN requests, in the agent loop, with no request open.
 * So the six seconds are additive to the turn's wall clock and are taken from
 * {@link CALL_CAP_MS}'s nine minutes, never from the eight the turn's stream is holding.
 * The socket stays open throughout — nothing in the relay session is on a clock that a
 * quiet turn can trip, because the pre-auth deadline is disarmed at `setup` and the only
 * remaining timer is the call cap.
 */
export const VOICE_LOOKUP_BUDGET_MS = 6_000;

export interface VoiceLookupPorts {
  /** Required, never nullable (rule #11): a budget that cannot report the searches it
   * cut off is a budget nobody can tell is firing, and "the call never searches" and
   * "the call always runs out of time" would look identical. */
  log: Pick<Console, 'error'>;
  /** Injected so the wall is provable without waiting six real seconds. */
  wait(ms: number): Promise<void>;
}

export function defaultVoiceLookupPorts(): VoiceLookupPorts {
  return {
    log: console,
    wait: (ms) =>
      new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        // Never hold the process open for a wall nobody is waiting on any more.
        timer.unref?.();
      }),
  };
}

/**
 * The same finder, with a wall in front of it.
 *
 * `over_budget` is a NAMED result and never an empty one (rule #11). An `{found: false}`
 * with no reason would be indistinguishable from "there is genuinely nothing running",
 * which is the one sentence a caller must not be told when Hale simply ran out of time —
 * they would stop looking for something that is there.
 *
 * THE ABANDONED SEARCH IS LEFT TO DIE ON ITS CLIENT'S OWN CLOCK. There is no signal to
 * cancel it with — `ActivityFinder.find` takes a query and nothing else — so the bill is
 * bounded by the client the finder was built with rather than by this wall, which is why
 * the voice wiring hands it a short-timeout client rather than the SMS lane's fifty
 * seconds. Its rejection is swallowed on purpose: nobody is waiting on it any more, and
 * an unhandled rejection on this runtime takes the instance down under a live call.
 */
export function withVoiceLookupBudget(
  finder: ActivityFinder,
  ports: VoiceLookupPorts,
  budgetMs: number = VOICE_LOOKUP_BUDGET_MS,
): ActivityFinder {
  return {
    async find(query) {
      const search = finder.find(query);
      const wall = ports.wait(budgetMs).then(() => 'over_budget' as const);
      const settled = await Promise.race([search, wall]);
      if (settled !== 'over_budget') return settled;

      search.catch(() => {});
      ports.log.error(
        { budgetMs },
        'voice lookup: the search did not come back inside the caller silence budget - answering by text instead',
      );
      return { found: false, reason: 'over_budget' };
    },
  };
}
