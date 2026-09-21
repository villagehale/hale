import { type Database, schema } from '@hale/db';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { SOCIAL_PROOF_MIN } from '~/lib/village/social-proof';

/**
 * WHO ELSE IS GOING — the one count Hale may speak, and every way it refuses to.
 *
 * ONE SURFACE, and the choice of it is forced by code rather than by taste. The first-find
 * reply's subject is a per-family `village_candidates` row whose reader selects nothing
 * cross-family, so a count there is 0 forever; the watched-spot text's `unbacked_digit`
 * makes a derived number a refusal `renderSpotOpen` throws on. The booked confirmation is
 * what is left, and its identity is PROBABLE rather than structural — which is the fact
 * every decision in this file is built around.
 *
 * THE KEY IS THE EXTRACTION'S OUTPUT, NOT THE PROVIDER'S. Only `provider_host` comes off
 * the envelope; the title and the first instant are one Sonnet sample over one email body,
 * and two families' receipts for one class are two samples over two bodies that differ in
 * salutation, child name and confirmation number. So equality is justified by its ERROR
 * DIRECTION and not by authorship:
 *
 *   · a MISS (two keys differ) is `below_floor` and therefore SILENCE — which is this
 *     feature's normal state anyway, so it costs nothing that was not already being paid;
 *   · a COLLISION (two sessions keying the same) is a number Hale speaks about strangers
 *     it cannot back, and that is the direction that has to be bounded.
 *
 * Everything below follows: normalise the pure sampling noise (case, whitespace), drop the
 * noisiest field (location) rather than buy misses with it, and REFUSE — with a NULL key —
 * the two shapes that manufacture collisions.
 */

/** The hosts that are a mailbox rather than a provider.
 *
 * Named here because there is no existing source of truth to reuse: `SPOT_PORTAL_HOSTS`
 * (channel/spots/url.ts) holds the two PerfectMind tenants Hale has actually parsed a
 * course page for, and allowlisting on it would silence every real receipt from every
 * provider Hale has not read yet. A denylist refuses the collision engine and lets the
 * rest through; an allowlist would refuse everything.
 *
 * THE COST IS REAL AND CHOSEN: a genuine small provider — a piano teacher on gmail — is
 * never counted either. `no_session` is counted separately so that cost is readable. */
export const FREEMAIL_HOSTS: ReadonlySet<string> = new Set([
  'aol.com',
  'bell.net',
  'gmail.com',
  'googlemail.com',
  'gmx.com',
  'hotmail.ca',
  'hotmail.com',
  'icloud.com',
  'live.ca',
  'live.com',
  'mac.com',
  'me.com',
  'msn.com',
  'outlook.com',
  'proton.me',
  'protonmail.com',
  'rogers.com',
  'shaw.ca',
  'sympatico.ca',
  'telus.net',
  'videotron.ca',
  'yahoo.ca',
  'yahoo.com',
  'ymail.com',
]);

/**
 * Every way a count can end (rule #11). A discriminated union rather than `number | null`,
 * because "one other family", "the flag is off" and "the read threw" call for different
 * things and none of them is a zero.
 */
export type GoingCount =
  | { shown: true; others: number }
  | {
      shown: false;
      reason:
        // 0 or 1 other family. The normal case, forever, and the one a key MISS also
        // produces — which is why `no_session` is its own bucket below.
        | 'below_floor'
        // A NULL session_key: a fallback title, a freemail host, or a title that folds to
        // nothing. Separate from `below_floor` because a rising rate here is the signal
        // that the key is refusing real receipts, and folding it into "nobody else is
        // going" would hide exactly that.
        | 'no_session'
        // This family already holds a live booking on this key. The differencing guard: a
        // provider that sends a confirmation and then a payment receipt, or two co-parents
        // on one mailing list, would otherwise let one household read 2 then 3 and learn
        // that exactly one family registered in between.
        | 'repeat_receipt'
        // The recipient's own receipt is a 13+ child's, so there is no booking under it.
        // Its own reason on THIS axis and not only on the booking one, because how often
        // a disclosure is withheld for a teen is the rate rule #1 wants readable.
        | 'teen_attributed'
        // Measured out of the two-segment frame. Counted rather than silent: if this fires
        // in prod the frame's arithmetic moved, and a counter is how that is noticed before
        // a parent gets a three-segment bill.
        | 'over_segment_budget'
        // GOING_COUNT_ENABLED is not 'true'. The query is not run at all.
        | 'going_dark'
        // The read threw. The text still goes — the count is the least important thing in
        // this message — and a silent zero here would be indistinguishable from an empty
        // room.
        | 'count_unavailable';
    };

/** One count per named going outcome (rule #11), the third axis beside the alert's and
 * the booking's. `shown` is the only member that is not a refusal. */
export const GOING_OUTCOMES = [
  'shown',
  'below_floor',
  'no_session',
  'repeat_receipt',
  'teen_attributed',
  'over_segment_budget',
  'going_dark',
  'count_unavailable',
] as const;

export type GoingOutcome = (typeof GOING_OUTCOMES)[number];

export type GoingCounts = Record<GoingOutcome, number>;

export function emptyGoingCounts(): GoingCounts {
  return Object.fromEntries(GOING_OUTCOMES.map((o) => [o, 0])) as GoingCounts;
}

/** The outcome name for a decided count — what the cron summary tallies. */
export function goingOutcome(count: GoingCount): GoingOutcome {
  return count.shown ? 'shown' : count.reason;
}

export const GOING_COUNT_ENABLED_ENV = 'GOING_COUNT_ENABLED';

/**
 * WHO ELSE IS GOING's own dark-launch flag.
 *
 * Its own, and not the booked chain's: `BOOKED_DETECTION_ENABLED` gates Hale RECORDING
 * something about this family, and this gates Hale TELLING this family something about
 * other families. Two different consents to withdraw, and a founder reaching for one in
 * an incident must not get the other.
 *
 * STRICT equality on the literal 'true': `vercel env add` from a piped `echo` stores a
 * TRAILING NEWLINE, so a value that prints as `true` is really `'true\n'` — and a
 * truthiness check would read that as ON and start speaking about other households
 * nobody armed. Strict comparison fails closed on exactly that shape.
 */
export function goingCountEnabled(): boolean {
  return process.env[GOING_COUNT_ENABLED_ENV] === 'true';
}

/**
 * THE SESSION, as one string, normalised ONCE and here.
 *
 * Casefold, collapse whitespace, trim — pure sampling noise, no meaning carried. Then:
 *
 *  · NO LOCATION. The noisiest model field, frequently null, stored raw. Including it
 *    converts a rare collision (two sections at one instant, where the disclosed group
 *    gets LARGER — safer for anonymity, imprecise for truth) into a common MISS, which is
 *    silence and invisible.
 *  · NULL on a FALLBACK title. `GENERIC_TITLE[kind]` is Hale's own words, so every
 *    nameless receipt from one host at one instant would key into one "session".
 *  · NULL on a FREEMAIL host. See {@link FREEMAIL_HOSTS}.
 *  · NULL on a title that folds to nothing, and on a host that is empty.
 *
 * NULL means "not countable, in either direction". Both readers honour it.
 */
export function sessionKey(input: {
  providerHost: string;
  /** The title the text actually said. */
  title: string;
  /** The renderer fell back to Hale's own words for this kind. */
  titleIsFallback: boolean;
  firstSessionAt: Date;
}): string | null {
  if (input.titleIsFallback) return null;
  const host = input.providerHost.trim().toLowerCase();
  if (host === '' || FREEMAIL_HOSTS.has(host)) return null;
  const title = input.title.replace(/\s+/g, ' ').trim().toLowerCase();
  if (title === '') return null;
  return `${host}|${title}|${input.firstSessionAt.toISOString()}`;
}

/**
 * DISTINCT other families on this session, and whether THIS family already holds it —
 * TWO FACTS IN ONE ROUND TRIP, so they are read at one instant and cannot disagree.
 *
 * `count(DISTINCT family_id)` and not `count(*)`: the row is per RECEIPT, so two
 * co-parents on a provider's list, or one household registering two children, produce two
 * rows for one family. The word in the sentence is *families*.
 *
 * `family_id <> $2` is the PRIMARY self-exclusion guard, not a belt — the recipient's own
 * row is absent only at the FIRST receipt, and there can be a second.
 *
 * `coalesce(..., false)` is the only default in this module and it is at an explicit
 * boundary (rule #8): zero matching rows genuinely means this family holds nothing here.
 *
 * NO DATE WINDOW. The count is read at the moment Hale is already saying this session's
 * first instant out loud, so "is it still relevant" is the caller's decision; a window
 * here would be a second, silently different, definition of a live booking.
 *
 * It takes the `database` handle the caller already holds rather than a port: rule #11
 * governs injected EFFECTS — something that sends, writes, enqueues or executes — and a
 * count sends nothing, so there would be no absence to name.
 */
export async function readSessionGoing(
  database: Database,
  input: { familyId: string; sessionKey: string },
): Promise<{ others: number; alreadyHeld: boolean }> {
  const mine = eq(schema.activityBookings.familyId, input.familyId);
  const [row] = await database
    .select({
      others: sql<number>`count(distinct ${schema.activityBookings.familyId}) filter (where ${ne(
        schema.activityBookings.familyId,
        input.familyId,
      )})::int`,
      alreadyHeld: sql<boolean>`coalesce(bool_or(${mine}), false)`,
    })
    .from(schema.activityBookings)
    .where(
      and(
        eq(schema.activityBookings.sessionKey, input.sessionKey),
        isNull(schema.activityBookings.cancelledAt),
      ),
    );
  return { others: Number(row?.others ?? 0), alreadyHeld: row?.alreadyHeld === true };
}

/**
 * THE DECISION, pure — so the frame, the counter and the audit row read the same number.
 *
 * The flag is NOT an input here, deliberately: dark means the query is never run, and a
 * function handed a count it was never allowed to read cannot express that. The caller
 * decides `going_dark` before it decides to read (see `email-alert.ts`).
 */
export function goingCount(input: { others: number; alreadyHeld: boolean }): GoingCount {
  if (input.alreadyHeld) return { shown: false, reason: 'repeat_receipt' };
  if (input.others < SOCIAL_PROOF_MIN) return { shown: false, reason: 'below_floor' };
  return { shown: true, others: input.others };
}

/**
 * THE CLAUSE, or ''. Deterministic — no model ever writes this string.
 *
 * "OTHER HALE FAMILIES", and the word *Hale* is not negotiable. The count is over the
 * households Hale can see, a tiny and arbitrary subset of the class roster: "two other
 * families are in this swim class" is a claim about the class that Hale cannot back, while
 * "two other Hale families" is true about a set Hale can enumerate. A count that does not
 * name its population is a false claim.
 *
 * A CLAUSE INSIDE THE FRAME, never its own sentence — the house rule in
 * `coach-channel-sms.md` ("a count rides in the same breath as the items it counts"), and
 * the one place in the repo that guards a number treats any ungiven digit as invented.
 *
 * Spelled as a word from two to nine, numerals from ten: "with 2 other Hale families"
 * reads as data and the sentence around it does not, and at the sizes this floor permits
 * the word costs two characters.
 */
export function goingClause(count: GoingCount): string {
  if (!count.shown) return '';
  return `, with ${spelled(count.others)} other Hale families`;
}

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

function spelled(count: number): string {
  return WORDS[count] ?? String(count);
}
