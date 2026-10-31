import { type Database, schema } from '@hale/db';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { EMPTY_ONBOARDING_CAPTURE, dropTakeBackName } from '~/lib/channel/intake/onboarding-turn';
import { optOutIntentOf } from '~/lib/channel/intake/opt-out-reader';
import { type ReplyLanguage, acceptReplyLanguage } from '~/lib/channel/language';
import { SENT_STATUSES } from '~/lib/channel/ledger';
import { IDENTITY_ASK_TEMPLATE_KEYS } from './asked';
import { defaultCallNameComposer, readModelParentName } from './call-name-voice';

/**
 * THE NAME CAPTURE — a parent answering "what should I call you".
 *
 * The onboarding model reads the message. Code stores only the `parentName` it
 * returns, and only while the ask is still open. A failed read stores nothing
 * and sends nothing. The receipt, when there is one, is the model's (VIL-417):
 * no fixed line.
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
  /** The model read a take-back: nothing was stored, and its reply goes out. */
  | { status: 'taken_back'; reply: string | null }
  /** `reply` is null when the model could not write the receipt: nothing is sent, #ops paged. */
  | { status: 'captured'; reply: string | null };

export interface NameCaptureInput {
  familyId: string;
  parentUserId: string;
  body: string;
  now: Date;
}

export interface NameCaptureRead {
  /** The name the model returned. Empty when the message was a take-back. */
  parentName: string | null;
  nameDeclined: boolean;
  /** A held name turned down. The open ask usually leaves this null. */
  nameConfirmed?: boolean | null;
  /** The model's reply, or null when it could not be written. */
  reply: string | null;
}

export interface NameCaptureDeps {
  /**
   * The ask is still open: this parent has no name, and the identity ask is
   * Hale's latest outbound to them. Otherwise the coach answers, and the model
   * is not called.
   */
  askOpen(database: Database, input: { familyId: string; parentUserId: string }): Promise<boolean>;
  capture(
    database: Database,
    input: { familyId: string; parentUserId: string; name: string },
  ): Promise<NameCaptureWrite>;
  /** The onboarding model reads the message. Code stores only `parentName`. */
  read(
    database: Database,
    input: { familyId: string; parentWords: string },
  ): Promise<NameCaptureRead>;
}

/**
 * Claim one reply as the answer to a name ask.
 *
 * The reader runs only while the ask is open. Code stores only the `parentName`
 * the model returns. A take-back (`nameDeclined`, or a held name turned down)
 * stores nothing and its reply stands. Any other nameless read is declined so
 * the coach answers. The raw body is not parsed into a name here.
 */
export async function handleNameCaptureReply(
  database: Database,
  input: NameCaptureInput,
  deps: NameCaptureDeps,
): Promise<NameCaptureOutcome> {
  // "Stop" or "start" in any wording is not a name (#868: the reader, not a word list).
  if ((await optOutIntentOf(input.body)) !== null) return { status: 'declined_to_claim' };
  if (
    !(await deps.askOpen(database, {
      familyId: input.familyId,
      parentUserId: input.parentUserId,
    }))
  ) {
    return { status: 'declined_to_claim' };
  }

  const read = await deps.read(database, {
    familyId: input.familyId,
    parentWords: input.body,
  });
  const kept = dropTakeBackName(input.body, {
    ...EMPTY_ONBOARDING_CAPTURE,
    parentName: read.parentName,
    nameDeclined: read.nameDeclined,
    nameConfirmed: read.nameConfirmed ?? null,
  });
  const tookBack = kept.nameDeclined || kept.nameConfirmed === false;
  if (tookBack) return { status: 'taken_back', reply: read.reply };
  const name = kept.parentName ? soleGivenName(kept.parentName) : null;
  if (!name) return { status: 'declined_to_claim' };

  const written = await deps.capture(database, {
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    name,
  });
  // Already named: the turn is NOT claimed. Hale asked, somebody answered, and this
  // message is something else — handing it to the coach is the only reading left.
  if (written === 'already_named') return { status: 'declined_to_claim' };

  return { status: 'captured', reply: read.reply };
}

// ── prod wiring ──────────────────────────────────────────────────────────────

/** No name on file. A missing row is not a name. */
async function parentStillUnnamed(database: Database, userId: string): Promise<boolean> {
  const rows = await database
    .select({ id: schema.users.id, name: schema.users.name })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  const row = rows.find((item) => item.id === userId);
  return (row?.name ?? '').trim().length === 0;
}

/**
 * The identity ask is still the question in front of them: they have no name,
 * and that ask is Hale's latest outbound. A later message from Hale closes it.
 * A failed send never opened it.
 */
async function nameAskIsOpen(
  database: Database,
  input: { familyId: string; parentUserId: string },
): Promise<boolean> {
  if (!(await parentStillUnnamed(database, input.parentUserId))) return false;
  const [latest] = await database
    .select({ templateKey: schema.channelMessages.templateKey })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.familyId, input.familyId),
        eq(schema.channelMessages.parentUserId, input.parentUserId),
        eq(schema.channelMessages.direction, 'out'),
        inArray(schema.channelMessages.status, [...SENT_STATUSES]),
      ),
    )
    .orderBy(desc(schema.channelMessages.createdAt))
    .limit(1);
  return (
    latest?.templateKey != null &&
    (IDENTITY_ASK_TEMPLATE_KEYS as readonly string[]).includes(latest.templateKey)
  );
}

/** The tag stored for this family. Null when the row or the tag is missing. */
export async function familyReplyLanguage(
  database: Database,
  familyId: string,
): Promise<ReplyLanguage | null> {
  const rows = await database
    .select({ id: schema.families.id, primaryLanguage: schema.families.primaryLanguage })
    .from(schema.families)
    .where(eq(schema.families.id, familyId));
  return acceptReplyLanguage(rows.find((row) => row.id === familyId)?.primaryLanguage);
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
  const composer = defaultCallNameComposer();
  return {
    askOpen: nameAskIsOpen,
    capture: captureParentName,
    read: async (database, input) =>
      readModelParentName(composer, {
        parentWords: input.parentWords,
        language: await familyReplyLanguage(database, input.familyId),
      }),
  };
}

/**
 * Store a parent name the onboarding model already returned as its own field.
 * The raw message is not read here.
 */
export async function storeModelParentName(
  database: Database,
  input: { familyId: string; parentUserId: string; name: string },
): Promise<NameCaptureWrite> {
  const updated = await database
    .update(schema.users)
    .set({ name: input.name, updatedAt: new Date() })
    .where(and(eq(schema.users.id, input.parentUserId), isNull(schema.users.name)))
    .returning({ id: schema.users.id });
  if (updated.length === 0) return 'already_named';
  await database.insert(schema.auditLog).values({
    familyId: input.familyId,
    actor: input.parentUserId,
    actionTaken: 'parent_name_captured',
    targetTable: 'users',
    targetId: input.parentUserId,
    after: { source: 'onboarding_model', name: input.name },
  });
  return 'stored';
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
