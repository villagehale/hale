import { type Database, schema } from '@hale/db';
import { and, eq, inArray } from 'drizzle-orm';
import { CO_PARENT_REDIRECT } from '~/lib/channel/caregiver/copy';
import {
  type CoParentInvite,
  familyHasCoParent,
  loadPendingAssent,
  recordCoParentAssent,
  startCoParentInvite,
} from '~/lib/channel/caregiver/invites';
import {
  CO_PARENT_REFUSAL_COPY,
  coParentInviteBody,
  coParentInviteSentAck,
  inviterNameIsAffordable,
} from '~/lib/channel/coparent/copy';
import { f14EnabledFor } from '~/lib/channel/f14';
import {
  CO_PARENT_ASK_BY_LANGUAGE,
  INTAKE_COPARENT_ASK_TEMPLATE_KEY,
} from '~/lib/channel/intake/copy';
import { type ReplyLanguage, replyLanguage } from '~/lib/channel/language';
import { SENT_STATUSES, acceptedStatus } from '~/lib/channel/ledger';
import { resolveMessagingDoor } from '~/lib/channel/messaging-door';
import { normalizePhoneE164 } from '~/lib/channels/phone';
import { resolveSendablePhone } from '~/lib/channels/sms-consent-core';
import { linqFromE164 } from './config';
import { LINQ_GROUP_UNREACHABLE_TEXT, openHouseholdLinqGroup } from './group';
import { LinqSendError, createLinqChat } from './transport';

/**
 * A phone number texted after `intake:coparent_ask`.
 *
 * The ask already told the parent that the number is the invite. This module
 * is the deterministic sender for that reply. The free agent must not be the
 * thing that says an invite went out: on 2026-09-24 it did, and nothing left.
 *
 * Linq sends from `LINQ_FROM_E164` into a new 1:1 with the number. Twilio
 * stays the SMS door. A send that does not leave is the unreachable line,
 * never an ack that claims otherwise.
 */

/**
 * DESIGN LOCK PENDING (Sloane).
 *
 * The first iMessage to a co-parent, from Hale's Linq number. Linq will not
 * add them to the household group until they have texted this line, so the
 * sentence asks for that text. It is not the SMS invite body: that body asks
 * them to reply YES, and this door cannot seat them from a reply alone.
 */
export const LINQ_COPARENT_INVITE_TEXT: Record<ReplyLanguage, (inviterName: string) => string> = {
  en: (inviterName) =>
    `Hi - ${inviterName} wants you on your kids' year with Hale. Text this number once and I'll add you to the thread. Reply STOP anytime.`,
  fr: (inviterName) =>
    `Bonjour - ${inviterName} vous veut sur l'annee de vos enfants avec Hale. Ecrivez a ce numero une fois et je vous ajoute au fil. Repondez ARRET a tout moment.`,
};

export function linqCoParentInviteText(inviterName: string, language: ReplyLanguage): string {
  return LINQ_COPARENT_INVITE_TEXT[language](inviterName);
}

/** The outbound row that proves the invite left. Distinct from the parent's ack. */
export const LINQ_COPARENT_INVITE_TEMPLATE_KEY = 'linq:coparent_invite';
export const SMS_COPARENT_INVITE_TEMPLATE_KEY = 'sms:coparent_invite';

/** The parent's ack, on the door they texted. The body is {@link coParentInviteSentAck}. */
export const COPARENT_NUMBER_ACK_TEMPLATE_KEY = 'coparent:number_invite_ack';
/** A refusal or a send that did not leave. The body is an existing locked line. */
export const COPARENT_NUMBER_HELD_TEMPLATE_KEY = 'coparent:number_invite_held';

const NAME_THEN_PHONE =
  /^(?<name>[\p{L}\p{M}'’.\-]+(?:\s+[\p{L}\p{M}'’.\-]+){0,2})\s+(?<phone>\+?[\d\s().\-]{10,22})$/u;

/**
 * A number, or a name and then a number, and nothing else.
 *
 * "9059629821" and "Sam 905-962-9821" are the ask's answer. A sentence that
 * merely contains a number is not: the school line in the middle of a question
 * must still reach the coach.
 */
export function parseCoParentNumberReply(
  body: string,
): { phoneE164: string; name: string | null } | null {
  const trimmed = body.trim();
  if (trimmed.length === 0 || trimmed.length > 80) return null;
  const bare = normalizePhoneE164(trimmed);
  if (bare) return { phoneE164: bare, name: null };
  const match = NAME_THEN_PHONE.exec(trimmed);
  const phone = match?.groups?.phone ? normalizePhoneE164(match.groups.phone) : null;
  const name = match?.groups?.name?.replace(/\s+/g, ' ').trim() ?? '';
  if (!phone || name.length === 0 || name.length > 40) return null;
  return { phoneE164: phone, name };
}

/** Slot fill for the locked sent-ack when the parent did not name them. */
function inviteeLabel(name: string | null, language: ReplyLanguage): string {
  if (name) return name;
  return language === 'fr' ? 'cette personne' : 'them';
}

export interface CoParentNumberDeps {
  /** The Twilio door. Ignored when this turn arrived on iMessage. */
  sendSms(input: { to: string; body: string }): Promise<{ providerMessageId: string }>;
  fetch?: typeof fetch;
}

export type CoParentNumberOutcome =
  | { status: 'not_pending' }
  | {
      status: 'sent';
      reply: string;
      templateKey: typeof COPARENT_NUMBER_ACK_TEMPLATE_KEY;
      /** Runs after the parent ack has left, so the group attempt is the second bubble. */
      afterAck: (() => Promise<void>) | null;
    }
  | {
      status: 'refused' | 'unreached';
      reply: string;
      templateKey: typeof COPARENT_NUMBER_HELD_TEMPLATE_KEY;
    };

/**
 * Send the co-parent invite for a number reply, or decline the turn.
 *
 * `not_pending` means this message is not the answer to the ask: the handler
 * must not claim it. Every other status has already decided what the parent
 * is told, and none of those sentences claim a send that did not happen.
 */
export async function deliverCoParentNumberInvite(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    body: string;
    now: Date;
    inboundChannelMessageId: string | null;
    sendSms: CoParentNumberDeps['sendSms'];
    fetch?: typeof fetch;
  },
): Promise<CoParentNumberOutcome> {
  const parsed = parseCoParentNumberReply(input.body);
  if (!parsed) return { status: 'not_pending' };

  const door = await resolveMessagingDoor(database, input.parentUserId);
  const imessage = door.channel === 'imessage';
  const language = replyLanguage(input.body);
  const label = inviteeLabel(parsed.name, language);
  if (await familyHasCoParent(database, input.familyId)) return { status: 'not_pending' };
  if (!(await askWasDelivered(database, input))) return { status: 'not_pending' };

  // A redrive of a send that already left tells the truth again and does not
  // text the number a second time. The scope-confirm on the SMS add-command is
  // a different outbound (no invite template), so it does not count as sent.
  if (await priorInviteSend(database, input.familyId)) {
    return {
      status: 'sent',
      reply: coParentInviteSentAck(label, language),
      templateKey: COPARENT_NUMBER_ACK_TEMPLATE_KEY,
      afterAck: imessage ? () => openGroupIfAbsent(database, input, parsed.phoneE164) : null,
    };
  }

  // The SMS add-command is waiting on YES. A bare number must not skip that
  // confirm and text someone the parent has not authorised on that door.
  if (!imessage) {
    const pending = await loadPendingAssent(database, input.parentUserId, input.now);
    if (pending?.role === 'co_parent') return { status: 'not_pending' };
  }

  const held = (reply: string): CoParentNumberOutcome => ({
    status: 'refused',
    reply,
    templateKey: COPARENT_NUMBER_HELD_TEMPLATE_KEY,
  });

  // Same gate as the YES that texts a stranger (D21). The ask can be on the
  // thread while the flag is dark; the send is what the flag holds.
  if (!f14EnabledFor(input.familyId)) {
    return held(CO_PARENT_REDIRECT);
  }

  const parentPhone = await resolveSendablePhone(database, input.parentUserId);
  if (!parentPhone) {
    return {
      status: 'unreached',
      reply: imessage ? LINQ_GROUP_UNREACHABLE_TEXT : CO_PARENT_REDIRECT,
      templateKey: COPARENT_NUMBER_HELD_TEMPLATE_KEY,
    };
  }

  const name = await parentName(database, input.parentUserId);
  // A Linq timeout leaves the row in awaiting_parent_assent with nobody texted.
  // Resuming that row is the redrive. Opening a second one would refuse with
  // "already texted", which would be false.
  const resumed = imessage
    ? await resumableUnsentInvite(database, {
        familyId: input.familyId,
        parentUserId: input.parentUserId,
        now: input.now,
        phoneE164: parsed.phoneE164,
      })
    : null;
  let invite: CoParentInvite;
  if (resumed && inviterNameIsAffordable(name)) {
    invite = resumed;
  } else {
    const started = await startCoParentInvite(database, {
      familyId: input.familyId,
      invitedByUserId: input.parentUserId,
      inviterPhoneE164: parentPhone,
      inviterName: name,
      parsed: {
        ok: true,
        role: 'co_parent',
        name: label,
        phoneE164: parsed.phoneE164,
      },
      language,
      now: input.now,
    });
    if (started.status === 'refused') {
      return held(CO_PARENT_REFUSAL_COPY[started.reason][language]);
    }
    invite = started.invite;
  }
  if (!inviterNameIsAffordable(name)) {
    return held(CO_PARENT_REFUSAL_COPY.referrer_unnamed[language]);
  }

  const sent = await sendInvite(database, {
    ...input,
    imessage,
    phoneE164: parsed.phoneE164,
    inviterName: name,
    language,
  });
  if (sent.status !== 'sent') return sent;

  const body = await recordCoParentAssent(database, {
    invite,
    inviterName: name,
    language,
    verbatimReply: input.body,
    channelMessageId: input.inboundChannelMessageId,
    now: input.now,
    asked: {
      question: CO_PARENT_ASK_BY_LANGUAGE[language],
      interpretation:
        'parent texted a number after the co-parent ask, authorising one invite to that number',
    },
  });
  if (body === null) {
    console.warn(
      { familyId: input.familyId },
      'coparent number invite: the send landed and the assent was already claimed',
    );
  }

  return {
    status: 'sent',
    reply: coParentInviteSentAck(label, language),
    templateKey: COPARENT_NUMBER_ACK_TEMPLATE_KEY,
    afterAck: imessage
      ? () => openGroupIfAbsent(database, input, parsed.phoneE164, parentPhone)
      : null,
  };
}

async function openGroupIfAbsent(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    now: Date;
    fetch?: typeof fetch;
  },
  coParentPhoneE164: string,
  parentPhoneE164?: string,
): Promise<void> {
  const existing = await database
    .select({ id: schema.families.id, linqGroupChatId: schema.families.linqGroupChatId })
    .from(schema.families)
    .where(eq(schema.families.id, input.familyId));
  if (existing.find((row) => row.id === input.familyId)?.linqGroupChatId) return;
  const parentPhone = parentPhoneE164 ?? (await resolveSendablePhone(database, input.parentUserId));
  if (!parentPhone) return;
  try {
    await openHouseholdLinqGroup(database, {
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      parentPhoneE164: parentPhone,
      coParentPhoneE164,
      now: input.now,
      fetch: input.fetch,
    });
  } catch (err) {
    console.warn(
      { familyId: input.familyId, code: err instanceof Error ? err.name : 'unknown' },
      'linq group: opener threw after the co-parent invite — the invite still went out',
    );
  }
}

async function resumableUnsentInvite(
  database: Database,
  input: { familyId: string; parentUserId: string; now: Date; phoneE164: string },
): Promise<CoParentInvite | null> {
  const pending = await loadPendingAssent(database, input.parentUserId, input.now);
  if (!pending || pending.role !== 'co_parent') return null;
  if (pending.familyId !== input.familyId || pending.phoneE164 !== input.phoneE164) return null;
  return pending;
}

async function askWasDelivered(
  database: Database,
  input: { familyId: string; parentUserId: string },
): Promise<boolean> {
  const rows = await database
    .select({
      familyId: schema.channelMessages.familyId,
      parentUserId: schema.channelMessages.parentUserId,
      templateKey: schema.channelMessages.templateKey,
      direction: schema.channelMessages.direction,
      status: schema.channelMessages.status,
    })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.familyId, input.familyId),
        eq(schema.channelMessages.parentUserId, input.parentUserId),
        eq(schema.channelMessages.templateKey, INTAKE_COPARENT_ASK_TEMPLATE_KEY),
        eq(schema.channelMessages.direction, 'out'),
        inArray(schema.channelMessages.status, [...SENT_STATUSES]),
      ),
    );
  return rows.some(
    (row) =>
      row.familyId === input.familyId &&
      row.parentUserId === input.parentUserId &&
      row.templateKey === INTAKE_COPARENT_ASK_TEMPLATE_KEY &&
      row.direction === 'out' &&
      (SENT_STATUSES as readonly string[]).includes(row.status),
  );
}

/** The third-party invite itself, not a parent-facing scope confirm on the same category. */
async function priorInviteSend(database: Database, familyId: string): Promise<boolean> {
  const keys = [LINQ_COPARENT_INVITE_TEMPLATE_KEY, SMS_COPARENT_INVITE_TEMPLATE_KEY];
  const rows = await database
    .select({
      familyId: schema.channelMessages.familyId,
      templateKey: schema.channelMessages.templateKey,
      direction: schema.channelMessages.direction,
    })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.familyId, familyId),
        eq(schema.channelMessages.direction, 'out'),
        inArray(schema.channelMessages.templateKey, keys),
      ),
    );
  return rows.some(
    (row) =>
      row.familyId === familyId &&
      row.direction === 'out' &&
      row.templateKey !== null &&
      keys.includes(row.templateKey),
  );
}

async function parentName(database: Database, userId: string): Promise<string | null> {
  const rows = await database
    .select({ id: schema.users.id, name: schema.users.name })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  return rows.find((row) => row.id === userId)?.name ?? null;
}

type SendResult = { status: 'sent' } | Extract<CoParentNumberOutcome, { status: 'unreached' }>;

async function sendInvite(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    now: Date;
    imessage: boolean;
    phoneE164: string;
    inviterName: string;
    language: ReplyLanguage;
    sendSms: CoParentNumberDeps['sendSms'];
    fetch?: typeof fetch;
  },
): Promise<SendResult> {
  const unreached = (): SendResult => ({
    status: 'unreached',
    reply: input.imessage ? LINQ_GROUP_UNREACHABLE_TEXT : CO_PARENT_REDIRECT,
    templateKey: COPARENT_NUMBER_HELD_TEMPLATE_KEY,
  });

  if (input.imessage) {
    const from = linqFromE164();
    if (!from) return unreached();
    const text = linqCoParentInviteText(input.inviterName, input.language);
    if (/https?:\/\//i.test(text)) return unreached();
    let created: { chatId: string; providerMessageId: string };
    try {
      created = await createLinqChat({
        from,
        to: [input.phoneE164],
        text,
        fetch: input.fetch,
      });
    } catch (err) {
      if (err instanceof LinqSendError && (err.code === 'timeout' || err.code === 'network')) {
        throw err;
      }
      console.warn(
        {
          familyId: input.familyId,
          code: err instanceof LinqSendError ? err.code : 'unknown',
          httpStatus: err instanceof LinqSendError ? err.httpStatus : 0,
        },
        'linq coparent invite: the 1:1 did not leave',
      );
      return unreached();
    }
    await ledgerInvite(database, {
      ...input,
      channel: 'imessage',
      providerMessageId: created.providerMessageId,
      providerChatId: created.chatId,
      templateKey: LINQ_COPARENT_INVITE_TEMPLATE_KEY,
    });
    return { status: 'sent' };
  }

  const sms = await input.sendSms({
    to: input.phoneE164,
    body: coParentInviteBody(input.inviterName, input.language),
  });
  await ledgerInvite(database, {
    ...input,
    channel: 'sms',
    providerMessageId: sms.providerMessageId,
    providerChatId: null,
    templateKey: SMS_COPARENT_INVITE_TEMPLATE_KEY,
  });
  return { status: 'sent' };
}

async function ledgerInvite(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    now: Date;
    channel: 'imessage' | 'sms';
    providerMessageId: string;
    providerChatId: string | null;
    templateKey: string;
  },
): Promise<void> {
  const [row] = await database
    .insert(schema.channelMessages)
    .values({
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      channel: input.channel,
      direction: 'out',
      category: 'co_parent_invite',
      templateKey: input.templateKey,
      providerMessageId: input.providerMessageId,
      providerChatId: input.providerChatId,
      status: acceptedStatus(input.channel),
      sentAt: input.now,
    })
    .returning({ id: schema.channelMessages.id });
  const id = row?.id;
  if (!id) throw new Error('coparent number invite: channel_messages insert returned no row');
  await database.insert(schema.auditLog).values({
    familyId: input.familyId,
    actor: input.parentUserId,
    actionTaken: 'co_parent_sms_outbound',
    targetTable: 'channel_messages',
    targetId: id,
  });
}
