import { type AgentClient, pickLane } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { isEnabled } from '@hale/flags';
import { and, asc, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { withLlmContext } from '~/lib/analytics/llm-trace';
import { askIsGrounded } from '~/lib/channel/coach/group-leave-tool';
import { resolveVerifiedChannelByHash } from '~/lib/channels/sms-consent-core';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { loadCronSkill } from '~/lib/cron/skill';
import { contactsOutside } from '~/lib/format/contact-shape';
import { hasLinkShape } from '~/lib/format/link-shape';
import { HOT_SMS_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import { forceToolJson } from '~/lib/pipeline/structured';
import { linqMultiFamilyGroupsEnabled } from './config';
import { SECRET_SANTA_MIN_PARTICIPANTS, writePairings } from './secret-santa-pairings';

/**
 * VIL-686 — a Secret Santa in a multi-family group, drawn privately.
 *
 * Someone in a shared chat says "let's do Secret Santa". Hale collects who is in, each
 * person for themselves and with a name they give, then draws once when the organizer
 * asks. Each giver hears their draw 1:1 (secret-santa-send.ts); the group hears only that
 * the draw is done.
 *
 * Nothing here judges words. One model call reads the message against this chat's draw
 * as the chat may see it (who is in, by the names they gave: never a pairing, which does
 * not exist anywhere a model can read) and says what the message asks for plus the line
 * Hale would say. Code checks ids, rows and structure:
 * - Only the speaker joins or leaves, and only for themselves.
 * - A name is kept only when the speaker wrote it in this message, it has no link or
 *   contact shape, it is short, and nobody in the draw already goes by it.
 * - Only a speaker from a Hale family may start one; only the organizer may draw or cancel.
 * - The draw runs once, under a row lock, and needs four named people.
 * - A group line carries no name after the draw, and no link or contact ever.
 *
 * The pairing itself lives only in secret-santa-pairings.ts.
 */

export const SECRET_SANTA_TURN_SKILL = 'secret-santa-turn';
export const SECRET_SANTA_TURN_TOOL = 'record_secret_santa_turn';
export const SECRET_SANTA_TURN_TOOL_DESCRIPTION =
  'What this message does to the chat Secret Santa, and the one line Hale says, or null.';
/** The read runs on every group message while the flag is on: kept below the list read. */
export const SECRET_SANTA_TURN_MAX_TOKENS = 600;
/** At most this many participants reach the model; `count` still says how many are in. */
export const SECRET_SANTA_READ_MAX = 30;

export const SECRET_SANTA_LINE_SKILL = 'secret-santa-line';
export const SECRET_SANTA_LINE_TOOL = 'secret_santa_line';
export const SECRET_SANTA_LINE_TOOL_DESCRIPTION = 'Write the one text Hale will send.';
export const SECRET_SANTA_LINE_MAX_TOKENS = 400;

export const SANTA_TURN_TEMPLATE = 'linq:secret_santa_turn';
export const SANTA_REFUSAL_TEMPLATE = 'linq:secret_santa_refusal';
export const SANTA_DONE_TEMPLATE = 'linq:secret_santa_done';

/** A collecting draw nobody drew is cancelled after this long. */
export const SANTA_COLLECTING_MAX_MS = 14 * 24 * 3_600_000;
/** A drawn or cancelled draw, and every row under it, is deleted after this long. */
export const SANTA_RETENTION_MS = 45 * 24 * 3_600_000;

const CALLED_MAX_CHARS = 40;
const CALLED_MAX_WORDS = 4;

/** Kill switch, default on. Retention never reads it. */
export function secretSantaEnabled(): boolean {
  return isEnabled('secret-santa');
}

// ---------------------------------------------------------------------------------------
// Names.

/** NFKC, case-folded, single-spaced: how two names are compared. */
export function foldName(name: string): string {
  return name.normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, ' ').trim();
}

/** Scripts written without spaces between words. */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether `name` appears in `text` as a whole name: on letter boundaries for spaced
 * scripts (so "Ben" is not found in "Benjamin"), as a substring for unspaced ones.
 */
export function nameAppears(text: string, name: string): boolean {
  const needle = foldName(name);
  if (!needle) return false;
  const haystack = foldName(text);
  if (UNSPACED.test(needle)) return haystack.includes(needle);
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(needle)}(?![\\p{L}\\p{N}])`, 'u').test(
    haystack,
  );
}

/**
 * The speaker wrote this name in this message. Spaced scripts: whole-token containment.
 * Unspaced scripts: the name's words, as Intl.Segmenter splits them, in the message's,
 * or plain containment when the segmenter returns a single word.
 */
export function calledIsGrounded(called: string, message: string): boolean {
  if (!UNSPACED.test(called)) return askIsGrounded(called, message);
  const folded = foldName(called);
  const said = foldName(message);
  if (!said.includes(folded)) return false;
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
  const words = [...segmenter.segment(folded)].filter((s) => s.isWordLike).map((s) => s.segment);
  return words.length <= 1 || words.every((word) => said.includes(word));
}

export type CalledCheck = { called: string } | { fact: 'name_needed' | 'name_taken' };

/** A name the speaker gave for themselves, checked; never a name the code made up. */
export function checkCalled(
  raw: string | null,
  message: string,
  takenByOthers: readonly string[],
): CalledCheck {
  const called = raw?.trim() ?? '';
  if (!called) return { fact: 'name_needed' };
  if ([...called].length > CALLED_MAX_CHARS) return { fact: 'name_needed' };
  if (called.split(/\s+/u).length > CALLED_MAX_WORDS) return { fact: 'name_needed' };
  if (hasLinkShape(called) || contactsOutside(called, []).length > 0) {
    return { fact: 'name_needed' };
  }
  if (!calledIsGrounded(called, message)) return { fact: 'name_needed' };
  if (takenByOthers.some((name) => foldName(name) === foldName(called))) {
    return { fact: 'name_taken' };
  }
  return { called };
}

/**
 * A group line may carry no link and no contact, and no participant's name outside
 * `allowed`. After a draw, nothing is allowed: a group line that names two people is the
 * one shape a reveal takes.
 */
export function santaGroupLineUsable(
  line: string,
  names: { participants: readonly string[]; allowed: readonly string[] },
): boolean {
  if (!line.trim() || hasLinkShape(line) || contactsOutside(line, []).length > 0) return false;
  const allowed = new Set(names.allowed.map(foldName));
  return !names.participants.some((name) => !allowed.has(foldName(name)) && nameAppears(line, name));
}

// ---------------------------------------------------------------------------------------
// The model's view and answer.

export type SantaStatus = 'none' | 'collecting' | 'drawn';

export interface SecretSantaTurnInput {
  text: string;
  language: string | null;
  speaker: string;
  people: { ref: string }[];
  santa: {
    status: SantaStatus;
    youAreOrganizer: boolean;
    participants: { ref: string; called: string | null }[];
    count: number;
    minimum: number;
  };
}

export const secretSantaTurnJsonSchema = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    santaTurn: { type: 'boolean' },
    start: { type: 'boolean' },
    joinSelf: {
      type: ['object', 'null'],
      additionalProperties: false,
      properties: { called: { type: ['string', 'null'] } },
      required: ['called'],
    },
    leaveSelf: { type: 'boolean' },
    draw: { type: 'boolean' },
    cancel: { type: 'boolean' },
    language: { type: ['string', 'null'] },
    reply: { type: ['string', 'null'] },
  },
  required: ['santaTurn', 'start', 'joinSelf', 'leaveSelf', 'draw', 'cancel', 'language', 'reply'],
};

const decisionSchema = z
  .object({
    santaTurn: z.boolean(),
    start: z.boolean(),
    joinSelf: z.object({ called: z.string().nullable() }).strict().nullable(),
    leaveSelf: z.boolean(),
    draw: z.boolean(),
    cancel: z.boolean(),
    language: z.string().nullable(),
    reply: z.string().nullable(),
  })
  .strict();

/** The user-turn payload. Shared with the eval, which replays this request shape. */
export function secretSantaTurnUserMessage(input: SecretSantaTurnInput): string {
  return JSON.stringify(input);
}

export interface SecretSantaDecision {
  start: boolean;
  join: { called: string | null } | null;
  leave: boolean;
  draw: boolean;
  cancel: boolean;
  language: string | null;
  reply: string | null;
}

const clean = (value: string | null, max: number): string | null => {
  const text = value?.trim() ?? '';
  return text.length > 0 && text.length <= max ? text : null;
};

/** `null` is a malformed answer; `'none'` is a message that is not about Secret Santa. */
export function parseSecretSantaDecision(value: unknown): SecretSantaDecision | 'none' | null {
  const parsed = decisionSchema.safeParse(value);
  if (!parsed.success) return null;
  const raw = parsed.data;
  if (!raw.santaTurn) return 'none';
  const language = raw.language === null ? null : clean(raw.language, 35);
  return {
    start: raw.start,
    join: raw.joinSelf ? { called: raw.joinSelf.called?.trim() || null } : null,
    leave: raw.leaveSelf,
    draw: raw.draw,
    cancel: raw.cancel,
    language,
    reply: clean(raw.reply, 1000),
  };
}

export interface SecretSantaTurnModel {
  decide(input: SecretSantaTurnInput): Promise<unknown>;
}

function modelMayRun(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY) && isEnabled('voice') && secretSantaEnabled();
}

let sharedTurn: SecretSantaTurnModel | null = null;

/** Production reader, or null when no model may run (no key, voice off, flag off). */
export function secretSantaTurnModel(): SecretSantaTurnModel | null {
  if (!modelMayRun()) return null;
  sharedTurn ??= {
    async decide(input) {
      const skill = await loadCronSkill(SECRET_SANTA_TURN_SKILL);
      const { value } = await withLlmContext({ stage: 'group', omitContent: true }, () =>
        forceToolJson({
          client: budgetedAnthropic(HOT_SMS_CLIENT_OPTIONS, { stage: 'group' }),
          lane: pickLane(skill.meta.task),
          system: skill.instructions,
          userMessage: secretSantaTurnUserMessage(input),
          toolName: SECRET_SANTA_TURN_TOOL,
          toolDescription: SECRET_SANTA_TURN_TOOL_DESCRIPTION,
          inputJsonSchema: secretSantaTurnJsonSchema,
          schema: decisionSchema,
          maxTokens: SECRET_SANTA_TURN_MAX_TOKENS,
        }),
      );
      return value;
    },
  };
  return sharedTurn;
}

// ---------------------------------------------------------------------------------------
// The line writer: every word Hale says about a Secret Santa.

export type SantaLinePurpose = 'group_done' | 'group_refusal' | 'giver_draw' | 'organizer_note';

export interface SantaLineRequest {
  purpose: SantaLinePurpose;
  language: string | null;
  facts: Readonly<Record<string, unknown>>;
  verbatim?: readonly string[];
}

export interface SecretSantaLineWriter {
  write(request: SantaLineRequest): Promise<string | null>;
}

/** The user-turn payload. Shared with the eval, which replays this request shape. */
export function secretSantaLineUserMessage(request: SantaLineRequest): string {
  return JSON.stringify({
    purpose: request.purpose,
    language: request.language,
    facts: request.facts,
    verbatim: request.verbatim ?? [],
  });
}

export const secretSantaLineJsonSchema = {
  type: 'object' as const,
  additionalProperties: false,
  properties: { text: { type: 'string' } },
  required: ['text'],
};

const lineSchema = z.object({ text: z.string() }).strict();

/**
 * Writes a line from facts, or null. Content capture is forced off for every call: a
 * giver's draw and the organizer's note name people, and one rule covers the module.
 */
export function createSecretSantaLineWriter(client: () => AgentClient): SecretSantaLineWriter {
  return {
    async write(request) {
      const skill = await loadCronSkill(SECRET_SANTA_LINE_SKILL);
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          const { value } = await withLlmContext({ stage: 'group', omitContent: true }, () =>
            forceToolJson({
              client: client(),
              lane: pickLane(skill.meta.task),
              system: skill.instructions,
              userMessage: secretSantaLineUserMessage(request),
              toolName: SECRET_SANTA_LINE_TOOL,
              toolDescription: SECRET_SANTA_LINE_TOOL_DESCRIPTION,
              inputJsonSchema: secretSantaLineJsonSchema,
              schema: lineSchema,
              maxTokens: SECRET_SANTA_LINE_MAX_TOKENS,
            }),
          );
          const text = value.text.trim();
          if (text) return text;
        } catch (err) {
          console.warn(
            { attempt, purpose: request.purpose, err: err instanceof Error ? err.name : 'unknown' },
            'secret santa: line write failed',
          );
        }
      }
      return null;
    },
  };
}

let sharedLine: SecretSantaLineWriter | null = null;
let lineOverride: SecretSantaLineWriter | null | undefined;

/** Tests install a writer here (intake builds no port for it); undefined restores the real one. */
export function setSharedSecretSantaLineWriter(writer: SecretSantaLineWriter | null | undefined) {
  lineOverride = writer;
}

/** Production writer, or null when no model may run: then nothing is sent, by name. */
export function sharedSecretSantaLineWriter(): SecretSantaLineWriter | null {
  if (lineOverride !== undefined) return lineOverride;
  if (!modelMayRun()) return null;
  sharedLine ??= createSecretSantaLineWriter(() =>
    budgetedAnthropic(HOT_SMS_CLIENT_OPTIONS, { stage: 'group' }),
  );
  return sharedLine;
}

// ---------------------------------------------------------------------------------------
// Rows.

type Draw = schema.SecretSantaDraw;
type Person = schema.LinqSharedGroupPerson;

/** The chat's live draw (collecting or drawn), or null. */
export async function liveSecretSantaDraw(
  database: Database,
  chatId: string,
): Promise<Draw | null> {
  const draws = schema.secretSantaDraws;
  const [row] = await database
    .select()
    .from(draws)
    .where(and(eq(draws.chatId, chatId), inArray(draws.status, ['collecting', 'drawn'])))
    .limit(1);
  return row ?? null;
}

/**
 * Whether Secret Santa can run in this chat: the flag and multi-family groups are on, and the
 * chat holds two Hale families (the gate the shared-group turn itself uses). The RSVP reader
 * is told so, and reads a Secret Santa ask as chatter rather than a plan.
 */
export async function secretSantaRunsInChat(database: Database, chatId: string): Promise<boolean> {
  if (!secretSantaEnabled() || !linqMultiFamilyGroupsEnabled()) return false;
  const people = await database
    .select({ familyId: schema.linqSharedGroupPeople.familyId })
    .from(schema.linqSharedGroupPeople)
    .where(
      and(
        eq(schema.linqSharedGroupPeople.chatId, chatId),
        isNotNull(schema.linqSharedGroupPeople.familyId),
      ),
    );
  if (new Set(people.map((row) => row.familyId)).size >= 2) return true;
  const joins = await database
    .select({ familyId: schema.linqMultiFamilyJoins.familyId })
    .from(schema.linqMultiFamilyJoins)
    .where(
      and(
        eq(schema.linqMultiFamilyJoins.chatId, chatId),
        isNull(schema.linqMultiFamilyJoins.leftAt),
        isNotNull(schema.linqMultiFamilyJoins.joinedAt),
      ),
    );
  return new Set(joins.map((row) => row.familyId)).size >= 2;
}

/** One indexed read: while a draw is collecting, its messages go to Secret Santa first. */
export async function chatHasCollectingDraw(database: Database, chatId: string): Promise<boolean> {
  const draws = schema.secretSantaDraws;
  const [row] = await database
    .select({ id: draws.id })
    .from(draws)
    .where(and(eq(draws.chatId, chatId), eq(draws.status, 'collecting')))
    .limit(1);
  return Boolean(row);
}

async function participantsOf(database: Database, drawId: string) {
  const participants = schema.secretSantaParticipants;
  return database
    .select({
      id: participants.id,
      personId: participants.personId,
      called: participants.called,
      joinedAt: participants.joinedAt,
    })
    .from(participants)
    .where(eq(participants.drawId, drawId))
    .orderBy(asc(participants.joinedAt), asc(participants.id));
}

async function organizerIsGone(database: Database, draw: Draw): Promise<boolean> {
  if (!draw.organizerPersonId) return true;
  const [row] = await database
    .select({ stoppedAt: schema.linqSharedGroupPeople.stoppedAt })
    .from(schema.linqSharedGroupPeople)
    .where(eq(schema.linqSharedGroupPeople.id, draw.organizerPersonId))
    .limit(1);
  return !row || row.stoppedAt !== null;
}

async function cancelDraw(database: Database, drawId: string, now: Date): Promise<boolean> {
  const draws = schema.secretSantaDraws;
  const [row] = await database
    .update(draws)
    .set({ status: 'cancelled', cancelledAt: now })
    .where(and(eq(draws.id, drawId), inArray(draws.status, ['collecting', 'drawn'])))
    .returning({ id: draws.id });
  return Boolean(row);
}

// ---------------------------------------------------------------------------------------
// One turn.

export interface SecretSantaTurnContext {
  chatId: string;
  text: string;
  language: string | null;
  providerMessageId: string;
  /** The person who sent this message. */
  speaker: Pick<Person, 'id'>;
  /** Their Hale family, when they are a customer. Only a customer may start a draw. */
  customer: { familyId: string; userId: string } | null;
  /** Everyone Hale has placed in this chat. */
  people: readonly Pick<Person, 'id'>[];
}

interface Snapshot {
  draw: Draw | null;
  input: SecretSantaTurnInput;
}

export type SecretSantaRead =
  | { kind: 'unavailable' }
  | { kind: 'unread' }
  | { kind: 'none' }
  | { kind: 'santa'; snapshot: Snapshot; decision: SecretSantaDecision };

async function snapshotFor(database: Database, context: SecretSantaTurnContext): Promise<Snapshot> {
  const draw = await liveSecretSantaDraw(database, context.chatId);
  const rows = draw ? await participantsOf(database, draw.id) : [];
  const refOf = new Map(context.people.map((person, index) => [person.id, `p${index + 1}`]));
  return {
    draw,
    input: {
      text: context.text,
      language: context.language,
      speaker: refOf.get(context.speaker.id) ?? 'unknown',
      people: context.people.map((_, index) => ({ ref: `p${index + 1}` })),
      santa: {
        status: draw?.status === 'collecting' || draw?.status === 'drawn' ? draw.status : 'none',
        youAreOrganizer: draw !== null && draw.organizerPersonId === context.speaker.id,
        participants: rows.slice(0, SECRET_SANTA_READ_MAX).map((row) => ({
          ref: refOf.get(row.personId) ?? 'someone',
          called: row.called,
        })),
        count: rows.length,
        minimum: SECRET_SANTA_MIN_PARTICIPANTS,
      },
    },
  };
}

/** Reads this message against the chat's draw. Writes nothing. */
export async function readSecretSantaTurn(
  database: Database,
  context: SecretSantaTurnContext,
  model: SecretSantaTurnModel | null,
): Promise<SecretSantaRead> {
  if (!model) {
    console.warn({ outcome: 'secret_santa_model_unavailable' }, 'secret santa: turn not read');
    return { kind: 'unavailable' };
  }
  const snapshot = await snapshotFor(database, context);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const decision = parseSecretSantaDecision(await model.decide(snapshot.input));
      if (decision === 'none') return { kind: 'none' };
      if (decision !== null) return { kind: 'santa', snapshot, decision };
      console.warn({ attempt }, 'secret santa: malformed turn read');
    } catch (err) {
      console.warn(
        { attempt, err: err instanceof Error ? err.name : 'unknown' },
        'secret santa: turn read failed',
      );
    }
  }
  console.error({ outcome: 'secret_santa_unread' }, 'secret santa: nothing written');
  return { kind: 'unread' };
}

export type SantaRefusal =
  | 'too_few'
  | 'unnamed'
  | 'not_organizer'
  | 'name_needed'
  | 'name_taken'
  | 'already_drawn';

export type SantaOutcome =
  | 'started'
  | 'restarted'
  | 'joined'
  | 'left'
  | 'cancelled'
  | 'drawn'
  | 'already_drawn'
  | 'asked'
  | SantaRefusal;

export type SantaLineWhy = 'model' | 'quiet' | 'withheld' | 'unwritten';

export interface SantaGroupLine {
  text: string;
  templateKey: string;
  dedupeKey: string;
}

export type SecretSantaTurnResult =
  | { handled: false; why: 'unavailable' | 'unread' | 'none' | 'failed' | 'not_ours' }
  | {
      handled: true;
      drawId: string;
      outcomes: SantaOutcome[];
      line: SantaGroupLine | null;
      lineWhy: SantaLineWhy;
      /** Set when this turn drew the names: how many are in. */
      drawn: { participants: number } | null;
    };

export type DrawResult =
  | { outcome: 'drawn'; participants: number; waiting: number }
  | { outcome: 'already_drawn' }
  | { outcome: 'too_few'; count: number }
  | { outcome: 'unnamed'; count: number };

/**
 * Draws once. Under the draw row's lock: a second draw, a redelivered draw and a join
 * racing it all see `drawn` and change nothing. Stopped people are left out, never a reason
 * to refuse. Every pointer is written in one statement (writePairings).
 */
export async function drawSecretSanta(
  database: Database,
  drawId: string,
  now: Date,
  rand?: (max: number) => number,
): Promise<DrawResult> {
  const draws = schema.secretSantaDraws;
  const participants = schema.secretSantaParticipants;
  const people = schema.linqSharedGroupPeople;
  const result = await database.transaction(async (tx): Promise<DrawResult> => {
    const [draw] = await tx
      .select({ status: draws.status })
      .from(draws)
      .where(eq(draws.id, drawId))
      .for('update');
    if (draw?.status !== 'collecting') return { outcome: 'already_drawn' };
    const rows = await tx
      .select({
        id: participants.id,
        called: participants.called,
        stoppedAt: people.stoppedAt,
      })
      .from(participants)
      .innerJoin(people, eq(people.id, participants.personId))
      .where(eq(participants.drawId, drawId));
    const live = rows.filter((row) => row.stoppedAt === null);
    const unnamed = live.filter((row) => !row.called).length;
    if (unnamed > 0) return { outcome: 'unnamed', count: unnamed };
    if (live.length < SECRET_SANTA_MIN_PARTICIPANTS) {
      return { outcome: 'too_few', count: live.length };
    }
    const stopped = rows.filter((row) => row.stoppedAt !== null).map((row) => row.id);
    if (stopped.length > 0) {
      await tx
        .update(participants)
        .set({ heldReason: 'stopped' })
        .where(inArray(participants.id, stopped));
    }
    await tx.update(draws).set({ status: 'drawn', drawnAt: now }).where(eq(draws.id, drawId));
    await writePairings(
      tx as unknown as Database,
      drawId,
      live.map((row) => row.id),
      rand,
    );
    return { outcome: 'drawn', participants: live.length, waiting: 0 };
  });
  if (result.outcome !== 'drawn') return result;
  return { ...result, waiting: await waitingCount(database, drawId) };
}

/** Givers with no Hale channel yet: their draw waits on their own first text. */
async function waitingCount(database: Database, drawId: string): Promise<number> {
  const rows = await database
    .select({ hash: schema.linqSharedGroupPeople.phoneE164Hash })
    .from(schema.secretSantaParticipants)
    .innerJoin(
      schema.linqSharedGroupPeople,
      eq(schema.linqSharedGroupPeople.id, schema.secretSantaParticipants.personId),
    )
    .where(
      and(
        eq(schema.secretSantaParticipants.drawId, drawId),
        isNull(schema.secretSantaParticipants.heldReason),
      ),
    );
  let waiting = 0;
  for (const row of rows) {
    if (!(await resolveVerifiedChannelByHash(database, row.hash))) waiting += 1;
  }
  return waiting;
}

/** Names of everyone in the draw, for the group-line check. */
async function namesIn(database: Database, drawId: string): Promise<string[]> {
  return (await participantsOf(database, drawId)).flatMap((row) => (row.called ? [row.called] : []));
}

/** The done line, written from counts only. Shared with the sweep's backstop. */
export async function composeSantaDoneLine(
  database: Database,
  input: { drawId: string; language: string | null; participants: number; waiting: number },
  writer: SecretSantaLineWriter | null,
): Promise<{ line: SantaGroupLine } | { why: 'withheld' | 'unwritten' }> {
  if (!writer) return { why: 'unwritten' };
  const text = await writer.write({
    purpose: 'group_done',
    language: input.language,
    facts: { participants: input.participants, waiting: input.waiting },
  });
  if (!text) return { why: 'unwritten' };
  const participants = await namesIn(database, input.drawId);
  if (!santaGroupLineUsable(text, { participants, allowed: [] })) {
    console.warn({ outcome: 'secret_santa_line_unusable' }, 'secret santa: done line not sent');
    return { why: 'withheld' };
  }
  return {
    line: {
      text,
      templateKey: SANTA_DONE_TEMPLATE,
      dedupeKey: `${SANTA_DONE_TEMPLATE}:${input.drawId}`,
    },
  };
}

async function join(
  database: Database,
  input: { drawId: string; personId: string; called: string | null; now: Date },
): Promise<'joined' | 'closed'> {
  const draws = schema.secretSantaDraws;
  const participants = schema.secretSantaParticipants;
  return database.transaction(async (tx) => {
    const [draw] = await tx
      .select({ status: draws.status })
      .from(draws)
      .where(eq(draws.id, input.drawId))
      .for('share');
    if (draw?.status !== 'collecting') return 'closed';
    await tx
      .insert(participants)
      .values({
        drawId: input.drawId,
        personId: input.personId,
        called: input.called,
        joinedAt: input.now,
      })
      .onConflictDoUpdate({
        target: [participants.drawId, participants.personId],
        set: { called: sql`coalesce(excluded.called, ${participants.called})` },
      });
    return 'joined';
  });
}

/**
 * Applies a read made on this same message. Each action is checked against the rows as
 * they are now; the model's line is sent only when nothing came out differently from what
 * it saw, and every other outcome gets its own model-written line from facts.
 */
export async function applySecretSantaTurn(
  database: Database,
  context: SecretSantaTurnContext,
  read: SecretSantaRead | { kind: 'failed' },
  options: { now: Date; writer: SecretSantaLineWriter | null; rand?: (max: number) => number },
): Promise<SecretSantaTurnResult> {
  if (read.kind !== 'santa') return { handled: false, why: read.kind };
  const { decision } = read;
  const speaker = context.speaker.id;
  const outcomes: SantaOutcome[] = [];
  const refusals: { outcome: SantaRefusal; count?: number }[] = [];
  let draw = await liveSecretSantaDraw(database, context.chatId);
  let drawn: Extract<DrawResult, { outcome: 'drawn' }> | null = null;
  const draws = schema.secretSantaDraws;

  if (decision.cancel && draw) {
    if (draw.organizerPersonId !== speaker) {
      refusals.push({ outcome: 'not_organizer' });
    } else if (await cancelDraw(database, draw.id, options.now)) {
      outcomes.push('cancelled');
      draw = null;
    }
  }

  if (decision.start && context.customer) {
    if (draw && (await organizerIsGone(database, draw))) {
      await cancelDraw(database, draw.id, options.now);
      draw = null;
      outcomes.push('restarted');
    }
    if (!draw) {
      const [created] = await database
        .insert(draws)
        .values({
          chatId: context.chatId,
          organizerPersonId: speaker,
          organizerFamilyId: context.customer.familyId,
          organizerUserId: context.customer.userId,
          status: 'collecting',
          language: decision.language,
          startedAt: options.now,
        })
        .onConflictDoNothing()
        .returning();
      draw = created ?? (await liveSecretSantaDraw(database, context.chatId));
      if (created && !outcomes.includes('restarted')) outcomes.push('started');
    }
  }

  // A guest's start, or a word about a draw that does not exist, is not this door's turn.
  if (!draw && !outcomes.includes('cancelled')) return { handled: false, why: 'not_ours' };
  const drawId = draw?.id ?? (read.snapshot.draw?.id as string);

  if (decision.join && draw) {
    const others = (await participantsOf(database, draw.id)).filter(
      (row) => row.personId !== speaker && row.called,
    );
    const checked = checkCalled(
      decision.join.called,
      context.text,
      others.map((row) => row.called as string),
    );
    const called = 'called' in checked ? checked.called : null;
    const joined = await join(database, {
      drawId: draw.id,
      personId: speaker,
      called,
      now: options.now,
    });
    if (joined === 'closed') {
      refusals.push({ outcome: 'already_drawn' });
    } else {
      outcomes.push('joined');
      const [mine] = await database
        .select({ called: schema.secretSantaParticipants.called })
        .from(schema.secretSantaParticipants)
        .where(
          and(
            eq(schema.secretSantaParticipants.drawId, draw.id),
            eq(schema.secretSantaParticipants.personId, speaker),
          ),
        );
      if ('fact' in checked && !mine?.called) refusals.push({ outcome: checked.fact });
    }
  }

  if (decision.leave && draw?.status === 'collecting' && !decision.join) {
    const removed = await database
      .delete(schema.secretSantaParticipants)
      .where(
        and(
          eq(schema.secretSantaParticipants.drawId, draw.id),
          eq(schema.secretSantaParticipants.personId, speaker),
        ),
      )
      .returning({ id: schema.secretSantaParticipants.id });
    if (removed.length > 0) outcomes.push('left');
  }

  if (decision.draw && draw) {
    if (draw.organizerPersonId !== speaker) {
      refusals.push({ outcome: 'not_organizer' });
    } else {
      const result = await drawSecretSanta(database, draw.id, options.now, options.rand);
      if (result.outcome === 'drawn') {
        drawn = result;
        outcomes.push('drawn');
      } else if (result.outcome === 'already_drawn') {
        outcomes.push('already_drawn');
      } else {
        refusals.push({ outcome: result.outcome, count: result.count });
      }
    }
  }

  if (outcomes.length === 0 && refusals.length === 0) outcomes.push('asked');
  const fresh = await database
    .select({ status: draws.status, language: draws.language })
    .from(draws)
    .where(eq(draws.id, drawId))
    .limit(1);
  const status = fresh[0]?.status ?? 'cancelled';
  const language = fresh[0]?.language ?? decision.language;
  const participants = await namesIn(database, drawId);
  const done = (lineWhy: SantaLineWhy, line: SantaGroupLine | null): SecretSantaTurnResult => ({
    handled: true,
    drawId,
    outcomes: [...outcomes, ...refusals.map((r) => r.outcome)],
    line,
    lineWhy,
    drawn: drawn ? { participants: drawn.participants } : null,
  });

  const refusal = refusals[0];
  if (refusal) {
    if (!options.writer) return done('unwritten', null);
    const text = await options.writer.write({
      purpose: 'group_refusal',
      language,
      facts: {
        outcome: refusal.outcome,
        ...(refusal.count !== undefined ? { count: refusal.count } : {}),
        minimum: SECRET_SANTA_MIN_PARTICIPANTS,
      },
    });
    if (!text) return done('unwritten', null);
    if (!santaGroupLineUsable(text, { participants, allowed: [] })) return done('withheld', null);
    return done('model', {
      text,
      templateKey: SANTA_REFUSAL_TEMPLATE,
      dedupeKey: `${SANTA_REFUSAL_TEMPLATE}:${context.providerMessageId}`,
    });
  }
  if (drawn) {
    const composed = await composeSantaDoneLine(
      database,
      { drawId, language, participants: drawn.participants, waiting: drawn.waiting },
      options.writer,
    );
    return 'line' in composed ? done('model', composed.line) : done(composed.why, null);
  }
  if (outcomes.includes('already_drawn')) return done('quiet', null);
  const reply = decision.reply;
  if (!reply) return done('quiet', null);
  // While collecting, the chat itself said every name; after the draw, a group line names
  // nobody.
  const allowed = status === 'collecting' ? participants : [];
  if (!santaGroupLineUsable(reply, { participants, allowed })) {
    console.warn({ outcome: 'secret_santa_line_unusable' }, 'secret santa: line not sent');
    return done('withheld', null);
  }
  return done('model', {
    text: reply,
    templateKey: SANTA_TURN_TEMPLATE,
    dedupeKey: `${SANTA_TURN_TEMPLATE}:${context.chatId}:${context.providerMessageId}`,
  });
}

// ---------------------------------------------------------------------------------------
// Leaving, stopping and retention. None of these reads the flag, and none decrypts.

/**
 * People whose presence rows are being forgotten (they left the chat, Hale left, or their
 * family was erased). Their participant rows go now: a stopped person's row is kept as a
 * tombstone, so the cascade alone would not reach theirs. A drawn draw that loses anyone
 * goes stale, and every giver not yet told is held: no row says which giver drew the
 * person who left, so the hold is the whole draw's. A collecting draw whose organizer is
 * going is cancelled.
 */
export async function forgetSecretSantaPeople(
  database: Database,
  personIds: readonly string[],
  now: Date,
): Promise<void> {
  if (personIds.length === 0) return;
  const ids = [...personIds];
  const draws = schema.secretSantaDraws;
  const participants = schema.secretSantaParticipants;
  const lost = await database
    .delete(participants)
    .where(inArray(participants.personId, ids))
    .returning({ drawId: participants.drawId });
  const touched = [...new Set(lost.map((row) => row.drawId))];
  if (touched.length > 0) {
    const stale = await database
      .update(draws)
      .set({ staleAt: sql`coalesce(${draws.staleAt}, ${now.toISOString()}::timestamptz)` })
      .where(and(inArray(draws.id, touched), eq(draws.status, 'drawn')))
      .returning({ id: draws.id });
    if (stale.length > 0) {
      await database
        .update(participants)
        .set({ heldReason: 'draw_stale' })
        .where(
          and(
            inArray(
              participants.drawId,
              stale.map((row) => row.id),
            ),
            isNull(participants.deliveredAt),
          ),
        );
    }
  }
  await database
    .update(draws)
    .set({ status: 'cancelled', cancelledAt: now })
    .where(and(inArray(draws.organizerPersonId, ids), eq(draws.status, 'collecting')));
  if (lost.length > 0) {
    console.info(
      { outcome: 'secret_santa_people_forgotten', count: lost.length, draws: touched.length },
      'secret santa: participants forgotten',
    );
  }
}

/**
 * A 1:1 STOP from this number (intake's handleStop): any Secret Santa draw not yet sent to
 * it is held as opted out and never sent, even when the number never had a Hale channel to
 * revoke. Only a verified channel on that number later (they enrolled again) lifts it.
 */
export async function optOutSecretSantaOnStop(
  database: Database,
  phoneE164: string,
): Promise<void> {
  const people = database
    .select({ id: schema.linqSharedGroupPeople.id })
    .from(schema.linqSharedGroupPeople)
    .where(eq(schema.linqSharedGroupPeople.phoneE164Hash, phoneBlindIndex(phoneE164)));
  await database
    .update(schema.secretSantaParticipants)
    .set({ heldReason: 'opted_out' })
    .where(
      and(
        inArray(schema.secretSantaParticipants.personId, people),
        isNull(schema.secretSantaParticipants.deliveredAt),
      ),
    );
}

/** A group STOP: out of any collecting draw; never texted a drawn one. */
export async function stopSecretSantaPerson(
  database: Database,
  personId: string,
): Promise<void> {
  const draws = schema.secretSantaDraws;
  const participants = schema.secretSantaParticipants;
  const collecting = database
    .select({ id: draws.id })
    .from(draws)
    .where(eq(draws.status, 'collecting'));
  const drawn = database.select({ id: draws.id }).from(draws).where(eq(draws.status, 'drawn'));
  await database
    .delete(participants)
    .where(and(eq(participants.personId, personId), inArray(participants.drawId, collecting)));
  await database
    .update(participants)
    .set({ heldReason: 'stopped' })
    .where(
      and(
        eq(participants.personId, personId),
        isNull(participants.deliveredAt),
        inArray(participants.drawId, drawn),
      ),
    );
}

/**
 * Whatever the flag says: a collecting draw left for 14 days, or whose organizer is gone
 * or stopped, is cancelled; a drawn or cancelled draw is deleted 45 days on, with every row
 * under it. Counts only.
 */
export async function sweepSecretSantaRetention(
  database: Database,
  now: Date,
): Promise<{ cancelled: number; deleted: number }> {
  const draws = schema.secretSantaDraws;
  const people = schema.linqSharedGroupPeople;
  const stoppedOrganizers = database
    .select({ id: people.id })
    .from(people)
    .where(isNotNull(people.stoppedAt));
  const cancelled = await database
    .update(draws)
    .set({ status: 'cancelled', cancelledAt: now })
    .where(
      and(
        eq(draws.status, 'collecting'),
        or(
          lt(draws.startedAt, new Date(now.getTime() - SANTA_COLLECTING_MAX_MS)),
          isNull(draws.organizerPersonId),
          inArray(draws.organizerPersonId, stoppedOrganizers),
        ),
      ),
    )
    .returning({ id: draws.id });
  const cutoff = new Date(now.getTime() - SANTA_RETENTION_MS);
  const deleted = await database
    .delete(draws)
    .where(or(lt(draws.drawnAt, cutoff), lt(draws.cancelledAt, cutoff)))
    .returning({ id: draws.id });
  return { cancelled: cancelled.length, deleted: deleted.length };
}
