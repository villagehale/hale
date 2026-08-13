import { type Database, schema } from '@hale/db';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { matchKeyword } from '~/lib/channel/intake/keywords';
import { NAME_CAPTURED_REPLY } from '~/lib/channel/router/copy';
import { IDENTITY_ASK_TEMPLATE_KEYS } from './asked';

/**
 * THE NAME CAPTURE — a parent answering "what should I call you", read deterministically.
 *
 * NO MODEL, EVER, on this path, for the reason the address capture has none: a name is a
 * literal, and a model that paraphrases one has not read a name, it has invented a
 * person. The recognizer below either sees a name or hands the turn on.
 *
 * WHY IT EXISTS AT ALL. Until now no path in Hale ever collected a parent's own name over
 * text. `provisionFromIntake` inserts `users.name = null` and nothing later fills it in —
 * the only two writers are the mobile onboarding body and the authed web settings form,
 * neither of which an SMS-born family ever touches. So every family that arrived by text
 * has had a null name forever, which is what stalled the intros handoff: the introduction
 * email greets both parents by first name and there was no first name to greet them with.
 *
 * CONSERVATIVE ON PURPOSE. The check refuses far more than it accepts — anything with a
 * digit, an address, a link, more than a few words, or a word that is plainly an ordinary
 * reply. What it refuses is not lost: the turn falls through to the coach, which can read
 * "actually people call me Sam" like a person would. A false ACCEPT is the expensive
 * direction — it writes a wrong name into every message Hale sends afterwards — so the
 * shape check is the floor and the conversation is the ceiling, never the other way round.
 */

/** At most three words. "Sam", "Sam Lee", "I'm Sam" all fit; a sentence does not. */
const MAX_NAME_WORDS = 3;

/** A display name Hale would put in a greeting. Long enough for a real double-barrelled
 * name, short enough that a sentence fragment cannot pass as one. */
const MAX_NAME_CHARS = 40;

const LINK_SHAPE = /https?:\/\/|www\./i;

/**
 * A name token: letters (any script, so `Zoé`, `Søren` and `Ng` all pass), plus the
 * apostrophes and hyphens real names carry. No digits, no punctuation that would make it
 * a sentence.
 */
const NAME_TOKEN = /^[\p{L}\p{M}][\p{L}\p{M}'’-]*$/u;

/**
 * The lead-ins a parent puts in front of their own name. Stripped rather than refused,
 * because "I'm Sam" is the commonest way anybody answers this question — and each of
 * these is only stripped when something name-shaped follows it.
 */
const LEAD_INS: readonly string[] = [
  'my name is',
  "my name's",
  'my names',
  'this is',
  'it is',
  "it's",
  'its',
  'i am',
  "i'm",
  'im',
  'call me',
  'you can call me',
  'people call me',
  'name is',
  "name's",
  'just',
];

/**
 * Ordinary replies that are shaped exactly like a one-word name and are not one.
 *
 * This list is the difference between a capture and a liability: without it a parent who
 * answers the acknowledgment with "thanks" is called Thanks in every message Hale ever
 * sends them. It holds only words that could not plausibly BE somebody's name — "Grace",
 * "Hope" and "Faith" are deliberately absent, because they are names.
 */
const NOT_A_NAME: ReadonlySet<string> = new Set([
  'yes',
  'yeah',
  'yep',
  'yup',
  'ok',
  'okay',
  'k',
  'no',
  'nope',
  'nah',
  'sure',
  'thanks',
  'thank',
  'thx',
  'ty',
  'please',
  'hi',
  'hey',
  'hello',
  'yo',
  'sorry',
  'maybe',
  'idk',
  'nothing',
  'none',
  'nevermind',
  'stop',
  'help',
  'start',
  'why',
  'what',
  'who',
  'huh',
  'wait',
  'later',
  'sure thing',
]);

/**
 * The parent's own name in this body, or null when the body is anything else.
 *
 * Pure and exported so the whole refusal surface is a unit test rather than an
 * integration — the same shape `soleEmailAddress` is tested at.
 */
export function soleGivenName(body: string): string | null {
  // A carrier keyword was already answered upstream (STOP/HELP/START); reading one again
  // here could only ever disagree with the first answer.
  if (matchKeyword(body)) return null;

  const trimmed = body.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_NAME_CHARS) return null;
  if (LINK_SHAPE.test(trimmed) || trimmed.includes('@') || /\d/.test(trimmed)) return null;

  const stripped = stripLeadIn(trimmed);
  const words = stripped.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > MAX_NAME_WORDS) return null;

  for (const word of words) {
    if (!NAME_TOKEN.test(word)) return null;
    if (NOT_A_NAME.has(word.toLowerCase())) return null;
  }
  return words.join(' ');
}

/** The body with one leading "I'm"/"call me"/… removed, or unchanged when it carries
 * none. Only ever strips when something is left behind to be the name. */
function stripLeadIn(body: string): string {
  const lower = body.toLowerCase();
  for (const lead of LEAD_INS) {
    if (!lower.startsWith(`${lead} `)) continue;
    const rest = body.slice(lead.length).trim();
    if (rest.length > 0) return rest;
  }
  return body;
}

/** What the store did. `already_named` is not a failure — it is the honest answer when
 * two texts race, or when a parent answers an ask their co-parent already answered. */
export type NameCaptureWrite = 'stored' | 'already_named';

export type NameCaptureOutcome =
  | { status: 'declined_to_claim' }
  | { status: 'captured'; reply: string };

export interface NameCaptureInput {
  familyId: string;
  parentUserId: string;
  body: string;
  now: Date;
}

export interface NameCaptureDeps {
  /** Whether Hale actually asked this family for a name. Without it, every one-word
   * reply in Hale's whole inbox would be a candidate name. */
  wasAsked(database: Database, familyId: string): Promise<boolean>;
  capture(
    database: Database,
    input: { familyId: string; parentUserId: string; name: string },
  ): Promise<NameCaptureWrite>;
}

/**
 * Claim one reply as the answer to a name ask.
 *
 * THE ORDER IS THE POINT, and it is the address capture's order: shape first (free),
 * pending-ask second (one query), write last. A body that is not name-shaped never costs
 * a query, and a name-shaped body from a family nobody asked is handed straight on to the
 * coach rather than written anywhere.
 */
export async function handleNameCaptureReply(
  database: Database,
  input: NameCaptureInput,
  deps: NameCaptureDeps,
): Promise<NameCaptureOutcome> {
  const name = soleGivenName(input.body);
  if (!name) return { status: 'declined_to_claim' };

  if (!(await deps.wasAsked(database, input.familyId))) return { status: 'declined_to_claim' };

  const written = await deps.capture(database, {
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    name,
  });
  // Already named: the turn is NOT claimed. Hale asked, somebody answered, and this
  // message is something else — handing it to the coach is the only reading left.
  if (written === 'already_named') return { status: 'declined_to_claim' };

  return { status: 'captured', reply: NAME_CAPTURED_REPLY };
}

// ── prod wiring ──────────────────────────────────────────────────────────────

/** A delivered ask — the question this handler is the answer to. Either ask counts: a
 * parent does not know which of Hale's two reasons prompted the question they answered. */
async function askWasDelivered(database: Database, familyId: string): Promise<boolean> {
  const rows = await database
    .select({ id: schema.channelMessages.id })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.familyId, familyId),
        inArray(schema.channelMessages.templateKey, [...IDENTITY_ASK_TEMPLATE_KEYS]),
        inArray(schema.channelMessages.status, ['sent', 'delivered']),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Write the name, or report that there already was one.
 *
 * NEVER OVERWRITES, and the guard is in the UPDATE's own WHERE rather than in a read
 * before it: two texts arriving at once both see a null name in JS, and only Postgres can
 * settle which one wins. A name already on file is somebody's considered answer — from
 * this ask, from the settings form, or from a co-parent — and a later text is not
 * evidence it was wrong.
 */
async function captureParentName(
  database: Database,
  input: { familyId: string; parentUserId: string; name: string },
): Promise<NameCaptureWrite> {
  const updated = await database
    .update(schema.users)
    .set({ name: input.name, updatedAt: new Date() })
    .where(and(eq(schema.users.id, input.parentUserId), isNull(schema.users.name)))
    .returning({ id: schema.users.id });
  if (updated.length === 0) return 'already_named';

  // Rule #6. The name is the fact being recorded, so it IS the audit row's content. The
  // parent's words are not copied in: the inbound channel_messages row already holds them
  // verbatim, and that row is the evidence this write rests on.
  await database.insert(schema.auditLog).values({
    familyId: input.familyId,
    actor: input.parentUserId,
    actionTaken: 'parent_name_captured',
    targetTable: 'users',
    targetId: input.parentUserId,
    after: { source: 'sms_reply', name: input.name },
  });
  return 'stored';
}

export function defaultNameCaptureDeps(): NameCaptureDeps {
  return { wasAsked: askWasDelivered, capture: captureParentName };
}

/**
 * Whether there is still no name on file for this parent — the one condition that makes
 * asking for one honest.
 *
 * It lives here, beside the write it mirrors, so "is a name missing" has ONE reader. The
 * askers (intake's consent turn, the intros sweep) both consult it before spending a
 * model call, and the write above re-checks the same fact in SQL because only the
 * database can settle a race.
 */
export async function parentNeedsName(database: Database, userId: string): Promise<boolean> {
  const [row] = await database
    .select({ name: schema.users.name })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  return (row?.name ?? '').trim().length === 0;
}
