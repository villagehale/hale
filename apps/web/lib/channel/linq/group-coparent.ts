import { type Database, schema } from '@hale/db';
import { and, eq, isNull } from 'drizzle-orm';
import { offerConnectorLinks } from '~/lib/channel/connect/offer';
import { soleGivenName } from '~/lib/channel/identity/name-reply';
import { PARENT_CALL_NAME_ASK } from '~/lib/channel/identity/parent-call-name';
import {
  INTAKE_CALENDAR_CARD_TEMPLATE_KEY,
  INTAKE_GMAIL_CARD_TEMPLATE_KEY,
  intakeCalendarCard,
  intakeGmailCard,
} from '~/lib/channel/intake/copy';
import { matchKeyword } from '~/lib/channel/intake/keywords';
import { type ReplyLanguage, replyLanguage } from '~/lib/channel/language';
import { acceptedStatus } from '~/lib/channel/ledger';
import { NAME_CAPTURED_REPLY } from '~/lib/channel/router/copy';
import { normalizePhoneE164 } from '~/lib/channels/phone';
import { resolveVerifiedChannelByPhone } from '~/lib/channels/sms-consent-core';
import { POLICY_VERSION } from '~/lib/consent';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { linqFromE164, linqGroupCoparentEnabled } from './config';
import {
  LINQ_GROUP_LINE_MISSING_TEXT,
  formatLinqLineForParent,
  linqGroupMakeInstruction,
  matchLinqGroupTrigger,
} from './group';
import { sendLinqLinkPreview } from './link-preview';
import type { LinqInboundText } from './payload';
import { LinqSendError, sendLinqChatMessage } from './transport';

/**
 * Seat a co-parent inside a claimed Linq group. SMS is not this module.
 *
 * The onboarded parent already stored the number (`identity_noted`, #706).
 * When that number speaks in the claimed group, Hale opens a user, a
 * `co_parent` seat, and a channel on the SAME family. Children and postal
 * code are not asked again. The ladder is the locked name ask, then that
 * parent's own calendar link, then their own Gmail link.
 *
 * Dark unless `LINQ_GROUP_COPARENT=on`.
 */

const NAME_ASK_KEY = 'parent_name_ask';
const CALENDAR_KEY = 'linq:coparent_calendar_card';
const GMAIL_KEY = 'linq:coparent_gmail_card';
const UNCLAIMED_KEY = 'linq:coparent_unclaimed';

export type GroupCoparentEffect =
  | { type: 'none' }
  | { type: 'route_member' }
  | {
      type: 'claim';
      familyId: string;
      userId: string;
      language: 'en' | 'fr';
    }
  | {
      type: 'done';
      outcome: string;
      count: 'intake' | 'duplicate' | 'ignored';
      body: Record<string, unknown>;
    };

export interface GroupCoparentPorts {
  now: Date;
  fetch?: typeof fetch;
  recordInbound: (
    message: LinqInboundText,
    owner: { familyId: string; userId: string },
  ) => Promise<string | null>;
}

export async function considerGroupCoparent(
  database: Database,
  message: LinqInboundText,
  ports: GroupCoparentPorts,
): Promise<GroupCoparentEffect> {
  if (!linqGroupCoparentEnabled()) return { type: 'none' };
  // STOP, HELP, and START stay on the door that already answers them.
  if (matchKeyword(message.text)) return { type: 'none' };

  const senderPhone = normalizePhoneE164(message.senderHandle);
  if (!senderPhone) return { type: 'none' };
  const sender = await resolveVerifiedChannelByPhone(database, senderPhone);
  const owner = await familyForChat(database, message.chatId);
  const language = replyLanguage(message.text);

  if (sender && owner && sender.familyId === owner.familyId) {
    const stepped = await advanceSeatedCoparent(database, message, sender, language, ports);
    if (stepped) return stepped;
    return { type: 'route_member' };
  }

  if (sender && matchLinqGroupTrigger(message.text)) {
    const allowed = await unknownsAreNoted(
      database,
      sender.familyId,
      message.otherHandles,
      ports.now,
    );
    if (allowed) {
      return {
        type: 'claim',
        familyId: sender.familyId,
        userId: sender.userId,
        language: matchLinqGroupTrigger(message.text) ?? language,
      };
    }
  }

  if (sender) return { type: 'none' };

  const noted = await notedInviteForPhone(database, senderPhone, ports.now);
  if (!noted) return { type: 'none' };
  if (owner && owner.familyId !== noted.familyId) return { type: 'none' };
  if (!owner) {
    return sayUnclaimed(database, message, noted, language, ports);
  }

  const seated = await seatCoparent(database, {
    noted,
    phoneE164: senderPhone,
    chatId: message.chatId,
    verbatim: message.text,
    now: ports.now,
  });
  if (seated.status !== 'seated') return { type: 'none' };

  const recorded = await ports.recordInbound(message, {
    familyId: noted.familyId,
    userId: seated.userId,
  });
  if (!recorded) {
    return {
      type: 'done',
      outcome: 'duplicate',
      count: 'duplicate',
      body: { outcome: 'duplicate' },
    };
  }
  const notice = await sendLine(database, {
    familyId: noted.familyId,
    parentUserId: seated.userId,
    chatId: message.chatId,
    text: PARENT_CALL_NAME_ASK,
    templateKey: NAME_ASK_KEY,
    dedupeKey: `linq:coparent_name:${seated.userId}`,
    now: ports.now,
    fetch: ports.fetch,
  });
  return {
    type: 'done',
    outcome: 'group_coparent_seated',
    count: 'intake',
    body: { outcome: 'group_coparent_seated', notice },
  };
}

/**
 * A noted co-parent texting the 1:1 must not start a second family. Point them
 * at the group with the locked instruction. One send per number.
 */
export async function steerNotedCoparentOneToOne(
  database: Database,
  message: LinqInboundText,
  ports: GroupCoparentPorts,
): Promise<GroupCoparentEffect> {
  if (!linqGroupCoparentEnabled()) return { type: 'none' };
  if (matchKeyword(message.text)) return { type: 'none' };
  const senderPhone = normalizePhoneE164(message.senderHandle);
  if (!senderPhone) return { type: 'none' };
  if (await resolveVerifiedChannelByPhone(database, senderPhone)) return { type: 'none' };
  const noted = await notedInviteForPhone(database, senderPhone, ports.now);
  if (!noted) return { type: 'none' };
  const language = replyLanguage(message.text);
  const from = linqFromE164();
  const text = from
    ? linqGroupMakeInstruction(formatLinqLineForParent(from), language)
    : LINQ_GROUP_LINE_MISSING_TEXT[language];
  const notice = await sendLine(database, {
    familyId: noted.familyId,
    parentUserId: noted.invitedByUserId,
    chatId: message.chatId,
    text,
    templateKey: 'linq:coparent_group_instructions',
    dedupeKey: `linq:coparent_1to1:${phoneBlindIndex(senderPhone)}`,
    now: ports.now,
    fetch: ports.fetch,
  });
  return {
    type: 'done',
    outcome: 'group_coparent_steered',
    count: 'intake',
    body: { outcome: 'group_coparent_steered', notice },
  };
}

async function advanceSeatedCoparent(
  database: Database,
  message: LinqInboundText,
  sender: { familyId: string; userId: string },
  language: ReplyLanguage,
  ports: GroupCoparentPorts,
): Promise<GroupCoparentEffect | null> {
  const [step] = await database
    .select({
      step: schema.linqGroupOnboarding.step,
      chatId: schema.linqGroupOnboarding.providerChatId,
    })
    .from(schema.linqGroupOnboarding)
    .where(eq(schema.linqGroupOnboarding.userId, sender.userId))
    .limit(1);
  if (!step || step.step === 'done' || step.chatId !== message.chatId) return null;

  const recorded = await ports.recordInbound(message, sender);
  if (!recorded) {
    return {
      type: 'done',
      outcome: 'duplicate',
      count: 'duplicate',
      body: { outcome: 'duplicate' },
    };
  }

  if (step.step === 'awaiting_name') {
    const name = soleGivenName(message.text);
    if (!name) {
      return {
        type: 'done',
        outcome: 'group_coparent_name_waiting',
        count: 'ignored',
        body: { outcome: 'group_coparent_name_waiting' },
      };
    }
    const updated = await database
      .update(schema.users)
      .set({ name, updatedAt: ports.now })
      .where(and(eq(schema.users.id, sender.userId), isNull(schema.users.name)))
      .returning({ id: schema.users.id });
    if (updated.length > 0) {
      await database.insert(schema.auditLog).values({
        familyId: sender.familyId,
        actor: sender.userId,
        actionTaken: 'parent_name_captured',
        targetTable: 'users',
        targetId: sender.userId,
        after: { source: 'linq_group', name },
      });
    }
    await setStep(database, sender.userId, 'awaiting_calendar', ports.now);
    const notice = await sendLine(database, {
      familyId: sender.familyId,
      parentUserId: sender.userId,
      chatId: message.chatId,
      text: NAME_CAPTURED_REPLY,
      templateKey: 'parent_name_captured',
      dedupeKey: `linq:coparent_name_ack:${sender.userId}`,
      now: ports.now,
      fetch: ports.fetch,
    });
    return {
      type: 'done',
      outcome: 'group_coparent_named',
      count: 'intake',
      body: { outcome: 'group_coparent_named', notice },
    };
  }

  if (step.step === 'awaiting_calendar' || step.step === 'awaiting_gmail') {
    const provider = step.step === 'awaiting_calendar' ? 'gcal' : 'gmail';
    const sent = await sendConnectorCard(database, {
      familyId: sender.familyId,
      parentUserId: sender.userId,
      chatId: message.chatId,
      provider,
      language,
      now: ports.now,
      fetch: ports.fetch,
    });
    if (sent === 'sent') {
      await setStep(
        database,
        sender.userId,
        provider === 'gcal' ? 'awaiting_gmail' : 'done',
        ports.now,
      );
    }
    return {
      type: 'done',
      outcome: sent === 'sent' ? `group_coparent_${provider}` : 'group_coparent_link_held',
      count: 'intake',
      body: {
        outcome: sent === 'sent' ? `group_coparent_${provider}` : 'group_coparent_link_held',
      },
    };
  }

  return null;
}

async function sendConnectorCard(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    chatId: string;
    provider: 'gcal' | 'gmail';
    language: ReplyLanguage;
    now: Date;
    fetch?: typeof fetch;
  },
): Promise<'sent' | 'not_sent'> {
  const templateKey = input.provider === 'gcal' ? CALENDAR_KEY : GMAIL_KEY;
  const dedupeKey = `${templateKey}:${input.parentUserId}`;
  const minted = await offerConnectorLinks(database, {
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    providers: [input.provider],
    now: input.now,
    // The Gmail card is the rest of this parent's ask. Killing the calendar
    // token would pull the link already in the group.
    invalidatePrior: input.provider === 'gcal',
  });
  if (minted.status !== 'minted') {
    console.warn(
      { familyId: input.familyId, provider: input.provider, reason: minted.status },
      'linq group coparent: no connector link',
    );
    return 'not_sent';
  }
  const url = minted.urls[0];
  const text =
    input.provider === 'gcal'
      ? intakeCalendarCard(input.language, url)
      : intakeGmailCard(input.language, url);
  const notice = await sendLine(database, {
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    chatId: input.chatId,
    text,
    templateKey:
      input.provider === 'gcal'
        ? INTAKE_CALENDAR_CARD_TEMPLATE_KEY
        : INTAKE_GMAIL_CARD_TEMPLATE_KEY,
    dedupeKey,
    now: input.now,
    fetch: input.fetch,
  });
  if (notice !== 'sent') return 'not_sent';
  await sendLinqLinkPreview({
    channel: 'imessage',
    chatId: input.chatId,
    url,
    fetch: input.fetch,
    database,
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    now: input.now,
  });
  return 'sent';
}

async function sayUnclaimed(
  database: Database,
  message: LinqInboundText,
  noted: NotedInvite,
  language: ReplyLanguage,
  ports: GroupCoparentPorts,
): Promise<GroupCoparentEffect> {
  const from = linqFromE164();
  const text = from
    ? linqGroupMakeInstruction(formatLinqLineForParent(from), language)
    : LINQ_GROUP_LINE_MISSING_TEXT[language];
  const notice = await sendLine(database, {
    familyId: noted.familyId,
    parentUserId: noted.invitedByUserId,
    chatId: message.chatId,
    text,
    templateKey: UNCLAIMED_KEY,
    dedupeKey: `${UNCLAIMED_KEY}:${phoneBlindIndex(noted.phoneE164)}`,
    now: ports.now,
    fetch: ports.fetch,
  });
  return {
    type: 'done',
    outcome: 'group_coparent_unclaimed',
    count: 'intake',
    body: { outcome: 'group_coparent_unclaimed', notice },
  };
}

interface NotedInvite {
  id: string;
  familyId: string;
  invitedByUserId: string;
  phoneE164: string;
  displayName: string;
}

async function notedInviteForPhone(
  database: Database,
  phoneE164: string,
  now: Date,
): Promise<NotedInvite | null> {
  const hash = phoneBlindIndex(phoneE164);
  const rows = await database
    .select({
      id: schema.caregiverInvites.id,
      familyId: schema.caregiverInvites.familyId,
      invitedByUserId: schema.caregiverInvites.invitedByUserId,
      displayName: schema.caregiverInvites.displayName,
      state: schema.caregiverInvites.state,
      role: schema.caregiverInvites.role,
      expiresAt: schema.caregiverInvites.expiresAt,
      closedAt: schema.caregiverInvites.closedAt,
      phoneE164Hash: schema.caregiverInvites.phoneE164Hash,
    })
    .from(schema.caregiverInvites)
    .where(eq(schema.caregiverInvites.phoneE164Hash, hash));
  const row = rows.find(
    (invite) =>
      invite.phoneE164Hash === hash &&
      invite.state === 'identity_noted' &&
      invite.role === 'co_parent' &&
      invite.closedAt === null &&
      invite.expiresAt.getTime() > now.getTime(),
  );
  if (!row) return null;
  return {
    id: row.id,
    familyId: row.familyId,
    invitedByUserId: row.invitedByUserId,
    displayName: row.displayName,
    phoneE164,
  };
}

async function familyForChat(
  database: Database,
  chatId: string,
): Promise<{ familyId: string } | null> {
  const rows = await database
    .select({ id: schema.families.id, linqGroupChatId: schema.families.linqGroupChatId })
    .from(schema.families)
    .where(eq(schema.families.linqGroupChatId, chatId));
  const row = rows.find((family) => family.linqGroupChatId === chatId);
  return row ? { familyId: row.id } : null;
}

async function unknownsAreNoted(
  database: Database,
  familyId: string,
  others: readonly string[],
  now: Date,
): Promise<boolean> {
  const invites = await database
    .select({
      familyId: schema.caregiverInvites.familyId,
      phoneE164Hash: schema.caregiverInvites.phoneE164Hash,
      state: schema.caregiverInvites.state,
      role: schema.caregiverInvites.role,
      closedAt: schema.caregiverInvites.closedAt,
      expiresAt: schema.caregiverInvites.expiresAt,
    })
    .from(schema.caregiverInvites)
    .where(eq(schema.caregiverInvites.familyId, familyId));
  const noted = new Set(
    invites
      .filter(
        (invite) =>
          invite.familyId === familyId &&
          invite.state === 'identity_noted' &&
          invite.role === 'co_parent' &&
          invite.closedAt === null &&
          invite.expiresAt.getTime() > now.getTime(),
      )
      .map((invite) => invite.phoneE164Hash),
  );
  for (const handle of others) {
    const phone = normalizePhoneE164(handle);
    if (!phone) return false;
    const member = await resolveVerifiedChannelByPhone(database, phone);
    if (member?.familyId === familyId) continue;
    if (member) return false;
    if (!noted.has(phoneBlindIndex(phone))) return false;
  }
  return true;
}

async function seatCoparent(
  database: Database,
  input: {
    noted: NotedInvite;
    phoneE164: string;
    chatId: string;
    verbatim: string;
    now: Date;
  },
): Promise<{ status: 'seated'; userId: string } | { status: 'refused' }> {
  if (await familyHasCoParent(database, input.noted.familyId)) return { status: 'refused' };
  const existing = await resolveVerifiedChannelByPhone(database, input.phoneE164);
  if (existing) return { status: 'refused' };

  const phoneHash = phoneBlindIndex(input.phoneE164);
  const userId = await database.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    await tx
      .insert(schema.users)
      .values({ externalAuthId: `sms:${phoneHash}`, email: null, name: null })
      .onConflictDoNothing({ target: schema.users.externalAuthId });
    const [user] = await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.externalAuthId, `sms:${phoneHash}`))
      .limit(1);
    if (!user) throw new Error('seatCoparent: users insert returned no row');

    await tx
      .insert(schema.familyMembers)
      .values({
        familyId: input.noted.familyId,
        userId: user.id,
        role: 'co_parent',
        invitedByUserId: input.noted.invitedByUserId,
      })
      .onConflictDoNothing();

    await tx
      .insert(schema.loopPrefs)
      .values({ userId: user.id, loopChannel: 'sms' })
      .onConflictDoNothing({ target: schema.loopPrefs.userId });

    const [consent] = await tx
      .insert(schema.consentRecords)
      .values({
        userId: user.id,
        familyId: input.noted.familyId,
        consentType: 'sms_service_messages',
        granted: true,
        consentScope: 'sms_coparent_invite_reply',
        policyVersion: POLICY_VERSION,
        evidence: {
          verbatimReply: input.verbatim,
          interpretation:
            'co-parent originated contact in the household iMessage group the other parent started',
          channel: 'imessage',
        },
      })
      .returning({ id: schema.consentRecords.id });
    if (!consent) throw new Error('seatCoparent: consent insert returned no row');

    // The household watch stays the primary parent's row. The outbound gate
    // reads this seating scope for a co-parent who has no watch row of their own.
    await tx.insert(schema.parentChannels).values({
      userId: user.id,
      familyId: input.noted.familyId,
      kind: 'sms',
      phoneE164Encrypted: encryptString(input.phoneE164),
      phoneE164Hash: phoneHash,
      verifiedAt: input.now,
      consentRecordId: consent.id,
    });

    await tx.insert(schema.linqGroupOnboarding).values({
      familyId: input.noted.familyId,
      userId: user.id,
      providerChatId: input.chatId,
      step: 'awaiting_name',
      createdAt: input.now,
      updatedAt: input.now,
    });

    await tx
      .update(schema.caregiverInvites)
      .set({
        state: 'accepted',
        caregiverUserId: user.id,
        closedAt: input.now,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(schema.caregiverInvites.id, input.noted.id),
          eq(schema.caregiverInvites.state, 'identity_noted'),
        ),
      );

    await tx.insert(schema.auditLog).values({
      familyId: input.noted.familyId,
      actor: user.id,
      actionTaken: 'co_parent_invite_accepted',
      targetTable: 'family_members',
      targetId: user.id,
      after: { via: 'linq_group' },
    });
    return user.id;
  });

  return { status: 'seated', userId };
}

async function familyHasCoParent(database: Database, familyId: string): Promise<boolean> {
  const rows = await database
    .select({ role: schema.familyMembers.role, familyId: schema.familyMembers.familyId })
    .from(schema.familyMembers)
    .where(eq(schema.familyMembers.familyId, familyId));
  return rows.some((row) => row.familyId === familyId && row.role === 'co_parent');
}

async function setStep(database: Database, userId: string, step: string, now: Date): Promise<void> {
  await database
    .update(schema.linqGroupOnboarding)
    .set({ step, updatedAt: now })
    .where(eq(schema.linqGroupOnboarding.userId, userId));
}

async function sendLine(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    chatId: string;
    text: string;
    templateKey: string;
    dedupeKey: string;
    now: Date;
    fetch?: typeof fetch;
  },
): Promise<'sent' | 'already_sent' | 'not_sent'> {
  const [claimed] = await database
    .insert(schema.channelMessages)
    .values({
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      channel: 'imessage',
      direction: 'out',
      category: 'reply',
      templateKey: input.templateKey,
      dedupeKey: input.dedupeKey,
      providerChatId: input.chatId,
      status: acceptedStatus('imessage'),
      sentAt: input.now,
    })
    .onConflictDoNothing()
    .returning({ id: schema.channelMessages.id });
  if (!claimed) return 'already_sent';
  try {
    const sent = await sendLinqChatMessage({
      chatId: input.chatId,
      text: input.text,
      fetch: input.fetch,
    });
    await database
      .update(schema.channelMessages)
      .set({ providerMessageId: sent.providerMessageId })
      .where(eq(schema.channelMessages.id, claimed.id));
    await database.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: input.parentUserId,
      actionTaken: 'sms_reply_sent',
      targetTable: 'channel_messages',
      targetId: claimed.id,
    });
    return 'sent';
  } catch (err) {
    const code = err instanceof LinqSendError ? err.code : 'unknown';
    await database
      .update(schema.channelMessages)
      .set({ status: 'failed', errorCode: code })
      .where(eq(schema.channelMessages.id, claimed.id));
    console.warn({ familyId: input.familyId, code }, 'linq group coparent: the line did not land');
    return 'not_sent';
  }
}
