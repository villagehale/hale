import { type Database, schema } from '@hale/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { ReplyLanguage } from '~/lib/channel/language';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { decryptString, encryptString } from '~/lib/crypto/string-cipher';
import type { IntakeCollected } from './extract';

/**
 * VIL-237 · M2 — reading and writing the intake session, the row that carries the
 * state machine's STATE between texts.
 *
 * The state is stored, never inferred. Inferring it from the transcript ("their second
 * message must be the postal code") is wrong the first time a parent sends two texts
 * in a row, answers out of order, or a carrier retries a webhook — and the failure is
 * silent, because there is always SOME plausible reading of a transcript.
 *
 * Everything the parent said lives in `data_encrypted` (AES-GCM). It is child PII
 * collected before any family, consent row, or account exists (rule #1), so it is
 * encrypted at rest here, and replayed into channel_messages the moment provisioning
 * gives it a family to belong to.
 */

export type IntakeState =
  /** Greeting sent; waiting for the parent's free-form answer. */
  | 'awaiting_details'
  /** The one targeted follow-up has been asked; waiting for the missing field. */
  | 'awaiting_follow_up'
  /** Family provisioned, watch-offer sent; waiting for yes/no. */
  | 'awaiting_watch_reply'
  /** The one gentle clarification has been asked; waiting for yes/no. */
  | 'awaiting_clarify'
  /**
   * The year find already went out, and with it the turtle card when that share
   * lands and the next visible ask. The next inbound settles exactly one later
   * ladder beat. The column is text, so this state needs no migration.
   */
  | 'awaiting_ladder'
  /** The flow finished (watch-offer answered, or the region gate refused). */
  | 'complete'
  /** The parent sent STOP. Terminal. */
  | 'stopped'
  /** A co-parent join link arrived on this number and outranked the conversation.
   * Terminal, and deliberately not `complete`: nothing was assembled here, and a row
   * that claimed otherwise would read as a household that finished intake. */
  | 'superseded';

/** One later job. The year-find turn already sent the card, when it shares, and the next ask. */
export type IntakeLadderStep = 'turtle' | 'name' | 'name_reply' | 'calendar' | 'gmail' | 'coparent';

const LADDER_STEPS: readonly IntakeLadderStep[] = [
  'turtle',
  'name',
  'name_reply',
  'calendar',
  'gmail',
  'coparent',
];

export interface TranscriptEntry {
  direction: 'in' | 'out';
  body: string;
  providerId: string | null;
  at: string;
  /** Absent on a session written before iMessage. Replay treats absent as sms. */
  channel?: 'sms' | 'imessage';
  /** Linq chat id when `channel` is imessage. Replay writes it onto the ledger row. */
  chatId?: string | null;
}

interface IntakeData {
  collected: IntakeCollected;
  transcript: TranscriptEntry[];
  /**
   * The first reply named at least one age-fit thing. Missing on a session written
   * before this field existed, which decodes as false.
   */
  findWon?: boolean;
  /** The next single job. Absent on a session written before the ladder gate. */
  ladderNext?: IntakeLadderStep | null;
  /** Language of the kids-and-postal text. Later replies must not re-pick it. */
  ladderLanguage?: ReplyLanguage | null;
}

export interface IntakeSession {
  id: string;
  phoneHash: string;
  phoneE164: string;
  state: IntakeState;
  sourceCode: string | null;
  collected: IntakeCollected;
  transcript: TranscriptEntry[];
  followUpCount: number;
  clarifyCount: number;
  familyId: string | null;
  userId: string | null;
  lastProviderId: string | null;
  /** True once the first reply named an age-fit thing. False until then, including a
   * blob that predates the field. */
  findWon: boolean;
  /** Null until the year-find turn parks the conversation on the ladder. */
  ladderNext: IntakeLadderStep | null;
  ladderLanguage: ReplyLanguage | null;
}

export const EMPTY_COLLECTED: IntakeCollected = { children: [], postalCode: null };

function encodeData(data: IntakeData): string {
  return encryptString(JSON.stringify(data));
}

function decodeLadderNext(value: unknown): IntakeLadderStep | null {
  return typeof value === 'string' && (LADDER_STEPS as readonly string[]).includes(value)
    ? (value as IntakeLadderStep)
    : null;
}

function decodeLadderLanguage(value: unknown): ReplyLanguage | null {
  return value === 'en' || value === 'fr' ? value : null;
}

function decodeData(blob: string): IntakeData {
  // Decryption is authenticated (GCM), so a tampered or wrong-key blob throws rather
  // than returning garbage. That is the intended behaviour — a session we cannot read
  // must fail loudly, never silently restart the conversation (rule #8).
  const parsed = JSON.parse(decryptString(blob)) as Partial<IntakeData>;
  return {
    collected: parsed.collected ?? EMPTY_COLLECTED,
    transcript: parsed.transcript ?? [],
    findWon: parsed.findWon === true,
    ladderNext: decodeLadderNext(parsed.ladderNext),
    ladderLanguage: decodeLadderLanguage(parsed.ladderLanguage),
  };
}

/** The open session for this number, or null when this is a first contact. */
export async function loadOpenSession(
  database: Database,
  phoneE164: string,
): Promise<IntakeSession | null> {
  const phoneHash = phoneBlindIndex(phoneE164);
  const [row] = await database
    .select()
    .from(schema.smsIntakeSessions)
    .where(
      and(
        eq(schema.smsIntakeSessions.phoneHash, phoneHash),
        isNull(schema.smsIntakeSessions.closedAt),
      ),
    )
    .limit(1);
  if (!row) return null;

  const data = decodeData(row.dataEncrypted);
  return {
    id: row.id,
    phoneHash: row.phoneHash,
    phoneE164: decryptString(row.phoneEncrypted),
    state: row.state as IntakeState,
    sourceCode: row.sourceCode,
    collected: data.collected,
    transcript: data.transcript,
    followUpCount: row.followUpCount,
    clarifyCount: row.clarifyCount,
    familyId: row.familyId,
    userId: row.userId,
    lastProviderId: row.lastProviderId,
    findWon: data.findWon === true,
    ladderNext: data.ladderNext ?? null,
    ladderLanguage: data.ladderLanguage ?? null,
  };
}

/**
 * Try to open a session for this number — and hand back null when one is already open.
 *
 * The INSERT is the claim. `sms_intake_sessions_phone_open_idx` is unique on the phone
 * hash where `closed_at IS NULL`, so exactly one caller can win a conversation with a
 * given number, and winning it is what confers the right to speak first. A
 * select-then-insert guard is a guard both racers walk through, and the two doors onto
 * intake can now fire at the same moment: a parent who texts while their own call is
 * still being answered would otherwise be greeted twice.
 *
 * Null is a first-class answer, not a failure — see {@link createSession} for the caller
 * that treats it as one.
 */
export async function claimIntakeSession(
  database: Database,
  input: { phoneE164: string; state: IntakeState; sourceCode: string | null },
): Promise<IntakeSession | null> {
  const phoneHash = phoneBlindIndex(input.phoneE164);
  const [row] = await database
    .insert(schema.smsIntakeSessions)
    .values({
      phoneHash,
      phoneEncrypted: encryptString(input.phoneE164),
      state: input.state,
      sourceCode: input.sourceCode,
      dataEncrypted: encodeData({ collected: EMPTY_COLLECTED, transcript: [] }),
    })
    .onConflictDoNothing({
      target: schema.smsIntakeSessions.phoneHash,
      where: sql`${schema.smsIntakeSessions.closedAt} IS NULL`,
    })
    .returning({ id: schema.smsIntakeSessions.id });
  if (!row) return null;
  return {
    id: row.id,
    phoneHash,
    phoneE164: input.phoneE164,
    state: input.state,
    sourceCode: input.sourceCode,
    collected: EMPTY_COLLECTED,
    transcript: [],
    followUpCount: 0,
    clarifyCount: 0,
    familyId: null,
    userId: null,
    lastProviderId: null,
    findWon: false,
    ladderNext: null,
    ladderLanguage: null,
  };
}

/** Open a session for a number we have never heard from. The machine has already read
 * `loadOpenSession` and found nothing, so a lost claim here is a genuine race with the
 * other door — and there is no sane way to continue this turn, because the greeting it
 * was about to send belongs to whoever won. */
export async function createSession(
  database: Database,
  input: { phoneE164: string; state: IntakeState; sourceCode: string | null },
): Promise<IntakeSession> {
  const session = await claimIntakeSession(database, input);
  if (!session) {
    throw new Error('createSession: sms_intake_sessions insert returned no row');
  }
  return session;
}

export interface SessionPatch {
  state?: IntakeState;
  collected?: IntakeCollected;
  transcript?: TranscriptEntry[];
  followUpCount?: number;
  clarifyCount?: number;
  familyId?: string;
  userId?: string;
  lastProviderId?: string;
  closedAt?: Date;
  /** Stamped when a first-hello is persisted — live greet or VIL-332 recovery. */
  firstReplyRecoveredAt?: Date;
  /** Set when the first reply is composed. Omitted patches keep the value already
   * on the session, so a later save cannot forget a win. */
  findWon?: boolean;
  /** Undefined keeps the stored step. Null clears it (the co-parent beat closes). */
  ladderNext?: IntakeLadderStep | null;
  ladderLanguage?: ReplyLanguage | null;
}

/** Persist a state transition. `collected`/`transcript` are re-encrypted together. */
export async function saveSession(
  database: Database,
  session: IntakeSession,
  patch: SessionPatch,
  now: Date,
): Promise<void> {
  const collected = patch.collected ?? session.collected;
  const transcript = patch.transcript ?? session.transcript;
  const findWon = patch.findWon ?? session.findWon;
  const ladderNext = patch.ladderNext === undefined ? session.ladderNext : patch.ladderNext;
  const ladderLanguage =
    patch.ladderLanguage === undefined ? session.ladderLanguage : patch.ladderLanguage;
  await database
    .update(schema.smsIntakeSessions)
    .set({
      ...(patch.state ? { state: patch.state } : {}),
      dataEncrypted: encodeData({ collected, transcript, findWon, ladderNext, ladderLanguage }),
      ...(patch.followUpCount === undefined ? {} : { followUpCount: patch.followUpCount }),
      ...(patch.clarifyCount === undefined ? {} : { clarifyCount: patch.clarifyCount }),
      ...(patch.familyId ? { familyId: patch.familyId } : {}),
      ...(patch.userId ? { userId: patch.userId } : {}),
      ...(patch.lastProviderId ? { lastProviderId: patch.lastProviderId } : {}),
      ...(patch.closedAt ? { closedAt: patch.closedAt } : {}),
      ...(patch.firstReplyRecoveredAt
        ? { firstReplyRecoveredAt: patch.firstReplyRecoveredAt }
        : {}),
      updatedAt: now,
    })
    .where(eq(schema.smsIntakeSessions.id, session.id));
}

export function appendTranscript(
  session: IntakeSession,
  entry: TranscriptEntry,
): TranscriptEntry[] {
  return [...session.transcript, entry];
}

/** True when Hale has already spoken on this session — transcript outbound, not
 * channel_messages. Pre-family sends have no ledger row they could occupy. */
export function transcriptHasOutbound(transcript: readonly TranscriptEntry[]): boolean {
  return transcript.some((entry) => entry.direction === 'out');
}

/** The encrypted transcript only, for recovery sweeps that have the blob and
 * must not decrypt the phone until they have decided to send. */
export function decodeIntakeTranscript(dataEncrypted: string): TranscriptEntry[] {
  return decodeData(dataEncrypted).transcript;
}
