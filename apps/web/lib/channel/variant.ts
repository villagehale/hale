import { createHash } from 'node:crypto';
import { localDaysBetween } from '~/lib/channel/checkin/cadence';

/**
 * WHICH SENTENCE THIS FAMILY READS TONIGHT — a rotation, never a draw.
 *
 * A message a household reads every evening of their life cannot be one sentence, and it
 * cannot be a model call either (checkin/copy.ts states that trade). What is left is a
 * pool of reviewed sentences and something that picks one, and the shape of that
 * something is already decided in this repo: `Math.random` appears NOWHERE in production
 * source, and the one injected default that could has its reason attached — "a sweep
 * nobody can make deterministic is a sweep nobody can prove is spaced"
 * (channel/spots/sweep.ts).
 *
 * So the selector is a pure function of the family and the occasion. Three properties,
 * and each one is why a line below is there rather than an alternative:
 *
 *   A CONSECUTIVE REPEAT IS IMPOSSIBLE BY CONSTRUCTION, not by retry. A hash-mod-N of the
 *   date repeats on 1-in-N nights — a quarter of all evenings at N=4, on the message a
 *   family reads more than any other. A rotation moves by exactly one. There is no stored
 *   "last variant", so there is nothing to read, nothing to migrate, nothing to export
 *   under a subject-access request, and nothing that can desynchronise from the message
 *   that actually went out.
 *
 *   THE POOL'S NAME IS IN THE OFFSET, so two pools that fire the same evening do not
 *   advance in lockstep. Without it, tonight's ask and tonight's ack would be the same
 *   pairing forever.
 *
 *   THE FAMILY IS IN THE OFFSET, so two households on the same evening are not reading
 *   the same sentence — the phase differs even though the step does not.
 *
 * WHAT GETS A POOL: once-per-family-per-occasion classes only. Anything that can fire
 * several times a day (email_alert and calendar_alert at 3/24h, spot_open at 4/24h —
 * outbound-gate.ts) gets none, and the reason is mechanical rather than a preference: a
 * date-keyed seed hands all three of Monday's alerts the same variant, and a per-send
 * seed is a hash again, which loses the one property this rotation exists for.
 */

/**
 * The instant every rotation is counted from. FROZEN: moving it re-phases every family's
 * pool at once, which is a product change disguised as a constant edit.
 */
export const POOL_EPOCH = new Date('2026-01-01T00:00:00.000Z');

const DAY_MS = 86_400_000;
const MIN_POOL_SIZE = 3;
/** The step a nightly pool takes when it is read on a weekly rhythm. */
const WEEK_DAYS = 7;

/**
 * A pool that cannot rotate, refused at module load rather than discovered in production.
 *
 * TWO MEMBERS IS AN ALTERNATION a parent reads as a coin flip, so the floor is three.
 *
 * AND THE SIZE MAY NOT BE A MULTIPLE OF SEVEN. The rule names the CLASS rather than two
 * instances of it: the steps this product uses are 1 (a nightly pool) and 7 (a nightly
 * pool read on a weekly rhythm), and any multiple of seven locks a nightly pool to the
 * weekday forever — Tuesday's sentence is Tuesday's sentence for good. 7, 14 and 21 are
 * the same bug. A weekly pool advances by 1 in its own occasion space, so only the
 * three-member floor binds there; the seven rule costs it nothing.
 */
export function assertPoolSize(pool: readonly unknown[], poolName: string): void {
  if (pool.length < MIN_POOL_SIZE) {
    throw new Error(
      `variant pool '${poolName}': ${pool.length} members — a pool needs at least ${MIN_POOL_SIZE}`,
    );
  }
  if (pool.length % WEEK_DAYS === 0) {
    throw new Error(
      `variant pool '${poolName}': ${pool.length} members is a multiple of ${WEEK_DAYS}, which locks a nightly pool to the weekday forever`,
    );
  }
}

/**
 * The family's phase in this pool. sha256 of the pool name and the family id, read as one
 * integer — machine-independent and stable across processes, which is what lets a test
 * pin a literal digest and catch a change of hash function.
 */
function poolOffset(poolName: string, familyId: string, size: number): number {
  const digest = createHash('sha256').update(`${poolName}:${familyId}`).digest('hex');
  return Number(BigInt(`0x${digest}`) % BigInt(size));
}

/**
 * Which member of `pool` this family reads on this occasion.
 *
 * `occasion` is an INTEGER that advances by one per send for this pool, and the caller
 * computes it with {@link nightlyOccasion} or {@link weeklyOccasion} — a string date key
 * cannot rotate, which is why neither of those returns one.
 *
 * IT THROWS rather than falling back. An empty or malformed pool is a build error, and a
 * silent fallback is a sentence nobody wrote reaching a parent.
 */
export function pickVariant<T>(
  pool: readonly T[],
  poolName: string,
  familyId: string,
  occasion: number,
): T {
  assertPoolSize(pool, poolName);
  if (!Number.isInteger(occasion)) {
    throw new Error(`variant pool '${poolName}': occasion ${occasion} is not an integer`);
  }
  const size = pool.length;
  // Two mods, because an occasion before the epoch is negative and JavaScript's % keeps
  // the sign — which would index off the front of the array.
  const index = (((occasion + poolOffset(poolName, familyId, size)) % size) + size) % size;
  const member = pool[index];
  if (member === undefined) {
    throw new Error(`variant pool '${poolName}': no member at index ${index} of ${size}`);
  }
  return member;
}

/**
 * The occasion for a pool that fires once per family per evening.
 *
 * WHOLE CALENDAR DAYS IN THE FAMILY'S ZONE, via the check-in ladder's own helper, which
 * already carries the argument for why: a rhythm measured in milliseconds drifts, the
 * hourly cron fires at :17 give or take, and a spring-forward makes the drift certain.
 * Days are what the promise was made in.
 */
export function nightlyOccasion(now: Date, timeZone: string): number {
  return localDaysBetween(POOL_EPOCH, now, timeZone);
}

/**
 * The occasion for a pool that fires once per family per week, off the week's Monday key
 * (`YYYY-MM-DD`) the weekly artifact is already stored under.
 *
 * No timezone: a Monday key is already a calendar day in the family's week, and two
 * consecutive Mondays are exactly seven days apart in every zone, so the quotient
 * advances by exactly one whatever weekday the epoch happens to be.
 */
export function weeklyOccasion(mondayKey: string): number {
  const monday = Date.parse(`${mondayKey}T00:00:00Z`);
  if (Number.isNaN(monday)) {
    throw new Error(`variant occasion: '${mondayKey}' is not a YYYY-MM-DD week key`);
  }
  return Math.floor((monday - POOL_EPOCH.getTime()) / DAY_MS / WEEK_DAYS);
}
