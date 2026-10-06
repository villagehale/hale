import { type Database, schema } from '@hale/db';
import { and, eq, inArray, notInArray } from 'drizzle-orm';
import { offerConnectorLinks } from '~/lib/channel/connect/offer';
import { acceptedStatus } from '~/lib/channel/ledger';
import { normalizePhoneE164 } from '~/lib/channels/phone';
import { resolveSendablePhone } from '~/lib/channels/sms-consent-core';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { linqGroupOnboardingV2Enabled } from './config';
import { audienceScope, readRosterAudience } from './group-audience';
import type { GroupOnboardingRequest } from './group-onboarding-line-input';
import {
  type GroupLineFallback,
  type GroupLineOutcome,
  type GroupLineSend,
  type GroupOnboardingComposer,
  composeOnboardingLine,
  sendGroupOnboardingLine,
} from './group-onboarding-voice';
import { isUndefinedTable } from './roster';
import { familyLanguage, firstName, primaryParentId } from './roster-ask';
import { LinqSendError, createLinqPhoneTransport, sendLinqParts } from './transport';

/**
 * Group onboarding v2 — the flow's 1:1 lines.
 *
 * A parent who just said, in the group, who they are gets their connect links here, 1:1,
 * never in the group: one model-written line that says who Hale is, whose household this
 * is, what the links do and that STOP stops it (the first thing Hale says to them 1:1, so
 * it carries the identification and the way out), then each link as a part of its own.
 * Their confirming reply is what this answers; Hale is not texting a number first.
 *
 * When Linq will not open that 1:1, the group hears one `text_me_directly` line (no
 * link) and the link waits for the member's own first 1:1 text, which resumes it here.
 * A group that went quiet because someone in it is not family tells the primary parent,
 * once, 1:1 (`group_quiet_notice`).
 *
 * Every send claims its `channel_messages` row first and audits `sms_reply_sent` once it
 * lands; a refusal releases the claim so the next message can try again.
 */

export interface OneToOneSend {
  text: (input: { to: string; body: string }) => Promise<{
    providerMessageId: string;
    chatId: string | null;
  }>;
  link: (input: { chatId: string; url: string }) => Promise<{ providerMessageId: string }>;
}

export function defaultOneToOneSend(): OneToOneSend {
  const transport = createLinqPhoneTransport();
  return {
    text: async (input) => {
      const sent = await transport.send({ to: input.to, body: input.body });
      return { providerMessageId: sent.providerMessageId, chatId: sent.chatId ?? null };
    },
    link: (input) =>
      sendLinqParts({ chatId: input.chatId, parts: [{ type: 'link', value: input.url }] }),
  };
}

const LINK_TEMPLATE = 'linq:connect_link_1to1';
const QUIET_TEMPLATE = 'linq:group_quiet_notice';
const PROVIDERS = ['gcal', 'gmail'] as const;

type OneToOneSent =
  | { outcome: 'sent'; chatId: string | null; rowId: string }
  | { outcome: 'already_sent' }
  | { outcome: 'not_sent'; code: string; permanent: boolean };

async function sendOneToOne(
  database: Database,
  input: {
    familyId: string;
    ledgerUserId: string;
    to: string;
    body: string;
    templateKey: string;
    dedupeKey: string;
    now: Date;
    send: OneToOneSend;
  },
): Promise<OneToOneSent> {
  const [claimed] = await database
    .insert(schema.channelMessages)
    .values({
      familyId: input.familyId,
      parentUserId: input.ledgerUserId,
      channel: 'imessage',
      direction: 'out',
      category: 'reply',
      templateKey: input.templateKey,
      dedupeKey: input.dedupeKey,
      status: acceptedStatus('imessage'),
      sentAt: input.now,
    })
    .onConflictDoNothing()
    .returning({ id: schema.channelMessages.id });
  if (!claimed) return { outcome: 'already_sent' };
  try {
    const sent = await input.send.text({ to: input.to, body: input.body });
    await database
      .update(schema.channelMessages)
      .set({ providerMessageId: sent.providerMessageId, providerChatId: sent.chatId })
      .where(eq(schema.channelMessages.id, claimed.id));
    await database.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: input.ledgerUserId,
      actionTaken: 'sms_reply_sent',
      targetTable: 'channel_messages',
      targetId: claimed.id,
      after: { templateKey: input.templateKey },
    });
    return { outcome: 'sent', chatId: sent.chatId, rowId: claimed.id };
  } catch (err) {
    if (!(err instanceof LinqSendError)) throw err;
    await database
      .update(schema.channelMessages)
      .set({ status: 'failed', errorCode: err.code, dedupeKey: null })
      .where(eq(schema.channelMessages.id, claimed.id));
    console.warn(
      { familyId: input.familyId, templateKey: input.templateKey, code: err.code },
      'linq 1:1 onboarding line did not land',
    );
    return { outcome: 'not_sent', code: err.code, permanent: err.permanent };
  }
}

async function sendLinkPart(
  database: Database,
  input: {
    familyId: string;
    userId: string;
    chatId: string;
    url: string;
    dedupeKey: string;
    now: Date;
    send: OneToOneSend;
  },
): Promise<{ ok: true } | { ok: false; code: string }> {
  const [claimed] = await database
    .insert(schema.channelMessages)
    .values({
      familyId: input.familyId,
      parentUserId: input.userId,
      channel: 'imessage',
      direction: 'out',
      category: 'reply',
      templateKey: LINK_TEMPLATE,
      dedupeKey: input.dedupeKey,
      providerChatId: input.chatId,
      status: acceptedStatus('imessage'),
      sentAt: input.now,
    })
    .onConflictDoNothing()
    .returning({ id: schema.channelMessages.id });
  if (!claimed) return { ok: true };
  try {
    const sent = await input.send.link({ chatId: input.chatId, url: input.url });
    await database
      .update(schema.channelMessages)
      .set({ providerMessageId: sent.providerMessageId })
      .where(eq(schema.channelMessages.id, claimed.id));
    await database.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: input.userId,
      actionTaken: 'sms_reply_sent',
      targetTable: 'channel_messages',
      targetId: claimed.id,
      after: { templateKey: LINK_TEMPLATE, part: 'link' },
    });
    return { ok: true };
  } catch (err) {
    if (!(err instanceof LinqSendError)) throw err;
    await database
      .update(schema.channelMessages)
      .set({ status: 'failed', errorCode: err.code, dedupeKey: null })
      .where(eq(schema.channelMessages.id, claimed.id));
    return { ok: false, code: err.code };
  }
}

async function setConnectStep(
  database: Database,
  input: { chatId: string | null; userId: string; step: schema.LinqRosterConnectStep; now: Date },
): Promise<void> {
  if (!input.chatId) return;
  await database
    .update(schema.linqGroupRosterMembers)
    .set({ connectStep: input.step, updatedAt: input.now })
    .where(
      and(
        eq(schema.linqGroupRosterMembers.chatId, input.chatId),
        eq(schema.linqGroupRosterMembers.userId, input.userId),
        eq(schema.linqGroupRosterMembers.status, 'confirmed'),
      ),
    );
}

export type ConnectLinkOutcome =
  | { outcome: 'sent'; links: number }
  | { outcome: 'already_sent' }
  | { outcome: 'not_enrolled' }
  | { outcome: 'mint_failed' }
  | { outcome: 'no_primary_parent' }
  | { outcome: 'group_line_unsent'; fallback: GroupLineFallback }
  | {
      outcome: '1to1_unreachable';
      code: string;
      groupNotice: GroupLineOutcome | { outcome: 'no_group' };
    }
  | { outcome: 'link_not_sent'; code: string }
  /** Linq is not configured, or did not answer: not a refusal, so nobody is asked anything. */
  | { outcome: '1to1_not_sent'; code: string };

/**
 * The co-parent's Calendar and Gmail links, 1:1, right after they said in the group who
 * they are. Once per person (`linq:connect_link_1to1:<userId>`); a 1:1 Linq refuses asks
 * them, in the group, to text Hale directly, and their first text resumes this. A missing
 * key or an outage is `1to1_not_sent` and is retried on their next message.
 */
export async function deliverConnectLinkOneToOne(
  database: Database,
  input: {
    familyId: string;
    userId: string;
    /** The family group they confirmed in, or null for a legacy group seat. */
    groupChatId: string | null;
    now: Date;
    voice: GroupOnboardingComposer | undefined;
    oneToOne?: OneToOneSend;
    groupSend?: GroupLineSend;
  },
): Promise<ConnectLinkOutcome> {
  const dedupeKey = `${LINK_TEMPLATE}:${input.userId}`;
  const [prior] = await database
    .select({ id: schema.channelMessages.id })
    .from(schema.channelMessages)
    .where(eq(schema.channelMessages.dedupeKey, dedupeKey));
  if (prior) return { outcome: 'already_sent' };

  const primary = await primaryParentId(database, input.familyId);
  if (!primary) return { outcome: 'no_primary_parent' };
  const language = await familyLanguage(database, input.familyId);
  const name = await firstName(database, input.userId);
  const request: GroupOnboardingRequest = {
    kind: 'connect_link_1to1',
    name,
    knownParentName: await firstName(database, primary),
    providers: ['Google Calendar', 'Gmail'],
  };
  const composed = await composeOnboardingLine(database, {
    familyId: input.familyId,
    request,
    language,
    templateKey: LINK_TEMPLATE,
    voice: input.voice,
  });
  if ('outcome' in composed) return composed;

  const minted = await offerConnectorLinks(database, {
    familyId: input.familyId,
    parentUserId: input.userId,
    providers: PROVIDERS,
    now: input.now,
  });
  if (minted.status !== 'minted') return { outcome: minted.status };
  const phone = await resolveSendablePhone(database, input.userId);
  if (!phone) return { outcome: 'not_enrolled' };

  const send = input.oneToOne ?? defaultOneToOneSend();
  const said = await sendOneToOne(database, {
    familyId: input.familyId,
    ledgerUserId: input.userId,
    to: phone,
    body: composed.body,
    templateKey: LINK_TEMPLATE,
    dedupeKey,
    now: input.now,
    send,
  });
  if (said.outcome === 'already_sent') return said;
  if (said.outcome === 'not_sent' && (!said.permanent || said.code === 'not_configured')) {
    return { outcome: '1to1_not_sent', code: said.code };
  }
  if (said.outcome === 'not_sent') {
    await setConnectStep(database, {
      chatId: input.groupChatId,
      userId: input.userId,
      step: 'unreachable',
      now: input.now,
    });
    const groupNotice = input.groupChatId
      ? await sendGroupOnboardingLine(database, {
          familyId: input.familyId,
          ledgerUserId: primary,
          chatId: input.groupChatId,
          request: { kind: 'text_me_directly', name },
          language,
          templateKey: 'linq:text_me_directly',
          dedupeKey: `linq:text_me_directly:${input.groupChatId}:${input.userId}`,
          now: input.now,
          voice: input.voice,
          send: input.groupSend,
        })
      : ({ outcome: 'no_group' } as const);
    console.info(
      { outcome: '1to1_unreachable', code: said.code, groupNotice: groupNotice.outcome },
      'linq connect link: 1:1 refused',
    );
    return { outcome: '1to1_unreachable', code: said.code, groupNotice };
  }

  // The retry mints fresh links, which spends these. Every part is released so the
  // retry sends the whole set again rather than skipping a link that no longer works.
  const releaseText = async (code: string): Promise<ConnectLinkOutcome> => {
    await database
      .update(schema.channelMessages)
      .set({ dedupeKey: null })
      .where(eq(schema.channelMessages.id, said.rowId));
    await database
      .update(schema.channelMessages)
      .set({ dedupeKey: null })
      .where(
        inArray(
          schema.channelMessages.dedupeKey,
          PROVIDERS.map((provider) => `${dedupeKey}:${provider}`),
        ),
      );
    console.warn({ outcome: 'link_not_sent', code }, 'linq connect link: link part refused');
    return { outcome: 'link_not_sent', code };
  };
  if (!said.chatId) return releaseText('missing_chat_id');
  for (const [index, url] of minted.urls.entries()) {
    const part = await sendLinkPart(database, {
      familyId: input.familyId,
      userId: input.userId,
      chatId: said.chatId,
      url,
      dedupeKey: `${dedupeKey}:${PROVIDERS[index]}`,
      now: input.now,
      send,
    });
    if (!part.ok) return releaseText(part.code);
  }

  await setConnectStep(database, {
    chatId: input.groupChatId,
    userId: input.userId,
    step: 'link_sent',
    now: input.now,
  });
  await database.insert(schema.auditLog).values({
    familyId: input.familyId,
    actor: input.userId,
    actionTaken: 'linq_group_connect_link_sent',
    targetTable: 'users',
    targetId: input.userId,
    after: { providers: [...PROVIDERS], source: composed.source },
  });
  return { outcome: 'sent', links: minted.urls.length };
}

/**
 * A confirmed co-parent whose links never went out (the line could not be written, or
 * Linq refused the 1:1) gets them on their next message, wherever they send it.
 */
export async function resumeConnectLink(
  database: Database,
  input: {
    phone: string;
    now: Date;
    voice: GroupOnboardingComposer | undefined;
    oneToOne?: OneToOneSend;
    groupSend?: GroupLineSend;
  },
): Promise<ConnectLinkOutcome | { outcome: 'flag_off' | 'not_migrated' | 'nothing_owed' }> {
  if (!linqGroupOnboardingV2Enabled()) return { outcome: 'flag_off' };
  const phone = normalizePhoneE164(input.phone);
  if (!phone) return { outcome: 'nothing_owed' };
  let owed: Array<{ userId: string | null; chatId: string; familyId: string | null }>;
  try {
    owed = await database
      .select({
        userId: schema.linqGroupRosterMembers.userId,
        chatId: schema.linqGroupRosterMembers.chatId,
        familyId: schema.linqGroupRosters.familyId,
      })
      .from(schema.linqGroupRosterMembers)
      .innerJoin(
        schema.linqGroupRosters,
        eq(schema.linqGroupRosters.id, schema.linqGroupRosterMembers.rosterId),
      )
      .where(
        and(
          eq(schema.linqGroupRosterMembers.phoneE164Hash, phoneBlindIndex(phone)),
          eq(schema.linqGroupRosterMembers.status, 'confirmed'),
          eq(schema.linqGroupRosterMembers.confirmedRole, 'co_parent'),
          inArray(schema.linqGroupRosterMembers.connectStep, ['none', 'unreachable']),
          notInArray(schema.linqGroupRosters.status, ['ejected']),
        ),
      )
      .limit(1);
  } catch (err) {
    if (isUndefinedTable(err)) return { outcome: 'not_migrated' };
    throw err;
  }
  const row = owed[0];
  if (!row?.userId || !row.familyId) return { outcome: 'nothing_owed' };
  return deliverConnectLinkOneToOne(database, {
    familyId: row.familyId,
    userId: row.userId,
    groupChatId: row.chatId,
    now: input.now,
    voice: input.voice,
    oneToOne: input.oneToOne,
    groupSend: input.groupSend,
  });
}

export type GroupQuietOutcome =
  | { outcome: 'not_quiet' }
  | { outcome: 'not_migrated' }
  | { outcome: 'no_primary_parent' }
  | { outcome: 'not_enrolled' }
  | { outcome: 'group_line_unsent'; fallback: GroupLineFallback }
  | { outcome: 'sent' }
  | { outcome: 'already_sent' }
  | { outcome: 'not_sent'; code: string };

const NOT_FAMILY: readonly schema.LinqRosterMemberStatus[] = ['not_family', 'refused'];

/**
 * Everyone has answered, and someone still in the chat is not family (or stopped), so the
 * group takes nothing. The primary parent is told once, 1:1, why and how to fix it.
 */
export async function noticeIfGroupQuiet(
  database: Database,
  input: {
    chatId: string;
    now: Date;
    voice: GroupOnboardingComposer | undefined;
    oneToOne?: OneToOneSend;
  },
): Promise<GroupQuietOutcome> {
  const roster = await readRosterAudience(database, input.chatId);
  if (roster === 'not_migrated') return { outcome: 'not_migrated' };
  if (
    !roster?.familyId ||
    roster.status !== 'confirmed' ||
    audienceScope(roster.members).size > 0
  ) {
    return { outcome: 'not_quiet' };
  }
  const familyId = roster.familyId;
  const primary = await primaryParentId(database, familyId);
  if (!primary) return { outcome: 'no_primary_parent' };
  const dedupeKey = `${QUIET_TEMPLATE}:${input.chatId}`;
  const [prior] = await database
    .select({ id: schema.channelMessages.id })
    .from(schema.channelMessages)
    .where(eq(schema.channelMessages.dedupeKey, dedupeKey));
  if (prior) return { outcome: 'already_sent' };

  const notFamily = roster.members.filter((member) => NOT_FAMILY.includes(member.status)).length;
  const stopped = roster.members.filter((member) => member.status === 'declined').length;
  const composed = await composeOnboardingLine(database, {
    familyId,
    request: {
      kind: 'group_quiet_notice',
      reason: notFamily > 0 ? 'not_family' : stopped > 0 ? 'stopped' : 'unconfirmed',
      count: Math.max(notFamily || stopped, 1),
    },
    language: await familyLanguage(database, familyId),
    templateKey: QUIET_TEMPLATE,
    voice: input.voice,
  });
  if ('outcome' in composed) return composed;
  const phone = await resolveSendablePhone(database, primary);
  if (!phone) return { outcome: 'not_enrolled' };
  const said = await sendOneToOne(database, {
    familyId,
    ledgerUserId: primary,
    to: phone,
    body: composed.body,
    templateKey: QUIET_TEMPLATE,
    dedupeKey,
    now: input.now,
    send: input.oneToOne ?? defaultOneToOneSend(),
  });
  return said.outcome === 'sent' ? { outcome: 'sent' } : said;
}
