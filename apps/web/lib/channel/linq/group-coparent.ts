import { type Database, schema } from '@hale/db';
import { and, eq, isNull } from 'drizzle-orm';
import { matchConnectorRequest } from '~/lib/channel/connect/detect';
import { offerConnectorLinks } from '~/lib/channel/connect/offer';
import { soleGivenName } from '~/lib/channel/identity/name-reply';
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
import {
  groupCalendarAsk,
  groupCalendarReceipt,
  groupGmailAsk,
  groupGmailReceipt,
  groupWelcome,
  matchBothFreeAsk,
} from './group-coparent-copy';
import { answerBothFreeInGroup } from './household-calendar';
import { sendLinqLinkPreview } from './link-preview';
import type { LinqInboundText } from './payload';
import { LinqSendError, sendLinqChatMessage } from './transport';

/**
 * Seat a co-parent inside a claimed Linq group. SMS is not this module.
 *
 * The onboarded parent already stored the number (`identity_noted`, #706).
 * When that number speaks in the claimed group, Hale opens a user, a
 * `co_parent` seat, and a channel on the SAME family. Children and postal
 * code are not asked again. One welcome carries the name ask. The name ack
 * is the locked line. The next beat asks for that parent's calendar. The
 * connect link is a card in the group, bound to that parent, never a 1:1
 * and never written into the ask. The beat after that asks for Gmail the
 * same way. One ask per turn.
 *
 * On unless `LINQ_GROUP_COPARENT` is exactly `off`.
 */

const WELCOME_KEY = 'linq:coparent_welcome';
const CALENDAR_ASK_KEY = 'linq:coparent_calendar_ask';
const GMAIL_ASK_KEY = 'linq:coparent_gmail_ask';
const GMAIL_RECEIPT_KEY = 'linq:coparent_gmail_receipt';
const UNCLAIMED_KEY = 'linq:coparent_unclaimed';
const RECEIPT_KEY = 'linq:coparent_calendar_receipt';

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
    text: groupWelcome(language),
    templateKey: WELCOME_KEY,
    dedupeKey: `linq:coparent_welcome:${seated.userId}`,
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
  if (!step || step.chatId !== message.chatId) return null;
  if (step.step === 'done') {
    return answerDoneStep(database, message, sender, language, ports);
  }
  if (
    step.step !== 'awaiting_name' &&
    step.step !== 'awaiting_calendar' &&
    step.step !== 'awaiting_gmail'
  ) {
    return null;
  }

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
    const [named] = await database
      .select({ name: schema.users.name })
      .from(schema.users)
      .where(eq(schema.users.id, sender.userId))
      .limit(1);
    const name = named?.name?.trim();
    if (!name) {
      return {
        type: 'done',
        outcome: 'group_coparent_link_held',
        count: 'ignored',
        body: { outcome: 'group_coparent_link_held' },
      };
    }
    if (step.step === 'awaiting_gmail') {
      // Their reply to the calendar ask. One bubble, and never again if they ignore it.
      const asked = await sendGmailAskOnce(database, {
        familyId: sender.familyId,
        parentUserId: sender.userId,
        chatId: message.chatId,
        name,
        language,
        now: ports.now,
        fetch: ports.fetch,
      });
      const outcome = asked === 'not_sent' ? 'group_coparent_link_held' : 'group_coparent_gmail';
      return {
        type: 'done',
        outcome,
        count: 'intake',
        body: { outcome },
      };
    }
    const ask = groupCalendarAsk(language, name);
    await sendLine(database, {
      familyId: sender.familyId,
      parentUserId: sender.userId,
      chatId: message.chatId,
      text: ask,
      templateKey: CALENDAR_ASK_KEY,
      dedupeKey: `${CALENDAR_ASK_KEY}:${sender.userId}`,
      now: ports.now,
      fetch: ports.fetch,
    });
    const sent = await deliverGroupLink(database, {
      familyId: sender.familyId,
      parentUserId: sender.userId,
      groupChatId: message.chatId,
      provider: 'gcal',
      now: ports.now,
      fetch: ports.fetch,
    });
    if (sent === 'sent') await setStep(database, sender.userId, 'awaiting_gmail', ports.now);
    const outcome = sent === 'sent' ? 'group_coparent_gcal' : 'group_coparent_link_held';
    return {
      type: 'done',
      outcome,
      count: 'intake',
      body: { outcome },
    };
  }

  return null;
}

/**
 * After both asks have gone out, a later "connect my gmail" (or calendar)
 * still gets a fresh 1:1 link. A both-free question is answered here and
 * nowhere else in the sweep.
 */
async function answerDoneStep(
  database: Database,
  message: LinqInboundText,
  sender: { familyId: string; userId: string },
  language: ReplyLanguage,
  ports: GroupCoparentPorts,
): Promise<GroupCoparentEffect | null> {
  const asked = matchConnectorRequest(message.text);
  const bothFree = matchBothFreeAsk(message.text);
  if (asked !== 'gmail' && asked !== 'gcal' && !bothFree) return null;
  const recorded = await ports.recordInbound(message, sender);
  if (!recorded) {
    return {
      type: 'done',
      outcome: 'duplicate',
      count: 'duplicate',
      body: { outcome: 'duplicate' },
    };
  }
  if (bothFree && asked !== 'gmail' && asked !== 'gcal') {
    const text = await answerBothFreeInGroup(database, {
      familyId: sender.familyId,
      now: ports.now,
      language,
    });
    if (!text) {
      return {
        type: 'done',
        outcome: 'group_coparent_both_free_none',
        count: 'ignored',
        body: { outcome: 'group_coparent_both_free_none' },
      };
    }
    await sendLine(database, {
      familyId: sender.familyId,
      parentUserId: sender.userId,
      chatId: message.chatId,
      text,
      templateKey: 'linq:coparent_both_free',
      dedupeKey: `linq:coparent_both_free:${sender.userId}:${ports.now.toISOString().slice(0, 10)}`,
      now: ports.now,
      fetch: ports.fetch,
    });
    return {
      type: 'done',
      outcome: 'group_coparent_both_free',
      count: 'intake',
      body: { outcome: 'group_coparent_both_free' },
    };
  }
  const provider = asked === 'gmail' ? 'gmail' : 'gcal';
  const sent = await deliverGroupLink(database, {
    familyId: sender.familyId,
    parentUserId: sender.userId,
    groupChatId: message.chatId,
    provider,
    now: ports.now,
    fetch: ports.fetch,
    invalidatePrior: provider === 'gcal',
  });
  return {
    type: 'done',
    outcome: sent === 'sent' ? `group_coparent_${provider}` : 'group_coparent_link_held',
    count: 'intake',
    body: { outcome: sent === 'sent' ? `group_coparent_${provider}` : 'group_coparent_link_held' },
  };
}

/**
 * The connect card, in the group. The token is the link part only. The ask
 * text never carries it, and nothing here opens a 1:1 or falls back to Twilio.
 */
async function deliverGroupLink(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    groupChatId: string;
    provider: 'gcal' | 'gmail';
    now: Date;
    fetch?: typeof fetch;
    invalidatePrior?: boolean;
  },
): Promise<'sent' | 'not_sent'> {
  const minted = await offerConnectorLinks(database, {
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    providers: [input.provider],
    now: input.now,
    // A later Gmail ask must not invalidate the calendar token already out.
    invalidatePrior: input.invalidatePrior ?? input.provider === 'gcal',
  });
  if (minted.status !== 'minted') {
    console.warn(
      { familyId: input.familyId, provider: input.provider, reason: minted.status },
      'linq group coparent: no connector link',
    );
    return 'not_sent';
  }
  const url = minted.urls[0];
  if (!url) return 'not_sent';
  const preview = await sendLinqLinkPreview({
    channel: 'imessage',
    chatId: input.groupChatId,
    url,
    fetch: input.fetch,
    database,
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    now: input.now,
  });
  if (preview.status !== 'sent') {
    console.warn(
      { familyId: input.familyId, provider: input.provider, reason: preview.reason },
      'linq group coparent: group card was not sent',
    );
    return 'not_sent';
  }
  return 'sent';
}

/**
 * The group receipt for a co-parent connect. Its own bubble, only into
 * `families.linq_group_chat_id`, and never paired with the next ask. Gmail's
 * line names the connect and nothing from the mailbox. A Linq refusal is not
 * retried on Twilio. The 1:1 receipt is a different send.
 */
export async function sendCoparentGroupCalendarReceipt(
  database: Database,
  input: {
    familyId: string;
    userId: string;
    provider: 'gcal' | 'gmail' | 'gdrive';
    connectId: string;
    now: Date;
    fetch?: typeof fetch;
  },
): Promise<'sent' | 'skipped'> {
  if (!linqGroupCoparentEnabled()) return 'skipped';
  if (input.provider !== 'gcal' && input.provider !== 'gmail') return 'skipped';
  const members = await database
    .select({
      userId: schema.familyMembers.userId,
      role: schema.familyMembers.role,
      familyId: schema.familyMembers.familyId,
    })
    .from(schema.familyMembers)
    .where(eq(schema.familyMembers.familyId, input.familyId));
  const seat = members.find(
    (row) =>
      row.familyId === input.familyId && row.userId === input.userId && row.role === 'co_parent',
  );
  if (!seat) return 'skipped';
  const [family] = await database
    .select({
      linqGroupChatId: schema.families.linqGroupChatId,
      primaryLanguage: schema.families.primaryLanguage,
    })
    .from(schema.families)
    .where(eq(schema.families.id, input.familyId))
    .limit(1);
  if (!family?.linqGroupChatId) return 'skipped';
  const [user] = await database
    .select({ name: schema.users.name })
    .from(schema.users)
    .where(eq(schema.users.id, input.userId))
    .limit(1);
  const name = user?.name?.trim();
  if (!name) return 'skipped';
  const language: ReplyLanguage = family.primaryLanguage?.toLowerCase().startsWith('fr')
    ? 'fr'
    : 'en';
  const gmail = input.provider === 'gmail';
  const templateKey = gmail ? GMAIL_RECEIPT_KEY : RECEIPT_KEY;
  const notice = await sendLine(database, {
    familyId: input.familyId,
    parentUserId: input.userId,
    chatId: family.linqGroupChatId,
    text: gmail ? groupGmailReceipt(language, name) : groupCalendarReceipt(language, name),
    templateKey,
    dedupeKey: `${templateKey}:${input.connectId}`,
    now: input.now,
    fetch: input.fetch,
  });
  if (gmail) {
    // Connected already. The receipt is the whole turn; do not attach an ask.
    await setStep(database, input.userId, 'done', input.now);
    return notice === 'sent' ? 'sent' : 'skipped';
  }
  if (notice === 'sent' || notice === 'already_sent') {
    // The receipt has landed. The ask, if it has not gone out, is the next bubble.
    await sendGmailAskOnce(database, {
      familyId: input.familyId,
      parentUserId: input.userId,
      chatId: family.linqGroupChatId,
      name,
      language,
      now: input.now,
      fetch: input.fetch,
    });
  }
  return notice === 'sent' ? 'sent' : 'skipped';
}

/**
 * The Gmail ask, once. A later ignore does not send it again: the dedupe
 * row is the record, and the step moves to done when the bubble goes out.
 */
async function sendGmailAskOnce(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    chatId: string;
    name: string;
    language: ReplyLanguage;
    now: Date;
    fetch?: typeof fetch;
  },
): Promise<'sent' | 'already_sent' | 'not_sent'> {
  const ask = groupGmailAsk(input.language, input.name);
  const notice = await sendLine(database, {
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    chatId: input.chatId,
    text: ask,
    templateKey: GMAIL_ASK_KEY,
    dedupeKey: `${GMAIL_ASK_KEY}:${input.parentUserId}`,
    now: input.now,
    fetch: input.fetch,
  });
  if (notice === 'not_sent') return 'not_sent';
  if (notice === 'sent') {
    await deliverGroupLink(database, {
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      groupChatId: input.chatId,
      provider: 'gmail',
      now: input.now,
      fetch: input.fetch,
      invalidatePrior: false,
    });
  }
  await setStep(database, input.parentUserId, 'done', input.now);
  return notice;
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
