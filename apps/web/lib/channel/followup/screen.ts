import { type Database, schema } from '@hale/db';
import { and, eq, gte, isNotNull } from 'drizzle-orm';

/**
 * THE SUPPRESSION SCREEN — do not ask a parent something they already told us.
 *
 * A follow-up is the one message class where being late is survivable and being
 * redundant is not. "How was swim?" three days after the parent texted "swim was a
 * disaster, she cried the whole time" is not a warm check-in; it is proof that nobody
 * was listening, and it undoes the exact thing the message was sent to build.
 *
 * THE TOLD-ANYWHERE SHAPE (lib/health/told.ts, VIL-243 · M8). That module's invariant is
 * "every surface that TELLS writes one marker; every surface that ASKS reads it". This is
 * the mirror image — every surface that HEARS has already written the only marker that
 * matters, because an inbound text is stored verbatim on its `channel_messages` row
 * (direction 'in' is the one direction that carries a body). So there is nothing to
 * write here at all: the question "did they already tell us?" is answered by scanning
 * what they said, and no second bookkeeping can drift out of step with it.
 *
 * IT NEVER RE-ARMS, WITHOUT A CLAIM ROW. The anchor is a fixed instant in the past and
 * the scan window only grows, so a hit today is a hit on every later tick, forever. That
 * is why a suppressed follow-up writes nothing: a claim row would be a second reader of
 * a question that already has one, and this repo's ledger convention is that a
 * suppression never carries a dedupe key (channel/ledger.ts) — writing one would collide
 * with the unique index the day a real send finally wanted it.
 *
 * CONSERVATIVE ON PURPOSE, in both directions. A missed mention costs one slightly
 * redundant text. A false hit costs the message entirely, silently, and the parent never
 * knows they were skipped — so every rule here errs toward asking. Nothing clever, no
 * model, no stemming, no fuzzy match: substring containment over a short vocabulary.
 */

/**
 * What a parent said between the anchor and now — the inbound bodies, lowercased.
 *
 * Only `direction: 'in'` rows carry a body (outbound rows deliberately store none), so
 * this reads the family's own words and never Hale's. That matters for correctness as
 * well as privacy: Hale's own outbound text about an activity NAMES the activity, so a
 * scan that included it would suppress every follow-up on the strength of the message
 * that set it up.
 */
export async function inboundSince(
  database: Database,
  familyId: string,
  since: Date,
): Promise<string[]> {
  const rows = await database
    .select({ body: schema.channelMessages.body })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.familyId, familyId),
        eq(schema.channelMessages.direction, 'in'),
        isNotNull(schema.channelMessages.body),
        gte(schema.channelMessages.createdAt, since),
      ),
    );
  return rows.flatMap((row) => (row.body === null ? [] : [row.body.toLowerCase()]));
}

/**
 * Words that appear in an activity title but say nothing about WHICH activity it is.
 *
 * Without this list "Swim class" is screened on "class", and any parent who mentions a
 * class of any kind loses their follow-up. These are the generic nouns Hale's own
 * placement titles are built from, plus the filler around them. A title made ENTIRELY of
 * these has no distinctive word, which is a real and handled state — see
 * {@link distinctiveWords}.
 */
const GENERIC_TITLE_WORDS = new Set([
  'class',
  'classes',
  'lesson',
  'lessons',
  'session',
  'sessions',
  'practice',
  'club',
  'camp',
  'group',
  'meetup',
  'meeting',
  'program',
  'programme',
  'activity',
  'event',
  'time',
  'day',
  'week',
  'kids',
  'kid',
  'child',
  'children',
  'family',
  'parent',
  'baby',
  'toddler',
  'drop',
  'and',
  'the',
  'for',
  'with',
  'from',
  'this',
  'that',
  'your',
  'our',
]);

/** Shorter than this is too common to screen on ("gym", "art", "zoo" would all fire on
 * ordinary sentences). Four is where a word starts to be about one thing. */
const MIN_DISTINCTIVE_LENGTH = 4;

/**
 * The words in a title specific enough to recognise it by.
 *
 * Returns an empty array when the title has none — "Drop-in class" is generic all the
 * way through — and an empty array means THIS TITLE CANNOT BE SCREENED. The caller sends
 * the follow-up: a title we cannot match on is a title whose mention we cannot detect,
 * and the conservative answer to "did they already tell us?" is no.
 */
export function distinctiveWords(title: string): string[] {
  const words = title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= MIN_DISTINCTIVE_LENGTH && !GENERIC_TITLE_WORDS.has(word));
  return [...new Set(words)];
}

/**
 * Has the family already talked about this activity since it happened?
 *
 * ANY distinctive word is a hit, rather than all of them: a parent who went to "Saturday
 * Storytime at Riverdale" texts "storytime was packed", not the title. One specific word
 * back is the parent raising the subject, which is all this needs to know.
 */
export function mentionsActivity(bodies: readonly string[], title: string): boolean {
  const words = distinctiveWords(title);
  if (words.length === 0) return false;
  return bodies.some((body) => words.some((word) => body.includes(word)));
}

/**
 * The intro vocabulary — the ways a parent says an introduction did or did not go
 * anywhere, in the words they actually use.
 *
 * A FIXED, SHORT LIST rather than anything clever, and every entry is a PHRASE rather
 * than a word. That rule is not stylistic — the first draft of this list carried the bare
 * words `met`, `connected` and `reached out`, and its own test caught all three: "we met
 * the new teacher today" and "the wifi never connected at the library" are ordinary
 * messages that would each have silently cost a family their follow-up. Every entry here
 * takes at least two words to say by accident.
 *
 * Note that it screens on the SUBJECT, not the sentiment. "We never heard back" is as
 * much an answer to "did you connect?" as "we had coffee Tuesday" — both mean the parent
 * has already told Hale where it went, and asking again is the redundancy this prevents.
 */
export const INTRO_MENTIONS = [
  'the other family',
  'that other family',
  'other hale family',
  'the intro',
  'the introduction',
  'hit it off',
  'met up',
  'met them',
  'we connected',
  'connected with them',
  'never heard back',
  'heard back from them',
  'reached out to them',
  'they reached out',
] as const;

/** Has the family already said something about the introduction since it was made? */
export function mentionsIntro(bodies: readonly string[]): boolean {
  return bodies.some((body) => INTRO_MENTIONS.some((phrase) => body.includes(phrase)));
}
