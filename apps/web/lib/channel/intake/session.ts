import { type Database, schema } from '@hale/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { ReplyLanguage } from '~/lib/channel/language';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { decryptString, encryptString } from '~/lib/crypto/string-cipher';
import { haleContactCardDay } from '../linq/contact-card';
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
  /** VIL-385. Place ask sent. One ask, no reminder. */
  | 'awaiting_place'
  /** VIL-385. Week find sent, ages asked. Waiting for ages. */
  | 'awaiting_ages'
  /** The one targeted follow-up has been asked; waiting for the missing field. */
  | 'awaiting_follow_up'
  /** Family provisioned, watch-offer sent; waiting for yes/no. */
  | 'awaiting_watch_reply'
  /** The one gentle clarification has been asked; waiting for yes/no. */
  | 'awaiting_clarify'
  /**
   * The year find already went out, and with it the next visible ask. The Linq
   * Name and Photo share, when it lands, went out on the first outbound. The
   * next inbound settles exactly one later ladder beat. The column is text, so
   * this state needs no migration.
   */
  | 'awaiting_ladder'
  /**
   * VIL-392. The age-fit find already went out and Hale is waiting for a pick,
   * then one logistics answer. The column is text, so this state needs no
   * migration.
   */
  | 'awaiting_cold_start'
  /** The flow finished (watch-offer answered, or the region gate refused). */
  | 'complete'
  /** The parent sent STOP. Terminal. */
  | 'stopped'
  /** A co-parent join link arrived on this number and outranked the conversation.
   * Terminal, and deliberately not `complete`: nothing was assembled here, and a row
   * that claimed otherwise would read as a household that finished intake. */
  | 'superseded';

/** One later job. The year-find turn already sent the next ask. The Linq card, when it shares, left on the first outbound. */
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
  /**
   * Pre-family record of the Linq Name and Photo share. Parent channels do
   * not exist yet, so it lives here until provisioning copies a held claim
   * onto parent_channels.linq_contact_card_shared_at. Absent means unclaimed.
   * `share_refused` stays consumed for that Toronto day so a retry cannot
   * push the card twice. `unreachable` never reached the chat: it is kept so
   * the failure is still on the session, and it does not consume the day.
   */
  linqContactCardClaim?: LinqContactCardClaim | null;
  /** VIL-385. Absent means this session is not on the ladder. */
  firstTouch?: FirstTouchPersisted | null;
}

/** Coarse place plus the location-card outcome. No street, no coordinates. */
export interface FirstTouchPersisted {
  language: ReplyLanguage;
  place: {
    kind: 'postal' | 'city';
    areaCoarse: string;
    postalCode: string | null;
    municipality: string | null;
    city: string | null;
  } | null;
  locationRequest: {
    at: string;
    outcome:
      | 'sent'
      | 'refused'
      | 'not_configured'
      | 'unreachable'
      | 'skipped_group'
      | 'not_a_moment'
      | 'skipped';
    code?: string;
  } | null;
  /**
   * VIL-392. Absent until the discovery find has been sent. `pick` waits for
   * a number. `logistics` waits for who is taking them.
   */
  coldStart?: ColdStartProgress | null;
  /** Re-asks on the open place or ages step. Absent means zero. */
  clarify?: FirstTouchClarify | null;
  /**
   * Facts the onboarding model already took from a message, before the step
   * that would have asked for them. Absent means nothing extra is stored.
   */
  given?: FirstTouchGiven | null;
}

/** Name, pick, and connector answers captured ahead of the ask that would have used them. */
export interface FirstTouchGiven {
  parentName: string | null;
  activityPick: number | null;
  connectCalendar: boolean | null;
  connectGmail: boolean | null;
  /** True once they declined the parent-name ask. Absent on older sessions. */
  nameDeclined?: boolean;
  /** True once they declined the kids'-names ask. */
  kidsNamesDeclined?: boolean;
  /** True once they said later to the calendar. */
  calendarLater?: boolean;
  /** True once they said later to email. */
  gmailLater?: boolean;
}

export interface ColdStartProgress {
  step: 'pick' | 'logistics' | 'names' | 'follow';
  group: boolean;
  findBody: string;
  activity: string | null;
  day: string | null;
  /** The names line has already been sent. Calendar may ride the next reply. */
  nameLineSent: boolean;
  /** The picked line says when sign-ups open. Otherwise the offer uses the day. */
  signupDateKnown: boolean;
  signupAsked: boolean;
  calendarAsked: boolean;
  emailAsked: boolean;
  schoolMentioned: boolean;
  /** The calendar link has already gone out. A later reply does not send it again. */
  calendarOffered?: boolean;
  /** The email link has already gone out. */
  emailOffered?: boolean;
}

/** How many times this ladder step was asked again after a non-answer. */
export interface FirstTouchClarify {
  place: number;
  ages: number;
}

/**
 * The last Name and Photo attempt on this pre-family session.
 * `unreachable` did not reach share — see {@link linqContactCardClaimHeld}.
 * A `shared` or `share_refused` claim blocks only that chat for that Toronto
 * day — see {@link linqContactCardShareBlocked}.
 */
export interface LinqContactCardClaim {
  at: string;
  outcome: 'shared' | 'share_refused' | 'unreachable';
  /** The iMessage chat this attempt was for. Absent on a claim written before per-chat days. */
  chatId?: string;
  code?: string;
  /**
   * Pre-family setup failures so far this Toronto day. The first hello counts
   * as one, including its in-turn retry. The next outbound is the second.
   */
  attempts?: number;
}

/**
 * True when a share was attempted, so provisioning can copy the timestamp.
 * A failed setup did not. This is not the once-per-day gate.
 */
export function linqContactCardClaimHeld(claim: LinqContactCardClaim | null): boolean {
  return claim != null && claim.outcome !== 'unreachable';
}

/**
 * True when this chat should not be shared again today.
 * A claim with no chat id blocks every chat for that day (an older share
 * that did not record which chat).
 * Two unreachable setups today wait until tomorrow. A previous day does not block.
 */
export function linqContactCardShareBlocked(
  claim: LinqContactCardClaim | null,
  chatId: string,
  now: Date,
): boolean {
  if (!claim) return false;
  const at = new Date(claim.at);
  if (Number.isNaN(at.getTime())) return false;
  if (haleContactCardDay(at) !== haleContactCardDay(now)) return false;
  if (claim.chatId && claim.chatId !== chatId) return false;
  if (claim.outcome === 'unreachable') return (claim.attempts ?? 1) >= 2;
  return true;
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
  /** Null until a pre-family iMessage share records the last attempt time. */
  linqContactCardClaim: LinqContactCardClaim | null;
  /**
   * VIL-385. Absent on a session that started before the ladder, which decodes
   * as null. The place is coarse (FSA or city). A location-card outcome is
   * named here until provisioning can write the audit row.
   */
  firstTouch: FirstTouchPersisted | null;
}

export const EMPTY_COLLECTED: IntakeCollected = { children: [], postalCode: null };

function encodeData(data: IntakeData): string {
  const payload: IntakeData = {
    collected: data.collected,
    transcript: data.transcript,
    findWon: data.findWon,
    ladderNext: data.ladderNext,
    ladderLanguage: data.ladderLanguage,
  };
  if (data.linqContactCardClaim) payload.linqContactCardClaim = data.linqContactCardClaim;
  if (data.firstTouch) payload.firstTouch = data.firstTouch;
  return encryptString(JSON.stringify(payload));
}

function decodeLinqContactCardClaim(value: unknown): LinqContactCardClaim | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as {
    at?: unknown;
    outcome?: unknown;
    code?: unknown;
    attempts?: unknown;
    chatId?: unknown;
  };
  if (
    row.outcome !== 'shared' &&
    row.outcome !== 'share_refused' &&
    row.outcome !== 'unreachable'
  ) {
    return null;
  }
  if (typeof row.at !== 'string' || row.at.length === 0) return null;
  const attempts =
    typeof row.attempts === 'number' && Number.isFinite(row.attempts) && row.attempts > 0
      ? row.attempts
      : null;
  return {
    at: row.at,
    outcome: row.outcome,
    ...(typeof row.chatId === 'string' && row.chatId.length > 0 ? { chatId: row.chatId } : {}),
    ...(typeof row.code === 'string' ? { code: row.code } : {}),
    ...(attempts != null ? { attempts } : {}),
  };
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
    linqContactCardClaim: decodeLinqContactCardClaim(parsed.linqContactCardClaim),
    firstTouch: decodeFirstTouch(parsed.firstTouch),
  };
}

const LOCATION_REQUEST_OUTCOMES = [
  'sent',
  'refused',
  'not_configured',
  'unreachable',
  'skipped_group',
  'not_a_moment',
  'skipped',
] as const;

function decodeFirstTouch(value: unknown): FirstTouchPersisted | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as {
    language?: unknown;
    place?: unknown;
    locationRequest?: unknown;
    coldStart?: unknown;
    clarify?: unknown;
    given?: unknown;
  };
  const language = row.language === 'fr' ? 'fr' : row.language === 'en' ? 'en' : null;
  if (!language) return null;
  return {
    language,
    place: decodeFirstTouchPlace(row.place),
    locationRequest: decodeLocationRequest(row.locationRequest),
    coldStart: decodeColdStart(row.coldStart),
    clarify: decodeFirstTouchClarify(row.clarify),
    given: decodeFirstTouchGiven(row.given),
  };
}

function decodeFirstTouchGiven(value: unknown): FirstTouchPersisted['given'] {
  if (!value || typeof value !== 'object') return null;
  const row = value as {
    parentName?: unknown;
    activityPick?: unknown;
    connectCalendar?: unknown;
    connectGmail?: unknown;
    nameDeclined?: unknown;
    kidsNamesDeclined?: unknown;
    calendarLater?: unknown;
    gmailLater?: unknown;
  };
  const parentName =
    typeof row.parentName === 'string' && row.parentName.trim() ? row.parentName : null;
  const activityPick =
    typeof row.activityPick === 'number' &&
    Number.isInteger(row.activityPick) &&
    row.activityPick > 0
      ? row.activityPick
      : null;
  const connectCalendar =
    row.connectCalendar === true || row.connectCalendar === false ? row.connectCalendar : null;
  const connectGmail =
    row.connectGmail === true || row.connectGmail === false ? row.connectGmail : null;
  const nameDeclined = row.nameDeclined === true;
  const kidsNamesDeclined = row.kidsNamesDeclined === true;
  const calendarLater = row.calendarLater === true;
  const gmailLater = row.gmailLater === true;
  if (
    !parentName &&
    activityPick == null &&
    connectCalendar == null &&
    connectGmail == null &&
    !nameDeclined &&
    !kidsNamesDeclined &&
    !calendarLater &&
    !gmailLater
  ) {
    return null;
  }
  return {
    parentName,
    activityPick,
    connectCalendar,
    connectGmail,
    ...(nameDeclined ? { nameDeclined } : {}),
    ...(kidsNamesDeclined ? { kidsNamesDeclined } : {}),
    ...(calendarLater ? { calendarLater } : {}),
    ...(gmailLater ? { gmailLater } : {}),
  };
}

function decodeCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function decodeFirstTouchClarify(value: unknown): FirstTouchClarify | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as { place?: unknown; ages?: unknown };
  const place = decodeCount(row.place);
  const ages = decodeCount(row.ages);
  if (place === 0 && ages === 0) return null;
  return { place, ages };
}

function decodeColdStart(value: unknown): ColdStartProgress | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as {
    step?: unknown;
    group?: unknown;
    findBody?: unknown;
    activity?: unknown;
    day?: unknown;
    nameLineSent?: unknown;
    signupDateKnown?: unknown;
    signupAsked?: unknown;
    calendarAsked?: unknown;
    emailAsked?: unknown;
    schoolMentioned?: unknown;
    calendarOffered?: unknown;
    emailOffered?: unknown;
  };
  if (
    row.step !== 'pick' &&
    row.step !== 'logistics' &&
    row.step !== 'names' &&
    row.step !== 'follow'
  ) {
    return null;
  }
  if (typeof row.findBody !== 'string') return null;
  return {
    step: row.step,
    group: row.group === true,
    findBody: row.findBody,
    activity: typeof row.activity === 'string' ? row.activity : null,
    day: typeof row.day === 'string' ? row.day : null,
    nameLineSent: row.nameLineSent === true,
    signupDateKnown: row.signupDateKnown === true,
    signupAsked: row.signupAsked === true,
    calendarAsked: row.calendarAsked === true,
    emailAsked: row.emailAsked === true,
    schoolMentioned: row.schoolMentioned === true,
    ...(row.calendarOffered === true ? { calendarOffered: true } : {}),
    ...(row.emailOffered === true ? { emailOffered: true } : {}),
  };
}

function decodeFirstTouchPlace(value: unknown): FirstTouchPersisted['place'] {
  if (!value || typeof value !== 'object') return null;
  const row = value as {
    kind?: unknown;
    areaCoarse?: unknown;
    postalCode?: unknown;
    municipality?: unknown;
    city?: unknown;
  };
  if (row.kind !== 'postal' && row.kind !== 'city') return null;
  if (typeof row.areaCoarse !== 'string' || row.areaCoarse.length === 0) return null;
  return {
    kind: row.kind,
    areaCoarse: row.areaCoarse,
    postalCode: typeof row.postalCode === 'string' ? row.postalCode : null,
    municipality: typeof row.municipality === 'string' ? row.municipality : null,
    city: typeof row.city === 'string' ? row.city : null,
  };
}

function decodeLocationRequest(value: unknown): FirstTouchPersisted['locationRequest'] {
  if (!value || typeof value !== 'object') return null;
  const row = value as { at?: unknown; outcome?: unknown; code?: unknown };
  if (typeof row.at !== 'string' || row.at.length === 0) return null;
  if (
    typeof row.outcome !== 'string' ||
    !(LOCATION_REQUEST_OUTCOMES as readonly string[]).includes(row.outcome)
  ) {
    return null;
  }
  return {
    at: row.at,
    outcome: row.outcome as NonNullable<FirstTouchPersisted['locationRequest']>['outcome'],
    ...(typeof row.code === 'string' ? { code: row.code } : {}),
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
    linqContactCardClaim: data.linqContactCardClaim ?? null,
    firstTouch: data.firstTouch ?? null,
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
    linqContactCardClaim: null,
    firstTouch: null,
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
  /** Undefined keeps the stored claim. Null clears a released attempt. */
  linqContactCardClaim?: LinqContactCardClaim | null;
  /** Undefined keeps the stored ladder. Null clears it. */
  firstTouch?: FirstTouchPersisted | null;
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
  const linqContactCardClaim =
    patch.linqContactCardClaim === undefined
      ? session.linqContactCardClaim
      : patch.linqContactCardClaim;
  const firstTouch = patch.firstTouch === undefined ? session.firstTouch : patch.firstTouch;
  await database
    .update(schema.smsIntakeSessions)
    .set({
      ...(patch.state ? { state: patch.state } : {}),
      dataEncrypted: encodeData({
        collected,
        transcript,
        findWon,
        ladderNext,
        ladderLanguage,
        linqContactCardClaim,
        firstTouch,
      }),
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
