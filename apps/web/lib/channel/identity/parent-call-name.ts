import { type Database, schema } from '@hale/db';
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import { SENT_STATUSES, acceptedStatus } from '~/lib/channel/ledger';
import { deliverFamilyOutbound } from '~/lib/channel/linq/family-outbound';
import type { threadProactiveMessage } from '~/lib/channel/thread';
import { PARENT_NAME_ASK_TEMPLATE_KEY, PARENT_NAME_CONFIRM_TEMPLATE_KEY } from './asked';
import { type ParentRoleGuess, storeParentRole } from './parent-role';

/**
 * What to call this parent, asked once, after the first real radar win.
 *
 * Code decides the MOMENT and which kind of ask it is; the onboarding model
 * writes the sentence (VIL-417). There is no fixed line here. Confirmed names
 * live on `users.name`. An unconfirmed Google given name lives on
 * `users.google_given_name` and reaches the model only after it has passed the
 * same shape check a typed name has to pass.
 */

const ASK_KEYS = [PARENT_NAME_ASK_TEMPLATE_KEY, PARENT_NAME_CONFIRM_TEMPLATE_KEY] as const;

/** Letters, an apostrophe, or a hyphen. No digits, so a phone can never pass. */
const NAME_TOKEN = /^[\p{L}\p{M}][\p{L}\p{M}'’-]*$/u;
const LINK_SHAPE = /https?:\/\/|www\./i;

/**
 * A given name Hale may put in the confirm line, or null.
 *
 * One token, or two when both are name-shaped (a compound given name). A longer
 * string keeps its first token only. Anything with a digit, an @, or a link is
 * refused — a phone number is the case this exists to make unexpressible.
 */
export function safeGivenName(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 40) return null;
  if (LINK_SHAPE.test(trimmed) || trimmed.includes('@') || /\d/.test(trimmed)) return null;
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  const kept = words.length <= 2 ? words : words.slice(0, 1);
  if (!kept.every((word) => NAME_TOKEN.test(word))) return null;
  return kept.join(' ');
}

export interface ParentCallNameState {
  /** `users.name` is still empty. */
  needsName: boolean;
  /** Either ask was already delivered to THIS parent. */
  alreadyAsked: boolean;
  /** The raw column. {@link decideParentCallName} is what makes it speakable. */
  googleGivenName: string | null;
}

export type ParentCallNameAsk =
  | { kind: 'confirm'; first: string; templateKey: typeof PARENT_NAME_CONFIRM_TEMPLATE_KEY }
  | { kind: 'ask'; templateKey: typeof PARENT_NAME_ASK_TEMPLATE_KEY };

export type ParentCallNameDecision =
  | { kind: 'none'; reason: 'not_a_win' | 'already_named' | 'already_asked' }
  | ParentCallNameAsk;

/**
 * Which kind of ask this moment is, if any. The words are the model's.
 *
 * A win with no name and no prior ask is the only moment. A safe Google given
 * name is a confirm; everything else (missing, phone-shaped) is the open ask,
 * and the rejected string never reaches the model.
 */
export function decideParentCallName(input: {
  needsName: boolean;
  alreadyAsked: boolean;
  isWin: boolean;
  googleGivenName: string | null;
}): ParentCallNameDecision {
  if (!input.isWin) return { kind: 'none', reason: 'not_a_win' };
  if (!input.needsName) return { kind: 'none', reason: 'already_named' };
  if (input.alreadyAsked) return { kind: 'none', reason: 'already_asked' };
  const first = safeGivenName(input.googleGivenName);
  if (first) return { kind: 'confirm', first, templateKey: PARENT_NAME_CONFIRM_TEMPLATE_KEY };
  return { kind: 'ask', templateKey: PARENT_NAME_ASK_TEMPLATE_KEY };
}

interface MessageStamp {
  familyId: string;
  parentUserId: string;
  templateKey: string | null;
  status: string;
  sentAt: Date | null;
  createdAt: Date | null;
}

/**
 * This parent's name state.
 *
 * The SELECT predicate is repeated in JS. The intake fake ignores `where` on
 * every table except the session, and a `.limit(1)` in front of that filter
 * would keep a different family's row (the tests that drive two households).
 */
export async function loadParentCallName(
  database: Database,
  input: { familyId: string; parentUserId: string },
): Promise<ParentCallNameState> {
  const users = await database
    .select({
      id: schema.users.id,
      name: schema.users.name,
      googleGivenName: schema.users.googleGivenName,
    })
    .from(schema.users)
    .where(eq(schema.users.id, input.parentUserId));
  const user = users.find((row) => row.id === input.parentUserId);
  const needsName = (user?.name ?? '').trim().length === 0;

  const stamps = await database
    .select({
      familyId: schema.channelMessages.familyId,
      parentUserId: schema.channelMessages.parentUserId,
      templateKey: schema.channelMessages.templateKey,
      status: schema.channelMessages.status,
      sentAt: schema.channelMessages.sentAt,
      createdAt: schema.channelMessages.createdAt,
    })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.familyId, input.familyId),
        eq(schema.channelMessages.parentUserId, input.parentUserId),
        inArray(schema.channelMessages.templateKey, [...ASK_KEYS]),
        inArray(schema.channelMessages.status, [...SENT_STATUSES]),
      ),
    );
  const alreadyAsked = stamps.some((row) => stampMatches(row, input));
  return {
    needsName,
    alreadyAsked,
    googleGivenName: user?.googleGivenName ?? null,
  };
}

function stampMatches(
  row: MessageStamp,
  input: { familyId: string; parentUserId: string },
): boolean {
  return (
    row.familyId === input.familyId &&
    row.parentUserId === input.parentUserId &&
    (row.templateKey === PARENT_NAME_ASK_TEMPLATE_KEY ||
      row.templateKey === PARENT_NAME_CONFIRM_TEMPLATE_KEY) &&
    (SENT_STATUSES as readonly string[]).includes(row.status)
  );
}

export type GoogleNameHold = 'held' | 'unchanged' | 'refused';

/**
 * Store an unconfirmed given name. Refuses anything {@link safeGivenName} refuses,
 * refuses to overwrite a confirmed `users.name`, and writes no audit row when the
 * value did not change.
 */
export async function holdGoogleGivenName(
  database: Database,
  input: { familyId: string; userId: string; givenName: string },
): Promise<GoogleNameHold> {
  const safe = safeGivenName(input.givenName);
  if (!safe) return 'refused';

  const rows = await database
    .select({
      id: schema.users.id,
      name: schema.users.name,
      googleGivenName: schema.users.googleGivenName,
    })
    .from(schema.users)
    .where(eq(schema.users.id, input.userId));
  const user = rows.find((row) => row.id === input.userId);
  if (!user) return 'unchanged';
  if ((user.name ?? '').trim().length > 0) return 'unchanged';
  if (user.googleGivenName === safe) return 'unchanged';

  const updated = await database
    .update(schema.users)
    .set({ googleGivenName: safe, updatedAt: new Date() })
    .where(and(eq(schema.users.id, input.userId), isNull(schema.users.name)))
    .returning({ id: schema.users.id });
  if (updated.length === 0) return 'unchanged';

  await database.insert(schema.auditLog).values({
    familyId: input.familyId,
    actor: 'system',
    actionTaken: 'google_given_name_held',
    targetTable: 'users',
    targetId: input.userId,
    after: { source: 'google_profile' },
  });
  return 'held';
}

/** Clear the unconfirmed name. Audits only when a value was actually cleared. */
export async function releaseGoogleGivenName(
  database: Database,
  input: { familyId: string; userId: string; reason: 'confirm_declined' | 'replaced' },
): Promise<'released' | 'none'> {
  const updated = await database
    .update(schema.users)
    .set({ googleGivenName: null, updatedAt: new Date() })
    .where(and(eq(schema.users.id, input.userId), isNotNull(schema.users.googleGivenName)))
    .returning({ id: schema.users.id });
  if (updated.length === 0) return 'none';
  await database.insert(schema.auditLog).values({
    familyId: input.familyId,
    actor: input.userId,
    actionTaken: 'google_given_name_released',
    targetTable: 'users',
    targetId: input.userId,
    after: { reason: input.reason },
  });
  return 'released';
}

async function writeConfirmedName(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    name: string;
    source: 'google_confirm' | 'sms_preference';
  },
): Promise<'stored' | 'already_named'> {
  const updated = await database
    .update(schema.users)
    .set({ name: input.name, googleGivenName: null, updatedAt: new Date() })
    .where(and(eq(schema.users.id, input.parentUserId), isNull(schema.users.name)))
    .returning({ id: schema.users.id });
  if (updated.length === 0) return 'already_named';
  await database.insert(schema.auditLog).values({
    familyId: input.familyId,
    actor: input.parentUserId,
    actionTaken: 'parent_name_captured',
    targetTable: 'users',
    targetId: input.parentUserId,
    after: { source: input.source, name: input.name },
  });
  return 'stored';
}

export type ParentCallNameReply =
  | { status: 'declined' }
  /** `reply` is null when the model could not write one: nothing is sent and #ops was paged. */
  | { status: 'answered'; reply: string | null };

/** What the model read in the parent's reply to "can I call you {first}?". */
export interface ParentCallNameRead {
  /** The judged reply, or null when both attempts failed. */
  reply: string | null;
  /** A name they gave instead, already shape-checked by the caller. */
  parentName: string | null;
  nameConfirmed: boolean | null;
  parentRole: ParentRoleGuess | null;
}

export interface ParentCallNameVoice {
  read(input: {
    familyId: string;
    parentUserId: string;
    body: string;
    heldName: string;
  }): Promise<ParentCallNameRead>;
}

/**
 * A reply to the confirm ask.
 *
 * Runs only when THAT confirm is the latest ask this parent was sent. The open
 * ask stays with the name capture behind this handler. The model reads the
 * answer and writes the receipt; code stores only what passes the shape check.
 * A yes keeps the held name. A no clears it; the model's reply asks what to
 * call them. A different name stores THAT name, not the Google one. A reply
 * the model read as none of those is not claimed.
 */
export async function handleParentCallNameReply(
  database: Database,
  input: { familyId: string; parentUserId: string; body: string },
  voice: ParentCallNameVoice,
): Promise<ParentCallNameReply> {
  const pending = await latestAsk(database, input);
  if (pending !== PARENT_NAME_CONFIRM_TEMPLATE_KEY) return { status: 'declined' };

  const held = safeGivenName(await readHeldGivenName(database, input.parentUserId));
  if (!held) {
    await releaseGoogleGivenName(database, {
      familyId: input.familyId,
      userId: input.parentUserId,
      reason: 'confirm_declined',
    });
    return { status: 'declined' };
  }

  const read = await voice.read({ ...input, heldName: held });
  const preferred = safeGivenName(read.parentName);
  if (read.parentRole) {
    await storeParentRole(database, {
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      guess: read.parentRole,
    });
  }
  if (preferred) {
    const written = await writeConfirmedName(database, {
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      name: preferred,
      source: 'sms_preference',
    });
    if (written !== 'stored') return { status: 'declined' };
    return { status: 'answered', reply: read.reply };
  }
  if (read.nameConfirmed === true) {
    const written = await writeConfirmedName(database, {
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      name: held,
      source: 'google_confirm',
    });
    if (written !== 'stored') return { status: 'declined' };
    return { status: 'answered', reply: read.reply };
  }
  if (read.nameConfirmed === false) {
    await releaseGoogleGivenName(database, {
      familyId: input.familyId,
      userId: input.parentUserId,
      reason: 'confirm_declined',
    });
    return { status: 'answered', reply: read.reply };
  }
  return { status: 'declined' };
}

async function readHeldGivenName(database: Database, userId: string): Promise<string | null> {
  const rows = await database
    .select({ id: schema.users.id, googleGivenName: schema.users.googleGivenName })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  return rows.find((row) => row.id === userId)?.googleGivenName ?? null;
}

/** The latest delivered ask for this parent, or null. Confirm beats an older open ask. */
async function latestAsk(
  database: Database,
  input: { familyId: string; parentUserId: string },
): Promise<string | null> {
  const stamps = await database
    .select({
      familyId: schema.channelMessages.familyId,
      parentUserId: schema.channelMessages.parentUserId,
      templateKey: schema.channelMessages.templateKey,
      status: schema.channelMessages.status,
      sentAt: schema.channelMessages.sentAt,
      createdAt: schema.channelMessages.createdAt,
    })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.familyId, input.familyId),
        eq(schema.channelMessages.parentUserId, input.parentUserId),
        inArray(schema.channelMessages.templateKey, [...ASK_KEYS]),
        inArray(schema.channelMessages.status, [...SENT_STATUSES]),
      ),
    );
  const mine = stamps.filter((row) => stampMatches(row, input));
  mine.sort((a, b) => stampTime(a) - stampTime(b));
  return mine.at(-1)?.templateKey ?? null;
}

function stampTime(row: MessageStamp): number {
  const at = row.sentAt ?? row.createdAt;
  return at instanceof Date ? at.getTime() : 0;
}

/**
 * Ask, when this moment is a win and the parent still needs a name.
 *
 * `send` writes and delivers the line for the decided kind and reports whether
 * anything went out; a model that could not write one reports false. A send
 * that throws is the caller's to catch — intake still closes the session, a
 * nudge still keeps the find.
 */
export async function maybeSendParentCallName(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    isWin: boolean;
    language: 'en' | 'fr';
  },
  send: (ask: ParentCallNameAsk) => Promise<boolean>,
): Promise<boolean> {
  if (!input.isWin) return false;
  const state = await loadParentCallName(database, input);
  const decision = decideParentCallName({ ...state, isWin: true });
  if (decision.kind === 'none') return false;
  return send(decision);
}

/** Store the held Google name as confirmed. Used when the onboarding model read a yes. */
export async function confirmHeldGivenName(
  database: Database,
  input: { familyId: string; parentUserId: string },
): Promise<'stored' | 'already_named' | 'none_held'> {
  const held = safeGivenName(await readHeldGivenName(database, input.parentUserId));
  if (!held) return 'none_held';
  return writeConfirmedName(database, { ...input, name: held, source: 'google_confirm' });
}

/**
 * Put one already-decided name line on the wire.
 *
 * Category `reply` so it does not spend the weekly nudge cap. The audit verb names
 * the ask and does not carry the Google name. The caller decides whether this
 * moment is a win — this function does not look that up again.
 */
export async function deliverParentCallNameLine(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    to: string;
    now: Date;
    body: string;
    templateKey: string;
  },
  deps: { transport: ChannelTransport; threadMessage: typeof threadProactiveMessage },
): Promise<void> {
  const delivered = await deliverFamilyOutbound(database, {
    familyId: input.familyId,
    body: input.body,
    to: input.to,
    legacy: deps.transport,
    shareGroupCap: false,
  });
  if (delivered.status !== 'sent') return;
  const channel = delivered.channel === 'imessage' ? 'imessage' : 'sms';
  const [row] = await database
    .insert(schema.channelMessages)
    .values({
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      channel,
      direction: 'out',
      category: 'reply',
      templateKey: input.templateKey,
      providerMessageId: delivered.providerMessageId,
      providerChatId: delivered.chatId,
      status: acceptedStatus(channel),
      sentAt: input.now,
    })
    .returning({ id: schema.channelMessages.id });
  if (!row) throw new Error('deliverParentCallNameLine: channel_messages insert returned no row');
  await database.insert(schema.auditLog).values({
    familyId: input.familyId,
    actor: 'system',
    actionTaken: 'parent_name_asked',
    targetTable: 'channel_messages',
    targetId: row.id,
    after: { templateKey: input.templateKey, origin: 'find' },
  });
  await deps.threadMessage(database, {
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    body: input.body,
  });
}
