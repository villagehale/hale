import type { Database } from '@hale/db';
import { type HealthReplyDeps, handleHealthCheckpointReply } from '~/lib/health/reply';

/**
 * VIL-294 · THE INBOUND HALF OF THE RECONCILIATION PRIMITIVE — what did the PARENT state?
 *
 * VIL-293 asks the outbound question: a sentence claiming Hale holds a row must be
 * reconcilable against that row before it reaches a transport (reconcile/claims.ts). It
 * left the mirror image unasked. A parent stating that something is ALREADY handled is
 * making a claim too — about the family, not about Hale — and until now the only place
 * that claim landed was the transcript, which no deterministic reader reads.
 *
 * WHAT THAT COST, in one chain (2026-08-13 → 08-20):
 *   · 10:00:25  Hale texts the 18-month immunization checkpoint.
 *   · 10:01:09  "Yes we booked already" — no closed vocabulary contains it, so the health
 *               handler declined and the turn fell through to the coach.
 *   · 10:01:14  "Glad it's locked in!" — an acknowledgement with nothing behind it.
 *   · +7 days   the sweep raised the OTHER 18-month row, the well-baby visit, because
 *               nothing had been written down. Forty-one minutes later the same thread
 *               held three mutually exclusive statements about that one appointment.
 *
 * DETERMINISTIC, and for the same two reasons its outbound twin is: it runs on the turn
 * a parent is waiting on, so a model call here would buy latency on every inbound
 * message; and the row it writes SUPPRESSES a legal-obligation reminder for a window
 * months wide, so the reader that decides must be one a corpus can pin exactly
 * (stated-state.test.ts runs all 54 messages of the thread above).
 *
 * IT NAMES THE STATE, NEVER THE SUBJECT. "Yes we booked already" says a thing is
 * arranged and does not say what — the parent is answering the message Hale just sent,
 * and that message is the subject. So this reader returns a KIND and the caller resolves
 * WHICH from the family's own rows (health/reply.ts loadLastCheckpointRef). A model
 * choosing the key would be a model able to write any key, which is exactly what
 * loadDoneCheckpointRefs' writer pin exists to prevent.
 */

/**
 * The states a parent's own words can settle, and the taxonomy is closed for the same
 * reason ClaimKind is: each member names a question some deterministic reader ACTS on.
 * There is one today — the health checkpoint sweep's "must I raise this again?" — and a
 * second member may only be added alongside the reader that would honour it.
 */
export type StatedState = 'health_visit_handled';

/** A parent text, reduced to words: apostrophes closed up so "it's" reads as "its" and
 * "haven't" as "havent", everything else that is not a letter or digit swept to a space.
 * The same shape the affirmative vocabulary normalizes to, so the patterns below can be
 * written once in plain words. */
function words(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/['’ʼ`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

interface Segment {
  words: string;
  question: boolean;
}

/** Sentence-ish, keeping only whether the sentence was ASKED. Terminal punctuation is
 * the whole grammar of a text message, and a parent's capitalisation is not evidence of
 * anything — so this splits where the outbound extractor's `sentencesOf` deliberately
 * does not, on any terminator at all. */
function segmentsOf(body: string): Segment[] {
  return [...body.matchAll(/([^.!?\n]+)([.!?\n]*)/g)]
    .map((match) => ({
      words: words(match[1] ?? ''),
      question: (match[2] ?? '').includes('?'),
    }))
    .filter((segment) => segment.words.length > 0);
}

/**
 * The appointment already exists. Every form is PAST or PERFECT — there is no bare
 * "book" here, which is what keeps "we need to book that" out without a guard: a verb
 * a parent uses to describe an intention simply is not in this set.
 */
const ARRANGED =
  /\b(?:booked|rebooked|scheduled|went|made (?:the|an?) appointment|got (?:the|an?) appointment|have (?:the|an?) appointment|has (?:the|an?) appointment)\b/;

/** Somebody in this household did it, or it is already true. One of these must be
 * present, so a fragment naming the verb and nobody ("booked solid") is not a claim. */
const SETTLED = /\b(?:already|we|i|weve|ive|its|thats|hes|shes|theyve)\b/;

/**
 * The sentence denies, defers or conditions the thing it names. Checked before anything
 * else, and deliberately broad: a false negative costs one repeated reminder, a false
 * positive silences a legal obligation for months. `yet` is in here on its own because
 * "booked yet" is only ever half of a denial.
 */
const UNSETTLED =
  /\b(?:not|no|never|nothing|yet|havent|hasnt|hadnt|didnt|dont|doesnt|isnt|arent|wasnt|cant|cannot|wont|maybe|if|unless|trying)\b/;

/** An intention, not a fact. "next Tuesday" is absent on purpose — an appointment that
 * IS booked is nearly always in the future, and a guard that read the date would refuse
 * every true statement of this kind. */
const INTENDED =
  /\b(?:will|ll|going to|gonna|planning|plan to|need to|have to|want to|should|about to)\b/;

/** Somebody else's sentence, reported. "You said it was booked" is Hale's own claim
 * handed back, and reading it as the parent's would let Hale confirm itself. */
const REPORTED = /\byou\b/;

/** The parent is asking Hale to act. An instruction is the opposite of a fact about what
 * is already true, and the propose_* verbs are what answer it. */
const INSTRUCTION =
  /^(?:please |just |ok |okay )*(?:add|put|book|schedule|rebook|move|cancel|change|find|send|make|set|remind|call|can|could|would|will|do|lets|let us)\b/;

/**
 * What this message says is ALREADY TRUE, or null — the ordinary answer, and it means
 * exactly what it says: nothing here settles a state some reader acts on. It does NOT
 * mean the message is unimportant.
 */
export function readStatedState(body: string): StatedState | null {
  for (const segment of segmentsOf(body)) {
    if (segment.question) continue;
    const text = segment.words;
    if (REPORTED.test(text)) continue;
    if (INSTRUCTION.test(text)) continue;
    if (UNSETTLED.test(text)) continue;
    if (INTENDED.test(text)) continue;
    if (!ARRANGED.test(text)) continue;
    if (!SETTLED.test(text)) continue;
    return 'health_visit_handled';
  }
  return null;
}

// ── the write ────────────────────────────────────────────────────────────────

/**
 * What became of a stated state. `not_recorded` is a first-class outcome and never a
 * silent one (rule #11): it means this reader believed the parent settled something and
 * found nothing open to settle, which is the signal that the vocabulary above has drifted
 * from what Hale actually raises.
 */
export type StatedStateOutcome =
  | { status: 'recorded'; state: StatedState; ref: string }
  /** The ordinary answer on nearly every message: nothing here settles anything. */
  | { status: 'nothing_stated' }
  | { status: 'not_recorded'; state: StatedState; reason: 'no_open_checkpoint' };

/**
 * Read the parent's message, and write down what it settled.
 *
 * NO NEW WRITE PATH. `handleHealthCheckpointReply` is the one thing that files a
 * checkpoint as handled — audit row first, in one transaction, superseding whatever was
 * live on that identity (health/reply.ts recordCheckpointDone). This is a second DOOR to
 * it, not a second writer, which is what keeps the suppression's writer pin meaningful:
 * the row still says `health-nudge-reply`, because that module is still the one that
 * wrote it.
 *
 * THE SUBJECT COMES FROM THE FAMILY'S ROWS, never from the message. The parent said "we
 * booked already"; WHICH errand that answers is the checkpoint Hale last told them about,
 * within the window the nudge treats its own question as live. A reader that let the
 * message name its own key would be a reader any sentence could aim at any reminder.
 */
export async function recordStatedState(
  database: Database,
  input: { familyId: string; parentUserId: string; body: string; now: Date },
  deps: HealthReplyDeps,
): Promise<StatedStateOutcome> {
  const state = readStatedState(input.body);
  if (state === null) return { status: 'nothing_stated' };

  const outcome = await handleHealthCheckpointReply(
    database,
    {
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      body: input.body,
      now: input.now,
      resolved: 'done',
    },
    deps,
  );
  return outcome.status === 'recorded_done'
    ? { status: 'recorded', state, ref: outcome.ref }
    : { status: 'not_recorded', state, reason: 'no_open_checkpoint' };
}
