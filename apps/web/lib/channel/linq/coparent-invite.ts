import { type Database, schema } from '@hale/db';
import { and, eq, inArray } from 'drizzle-orm';
import { CO_PARENT_REDIRECT } from '~/lib/channel/caregiver/copy';
import {
  familyHasCoParent,
  loadPendingAssent,
  recordCoParentAssent,
  startCoParentInvite,
} from '~/lib/channel/caregiver/invites';
import {
  CO_PARENT_REFUSAL_COPY,
  coParentInviteBody,
  coParentInviteSentAck,
} from '~/lib/channel/coparent/copy';
import { f14EnabledFor } from '~/lib/channel/f14';
import { INTAKE_COPARENT_ASK_TEMPLATE_KEY } from '~/lib/channel/intake/copy';
import { type ReplyLanguage, replyLanguage } from '~/lib/channel/language';
import { SENT_STATUSES, acceptedStatus } from '~/lib/channel/ledger';
import { resolveMessagingDoor } from '~/lib/channel/messaging-door';
import { normalizePhoneE164 } from '~/lib/channels/phone';
import { resolveSendablePhone } from '~/lib/channels/sms-consent-core';
import { linqFromE164 } from './config';
import {
  LINQ_GROUP_LINE_MISSING_TEXT,
  formatLinqLineForParent,
  linqGroupMakeInstruction,
} from './group';

/**
 * A phone number texted after `intake:coparent_ask`.
 *
 * SMS still sends the locked invite body. Linq does not text that number and
 * does not create a group: the parent starts the iMessage group, and a later
 * trigger claims it. The free agent must not say an invite went out. On
 * 2026-09-24 it did, and nothing left.
 */

/** The outbound row that proves the SMS invite left. */
export const SMS_COPARENT_INVITE_TEMPLATE_KEY = 'sms:coparent_invite';

/** The parent's ack on the SMS door. The body is {@link coParentInviteSentAck}. */
export const COPARENT_NUMBER_ACK_TEMPLATE_KEY = 'coparent:number_invite_ack';
/** A refusal, or a send that did not leave. The body is an existing locked line. */
export const COPARENT_NUMBER_HELD_TEMPLATE_KEY = 'coparent:number_invite_held';
/**
 * The Linq parent's instructions. Not an invite ack: nobody was texted.
 */
export const LINQ_GROUP_INSTRUCTIONS_TEMPLATE_KEY = 'linq:coparent_group_instructions';

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
  /** The Twilio door. Unused when this turn arrived on iMessage. */
  sendSms(input: { to: string; body: string }): Promise<{ providerMessageId: string }>;
}

export type CoParentNumberOutcome =
  | { status: 'not_pending' }
  | {
      status: 'sent';
      reply: string;
      templateKey: typeof COPARENT_NUMBER_ACK_TEMPLATE_KEY;
    }
  | {
      status: 'instructed';
      reply: string;
      templateKey: typeof LINQ_GROUP_INSTRUCTIONS_TEMPLATE_KEY;
    }
  | {
      status: 'refused' | 'unreached';
      reply: string;
      templateKey: typeof COPARENT_NUMBER_HELD_TEMPLATE_KEY;
    };

/**
 * Answer a number reply, or decline the turn.
 *
 * `not_pending` means this message is not the answer to the ask: the handler
 * must not claim it. Linq's reply tells the parent how to make the group.
 * SMS's reply is the locked sent-ack, and only after Twilio accepted the body.
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

  // A redrive of an SMS invite that already left tells the truth again and
  // does not text the number a second time.
  if (await priorSmsInvite(database, input.familyId)) {
    return {
      status: 'sent',
      reply: coParentInviteSentAck(label, language),
      templateKey: COPARENT_NUMBER_ACK_TEMPLATE_KEY,
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

  const parentPhone = await resolveSendablePhone(database, input.parentUserId);
  if (!parentPhone) {
    return {
      status: 'unreached',
      reply: imessage ? LINQ_GROUP_LINE_MISSING_TEXT : CO_PARENT_REDIRECT,
      templateKey: COPARENT_NUMBER_HELD_TEMPLATE_KEY,
    };
  }

  if (imessage) {
    return instructLinqGroup(database, { ...input, parsed, language, parentPhone, label });
  }

  // Same gate as the YES that texts a stranger (D21). The ask can be on the
  // thread while the flag is dark; the SMS send is what the flag holds.
  if (!f14EnabledFor(input.familyId)) {
    return held(CO_PARENT_REDIRECT);
  }

  const name = await parentName(database, input.parentUserId);
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
  if (!name) return held(CO_PARENT_REFUSAL_COPY.referrer_unnamed[language]);

  const sms = await input.sendSms({
    to: parsed.phoneE164,
    body: coParentInviteBody(name, language),
  });
  await ledgerSmsInvite(database, {
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    now: input.now,
    providerMessageId: sms.providerMessageId,
  });

  const body = await recordCoParentAssent(database, {
    invite: started.invite,
    inviterName: name,
    language,
    verbatimReply: input.body,
    channelMessageId: input.inboundChannelMessageId,
    now: input.now,
  });
  if (body === null) {
    console.warn(
      { familyId: input.familyId },
      'coparent number invite: the SMS send landed and the assent was already claimed',
    );
  }

  return {
    status: 'sent',
    reply: coParentInviteSentAck(label, language),
    templateKey: COPARENT_NUMBER_ACK_TEMPLATE_KEY,
  };
}

async function instructLinqGroup(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    body: string;
    now: Date;
    parsed: { phoneE164: string; name: string | null };
    language: ReplyLanguage;
    parentPhone: string;
    label: string;
  },
): Promise<CoParentNumberOutcome> {
  const name = await parentName(database, input.parentUserId);
  const started = await startCoParentInvite(database, {
    familyId: input.familyId,
    invitedByUserId: input.parentUserId,
    inviterPhoneE164: input.parentPhone,
    inviterName: name,
    parsed: {
      ok: true,
      role: 'co_parent',
      name: input.label,
      phoneE164: input.parsed.phoneE164,
    },
    language: input.language,
    now: input.now,
    notedOnly: true,
  });
  if (started.status === 'refused' && started.reason !== 'already_invited') {
    return {
      status: 'refused',
      reply: CO_PARENT_REFUSAL_COPY[started.reason][input.language],
      templateKey: COPARENT_NUMBER_HELD_TEMPLATE_KEY,
    };
  }

  const from = linqFromE164();
  if (!from) {
    return {
      status: 'unreached',
      reply: LINQ_GROUP_LINE_MISSING_TEXT,
      templateKey: COPARENT_NUMBER_HELD_TEMPLATE_KEY,
    };
  }
  return {
    status: 'instructed',
    reply: linqGroupMakeInstruction(formatLinqLineForParent(from), input.language),
    templateKey: LINQ_GROUP_INSTRUCTIONS_TEMPLATE_KEY,
  };
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

async function priorSmsInvite(database: Database, familyId: string): Promise<boolean> {
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
        eq(schema.channelMessages.templateKey, SMS_COPARENT_INVITE_TEMPLATE_KEY),
      ),
    );
  return rows.some(
    (row) =>
      row.familyId === familyId &&
      row.direction === 'out' &&
      row.templateKey === SMS_COPARENT_INVITE_TEMPLATE_KEY,
  );
}

async function parentName(database: Database, userId: string): Promise<string | null> {
  const rows = await database
    .select({ id: schema.users.id, name: schema.users.name })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  return rows.find((row) => row.id === userId)?.name ?? null;
}

async function ledgerSmsInvite(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    now: Date;
    providerMessageId: string;
  },
): Promise<void> {
  const [row] = await database
    .insert(schema.channelMessages)
    .values({
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'co_parent_invite',
      templateKey: SMS_COPARENT_INVITE_TEMPLATE_KEY,
      providerMessageId: input.providerMessageId,
      status: acceptedStatus('sms'),
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
