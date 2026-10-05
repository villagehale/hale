import { type Database, schema } from '@hale/db';
import { and, eq, isNull } from 'drizzle-orm';
import { offerConnectorLinks } from '~/lib/channel/connect/offer';
import {
  type RequestIntentReader,
  defaultRequestIntentReader,
  readRequestIntent,
} from '~/lib/channel/connect/request-intent';
import { soleGivenName } from '~/lib/channel/identity/name-reply';
import { matchKeyword } from '~/lib/channel/intake/keywords';
import { type ReplyLanguage, replyLanguage } from '~/lib/channel/language';
import { acceptedStatus, dedupeActive } from '~/lib/channel/ledger';
import { normalizePhoneE164 } from '~/lib/channels/phone';
import { resolveVerifiedChannelByPhone } from '~/lib/channels/sms-consent-core';
import { POLICY_VERSION } from '~/lib/consent';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type CalendarConsentReader, defaultCalendarConsentReader } from './calendar-consent';
import { linqFromE164, linqGroupCoparentEnabled, linqGroupMembersEnabled } from './config';
import {
  LINQ_GROUP_LINE_MISSING_TEXT,
  formatLinqLineForParent,
  linqGroupMakeInstruction,
  matchLinqGroupTrigger,
} from './group';
import { liveSeatBlocksPrivileged, nonParentWithoutLiveSeat } from './group-members';
import {
  type GroupLineRequest,
  type GroupVoice,
  defaultGroupVoice,
  speakGroupLine,
} from './group-voice';
import { planBothFreeAsk, rememberBothFreeAsked } from './household-calendar';
import { sendLinqLinkPreview } from './link-preview';
import type { LinqInboundText } from './payload';
import { sendChoicePoll } from './poll';
import { LinqSendError, sendLinqChatMessage } from './transport';

/**
 * Seat a co-parent inside a claimed Linq group. SMS is not this module.
 *
 * No phone is collected in the 1:1. The enrolled parent claims the group.
 * The second real person in that group — not Hale, not a bot, not a handle
 * that will not parse as a phone — is seated on the SAME family. A legacy
 * `identity_noted` row is accepted if one still exists; it is not required.
 * Children and postal code are not asked again. One welcome carries the name
 * ask. Every line here is model-written from real facts (group-voice.ts); a
 * line the model cannot write is not sent, #ops is paged, and the next inbound
 * tries again. The next beat asks, on its own, whether they want the kids'
 * stuff on their calendar. The link goes out only after a model reading of yes
 * on their reply. The beat after that asks for Gmail. One ask per turn. A Google account already on the
 * family is still refused at the connect callback.
 *
 * On unless `LINQ_GROUP_COPARENT` is exactly `off`.
 */

const WELCOME_KEY = 'linq:coparent_welcome';
const CALENDAR_ASK_KEY = 'linq:coparent_calendar_ask';
const CALENDAR_LINK_KEY = 'linq:coparent_calendar_link';
const CALENDAR_HEADS_UP_KEY = 'linq:coparent_calendar_heads_up';
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
  /** The group's model voice. Absent falls back to the production composer. */
  voice?: GroupVoice;
  /** Reads a reply to the calendar question. Absent falls back to the production reader. */
  consentReader?: CalendarConsentReader;
  /**
   * Reads what a seated parent's later message asks for (a connect link, both-free).
   * Absent falls back to the production reader; `undefined` from that is the named
   * no-key state — nothing is claimed and #ops is paged once a day.
   */
  intentReader?: RequestIntentReader;
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
    if (
      await nonParentWithoutLiveSeat(database, {
        familyId: owner.familyId,
        userId: sender.userId,
        chatId: message.chatId,
      })
    ) {
      return { type: 'none' };
    }
    if (await liveSeatBlocksPrivileged(database, sender.userId)) {
      return { type: 'route_member' };
    }
    const stepped = await advanceSeatedCoparent(database, message, sender, language, ports);
    if (stepped) return stepped;
    return { type: 'route_member' };
  }

  if (sender && matchLinqGroupTrigger(message.text)) {
    const allowed = await humansAllowClaim(database, sender.familyId, message.otherHandles);
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

  if (!owner) {
    const noted = await notedInviteForPhone(database, senderPhone, ports.now);
    if (!noted) return { type: 'none' };
    return sayUnclaimed(database, message, noted, language, ports);
  }

  if (linqGroupMembersEnabled()) return { type: 'none' };

  const seated = await seatAppearingCoparent(database, {
    familyId: owner.familyId,
    invitedByUserId: await primaryParentId(database, owner.familyId),
    phoneE164: senderPhone,
    chatId: message.chatId,
    verbatim: message.text,
    now: ports.now,
  });
  if (seated.status !== 'seated') return { type: 'none' };

  const recorded = await ports.recordInbound(message, {
    familyId: owner.familyId,
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
  const notice = await sendWelcome(database, {
    familyId: owner.familyId,
    userId: seated.userId,
    chatId: message.chatId,
    language,
    ports,
  });
  return {
    type: 'done',
    outcome: 'group_coparent_seated',
    count: 'intake',
    body: { outcome: 'group_coparent_seated', notice },
  };
}

/**
 * The welcome, model-written. One send per seat: the dedupe key is the record, CLAIMED
 * BEFORE THE MODEL IS ASKED, so a webhook retry arriving while the first attempt is still
 * composing finds the key taken and costs no second call. A welcome the model could not
 * write gives the claim back, and is retried on the parent's next message — never sent
 * twice, never spent on a message nobody received.
 *
 * Exported for the two inbound doors (a claim with a seatable second handle, and Linq's
 * participant.added signal), which seat the same co-parent and owe the same welcome.
 */
export async function welcomeSeatedCoparent(
  database: Database,
  input: {
    familyId: string;
    userId: string;
    chatId: string;
    language: ReplyLanguage;
    ports: Pick<GroupCoparentPorts, 'voice' | 'now' | 'fetch'> & {
      /** A test hook for the inbound doors; production goes to Linq. */
      send?: (notice: { chatId: string; text: string }) => Promise<{ providerMessageId: string }>;
    };
  },
): Promise<'sent' | 'already_sent' | 'not_sent' | 'voice_unsent'> {
  const dedupeKey = `linq:coparent_welcome:${input.userId}`;
  const claimed = await claimLine(database, {
    familyId: input.familyId,
    parentUserId: input.userId,
    chatId: input.chatId,
    templateKey: WELCOME_KEY,
    dedupeKey,
    now: input.ports.now,
  });
  if (!claimed) return 'already_sent';
  const text = await groupLine(input.ports, { kind: 'welcome' }, input.language, undefined, {
    familyId: input.familyId,
    database,
  });
  if (!text) {
    await releaseLine(database, claimed);
    return 'voice_unsent';
  }
  return sendClaimedLine(database, claimed, {
    familyId: input.familyId,
    parentUserId: input.userId,
    chatId: input.chatId,
    text,
    fetch: input.ports.fetch,
    send: input.ports.send,
  });
}

const sendWelcome = welcomeSeatedCoparent;

/** One group line from the model, or null when it could not be written (already paged). */
async function groupLine(
  ports: Pick<GroupCoparentPorts, 'voice'>,
  request: GroupLineRequest,
  language: ReplyLanguage,
  parentWords?: string,
  scope?: { familyId: string; database: Database },
): Promise<string | null> {
  const spoken = await speakGroupLine(ports.voice ?? defaultGroupVoice(), request, language, {
    parentWords: parentWords ?? null,
    scope,
  });
  return spoken.source === 'unsent' ? null : spoken.body;
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
    step.step !== 'awaiting_calendar_yes' &&
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
      // A welcome the model could not write on the seating turn goes out now, once.
      const welcome = await sendWelcome(database, {
        familyId: sender.familyId,
        userId: sender.userId,
        chatId: message.chatId,
        language,
        ports,
      });
      return {
        type: 'done',
        outcome: 'group_coparent_name_waiting',
        count: 'ignored',
        body: { outcome: 'group_coparent_name_waiting', welcome },
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
    const ack = await groupLine(ports, { kind: 'name_ack', name }, language, message.text, {
      familyId: sender.familyId,
      database,
    });
    const notice = ack
      ? await sendLine(database, {
          familyId: sender.familyId,
          parentUserId: sender.userId,
          chatId: message.chatId,
          text: ack,
          templateKey: 'parent_name_captured',
          dedupeKey: `linq:coparent_name_ack:${sender.userId}`,
          now: ports.now,
          fetch: ports.fetch,
        })
      : 'voice_unsent';
    return {
      type: 'done',
      outcome: 'group_coparent_named',
      count: 'intake',
      body: { outcome: 'group_coparent_named', notice },
    };
  }

  if (
    step.step === 'awaiting_calendar' ||
    step.step === 'awaiting_calendar_yes' ||
    step.step === 'awaiting_gmail'
  ) {
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
    if (step.step === 'awaiting_calendar_yes') {
      return answerCalendarConsent(database, message, sender, name, language, ports);
    }
    if (step.step === 'awaiting_gmail') {
      // Their reply to the calendar link, or a pass on the calendar. One bubble.
      const asked = await sendGmailAskOnce(database, {
        familyId: sender.familyId,
        parentUserId: sender.userId,
        chatId: message.chatId,
        name,
        language,
        now: ports.now,
        fetch: ports.fetch,
        voice: ports.voice,
      });
      const outcome = asked === 'not_sent' ? 'group_coparent_link_held' : 'group_coparent_gmail';
      return {
        type: 'done',
        outcome,
        count: 'intake',
        body: { outcome },
      };
    }
    const ask = await groupLine(ports, { kind: 'calendar_ask', name }, language, message.text, {
      familyId: sender.familyId,
      database,
    });
    if (!ask) {
      return {
        type: 'done',
        outcome: 'group_coparent_link_held',
        count: 'intake',
        body: { outcome: 'group_coparent_link_held', reason: 'voice_unsent' },
      };
    }
    const sent = await sendLine(database, {
      familyId: sender.familyId,
      parentUserId: sender.userId,
      chatId: message.chatId,
      text: ask,
      templateKey: CALENDAR_ASK_KEY,
      dedupeKey: `${CALENDAR_ASK_KEY}:${sender.userId}`,
      now: ports.now,
      fetch: ports.fetch,
    });
    if (sent === 'sent') await setStep(database, sender.userId, 'awaiting_calendar_yes', ports.now);
    const outcome = sent === 'sent' ? 'group_coparent_calendar_asked' : 'group_coparent_link_held';
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
 * The reply to the calendar question. A model `yes` sends the link. Anything
 * else does not, and the next inbound is the Gmail ask. A failed read stays
 * here and sends nothing.
 */
async function answerCalendarConsent(
  database: Database,
  message: LinqInboundText,
  sender: { familyId: string; userId: string },
  name: string,
  language: ReplyLanguage,
  ports: GroupCoparentPorts,
): Promise<GroupCoparentEffect> {
  const reading = await (ports.consentReader ?? defaultCalendarConsentReader()).read({
    reply: message.text,
    scope: { familyId: sender.familyId, database },
  });
  if (reading.status === 'unread') {
    return {
      type: 'done',
      outcome: 'group_coparent_link_held',
      count: 'intake',
      body: { outcome: 'group_coparent_link_held', reason: 'consent_unread' },
    };
  }
  if (reading.label !== 'yes') {
    await setStep(database, sender.userId, 'awaiting_gmail', ports.now);
    return {
      type: 'done',
      outcome: 'group_coparent_calendar_passed',
      count: 'intake',
      body: { outcome: 'group_coparent_calendar_passed' },
    };
  }
  const scope = { familyId: sender.familyId, database };
  const link = await groupLine(
    ports,
    { kind: 'calendar_link', name },
    language,
    message.text,
    scope,
  );
  // Both bubbles are written before either is sent. A failed read sends nothing.
  const headsUp = link
    ? await groupLine(ports, { kind: 'calendar_heads_up', name }, language, message.text, scope)
    : null;
  if (!link || !headsUp) {
    return {
      type: 'done',
      outcome: 'group_coparent_link_held',
      count: 'intake',
      body: { outcome: 'group_coparent_link_held', reason: 'voice_unsent' },
    };
  }
  const sent = await sendAskWithLink(database, {
    familyId: sender.familyId,
    parentUserId: sender.userId,
    groupChatId: message.chatId,
    text: link,
    language,
    templateKey: CALENDAR_LINK_KEY,
    dedupeKey: `${CALENDAR_LINK_KEY}:${sender.userId}`,
    provider: 'gcal',
    now: ports.now,
    fetch: ports.fetch,
  });
  if (sent === 'not_sent') {
    return {
      type: 'done',
      outcome: 'group_coparent_link_held',
      count: 'intake',
      body: { outcome: 'group_coparent_link_held' },
    };
  }
  const headsSent = await sendLine(database, {
    familyId: sender.familyId,
    parentUserId: sender.userId,
    chatId: message.chatId,
    text: headsUp,
    templateKey: CALENDAR_HEADS_UP_KEY,
    dedupeKey: `${CALENDAR_HEADS_UP_KEY}:${sender.userId}`,
    now: ports.now,
    fetch: ports.fetch,
  });
  if (headsSent === 'not_sent') {
    console.warn({ familyId: sender.familyId }, 'linq group coparent: calendar heads-up unsent');
  }
  if (sent === 'sent') await setStep(database, sender.userId, 'awaiting_gmail', ports.now);
  const outcome = sent === 'sent' ? 'group_coparent_gcal' : 'group_coparent_link_held';
  return {
    type: 'done',
    outcome,
    count: 'intake',
    body: { outcome },
  };
}

/**
 * After both asks have gone out, a later "connect my gmail" (or calendar)
 * still gets a fresh link card. A both-free question is answered here and
 * nowhere else in the sweep.
 *
 * What the message asks for is the MODEL's reading (connect/request-intent.ts, setting
 * `household_group`), not a phrase list: a parent asks in their own words. One
 * classify-lane call per message from a seated parent whose asks are done; `other`
 * (the common case, and the answer for anything below the confidence floor) costs
 * nothing further and the turn goes on to the member route.
 */
async function answerDoneStep(
  database: Database,
  message: LinqInboundText,
  sender: { familyId: string; userId: string },
  language: ReplyLanguage,
  ports: GroupCoparentPorts,
): Promise<GroupCoparentEffect | null> {
  const reader = 'intentReader' in ports ? ports.intentReader : defaultRequestIntentReader();
  const read = await readRequestIntent(
    reader,
    { message: message.text, language, setting: 'household_group' },
    { scope: { familyId: sender.familyId, database } },
  );
  const asked =
    read.intent === 'connect_gmail' ? 'gmail' : read.intent === 'connect_gcal' ? 'gcal' : null;
  const bothFree = read.intent === 'both_free';
  if (asked === null && !bothFree) return null;
  const recorded = await ports.recordInbound(message, sender);
  if (!recorded) {
    return {
      type: 'done',
      outcome: 'duplicate',
      count: 'duplicate',
      body: { outcome: 'duplicate' },
    };
  }
  if (asked === null) {
    const plan = await planBothFreeAsk(database, {
      familyId: sender.familyId,
      now: ports.now,
      language,
    });
    if (plan.mode === 'none') {
      return {
        type: 'done',
        outcome: 'group_coparent_both_free_none',
        count: 'ignored',
        body: { outcome: 'group_coparent_both_free_none' },
      };
    }
    // One model-written line carries both slots. With polls on, the poll follows it.
    const text = await groupLine(
      ports,
      { kind: 'both_free', slots: plan.slotLabels },
      language,
      message.text,
      { familyId: sender.familyId, database },
    );
    if (!text) {
      return {
        type: 'done',
        outcome: 'group_coparent_both_free',
        count: 'intake',
        body: { outcome: 'group_coparent_both_free', reason: 'voice_unsent' },
      };
    }
    const sent = await sendLine(database, {
      familyId: sender.familyId,
      parentUserId: sender.userId,
      chatId: message.chatId,
      text,
      templateKey: 'linq:coparent_both_free',
      dedupeKey: `linq:coparent_both_free:${sender.userId}:${ports.now.toISOString().slice(0, 10)}`,
      now: ports.now,
      fetch: ports.fetch,
    });
    if (plan.mode === 'poll' && (sent === 'sent' || sent === 'already_sent')) {
      const poll = await sendChoicePoll(database, {
        chatId: message.chatId,
        prompt: null,
        options: plan.options,
        familyId: sender.familyId,
        parentUserId: sender.userId,
        now: ports.now,
        fetch: ports.fetch,
        idempotencyKey: `poll:${plan.factKey}:${sender.familyId}`.slice(0, 180),
      });
      if (poll.status === 'sent' || poll.status === 'prompted') {
        await rememberBothFreeAsked(database, {
          familyId: sender.familyId,
          parentUserId: sender.userId,
          factKey: plan.factKey,
          day: plan.day,
          slots: plan.slots,
          now: ports.now,
        });
      }
    }
    return {
      type: 'done',
      outcome: 'group_coparent_both_free',
      count: 'intake',
      body: { outcome: 'group_coparent_both_free' },
    };
  }
  const provider = asked;
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
 * The ask and its card, one bubble. Linq refuses a link part beside text, so
 * the URL is the next line of the same text part. The locked sentence itself
 * does not contain the token. Nothing here opens a 1:1 or falls back to Twilio.
 */
async function sendAskWithLink(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    groupChatId: string;
    text: string;
    templateKey: string;
    dedupeKey: string;
    provider: 'gcal' | 'gmail';
    now: Date;
    fetch?: typeof fetch;
    invalidatePrior?: boolean;
  },
): Promise<'sent' | 'already_sent' | 'not_sent'> {
  const minted = await offerConnectorLinks(database, {
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    providers: [input.provider],
    now: input.now,
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
  return sendLine(database, {
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    chatId: input.groupChatId,
    // The model's line carries the heads-up. Code appends only the URL.
    text: `${input.text}\n${url}`,
    templateKey: input.templateKey,
    dedupeKey: input.dedupeKey,
    now: input.now,
    fetch: input.fetch,
  });
}

/**
 * A card on its own, when the parent already asked for the link. The token is
 * the link part only. Nothing here opens a 1:1 or falls back to Twilio.
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
    voice?: GroupVoice;
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
  const dedupeKey = `${templateKey}:${input.connectId}`;
  if (await dedupeActive(dedupeKey, database)) return 'skipped';
  const receipt = await groupLine(
    input,
    { kind: gmail ? 'gmail_receipt' : 'calendar_receipt', name },
    language,
    undefined,
    { familyId: input.familyId, database },
  );
  if (!receipt) return 'skipped';
  const notice = await sendLine(database, {
    familyId: input.familyId,
    parentUserId: input.userId,
    chatId: family.linqGroupChatId,
    text: receipt,
    templateKey,
    dedupeKey,
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
      voice: input.voice,
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
    voice?: GroupVoice;
  },
): Promise<'sent' | 'already_sent' | 'not_sent'> {
  if (await dedupeActive(`${GMAIL_ASK_KEY}:${input.parentUserId}`, database)) {
    return 'already_sent';
  }
  const ask = await groupLine(
    input,
    { kind: 'gmail_ask', name: input.name },
    input.language,
    undefined,
    {
      familyId: input.familyId,
      database,
    },
  );
  if (!ask) return 'not_sent';
  const notice = await sendAskWithLink(database, {
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    groupChatId: input.chatId,
    text: ask,
    templateKey: GMAIL_ASK_KEY,
    dedupeKey: `${GMAIL_ASK_KEY}:${input.parentUserId}`,
    provider: 'gmail',
    now: input.now,
    fetch: input.fetch,
    invalidatePrior: false,
  });
  if (notice === 'not_sent') return 'not_sent';
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

function isHaleLine(phone: string): boolean {
  const from = linqFromE164();
  if (!from) return false;
  return normalizePhoneE164(from) === phone;
}

/** A phone Hale can seat. Email, short junk, and Hale's own line are not people. */
export function realHumanPhone(handle: string): string | null {
  const phone = normalizePhoneE164(handle);
  if (!phone || isHaleLine(phone)) return null;
  return phone;
}

/**
 * Claim is allowed without a stored number. Another family's member blocks
 * the claim. A handle that is not a phone is ignored here and never seated.
 */
async function humansAllowClaim(
  database: Database,
  familyId: string,
  others: readonly string[],
): Promise<boolean> {
  for (const handle of others) {
    const phone = realHumanPhone(handle);
    if (!phone) continue;
    const member = await resolveVerifiedChannelByPhone(database, phone);
    if (member && member.familyId !== familyId) return false;
  }
  return true;
}

async function primaryParentId(database: Database, familyId: string): Promise<string | null> {
  const rows = await database
    .select({
      userId: schema.familyMembers.userId,
      role: schema.familyMembers.role,
      familyId: schema.familyMembers.familyId,
    })
    .from(schema.familyMembers)
    .where(eq(schema.familyMembers.familyId, familyId));
  return (
    rows.find((row) => row.familyId === familyId && row.role === 'primary_parent')?.userId ?? null
  );
}

/**
 * Seat the second real person in a claimed Linq group. No prior phone.
 * A legacy `identity_noted` invite for this number is closed when one exists.
 */
export async function seatAppearingCoparent(
  database: Database,
  input: {
    familyId: string;
    invitedByUserId: string | null;
    phoneE164: string;
    chatId: string;
    verbatim: string;
    now: Date;
  },
): Promise<{ status: 'seated'; userId: string } | { status: 'refused' }> {
  const phone = realHumanPhone(input.phoneE164);
  if (!phone) return { status: 'refused' };
  if (await familyHasCoParent(database, input.familyId)) return { status: 'refused' };
  const existing = await resolveVerifiedChannelByPhone(database, phone);
  if (existing) return { status: 'refused' };

  const noted = await notedInviteForPhone(database, phone, input.now);
  // A live note for a different household stays on that household.
  if (noted && noted.familyId !== input.familyId) return { status: 'refused' };
  const phoneHash = phoneBlindIndex(phone);
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
    if (!user) throw new Error('seatAppearingCoparent: users insert returned no row');

    await tx
      .insert(schema.familyMembers)
      .values({
        familyId: input.familyId,
        userId: user.id,
        role: 'co_parent',
        invitedByUserId: input.invitedByUserId,
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
        familyId: input.familyId,
        consentType: 'sms_service_messages',
        granted: true,
        consentScope: 'sms_coparent_invite_reply',
        policyVersion: POLICY_VERSION,
        evidence: {
          verbatimReply: input.verbatim,
          interpretation:
            'the second person in the household iMessage group the other parent started',
          channel: 'imessage',
        },
      })
      .returning({ id: schema.consentRecords.id });
    if (!consent) throw new Error('seatAppearingCoparent: consent insert returned no row');

    await tx.insert(schema.parentChannels).values({
      userId: user.id,
      familyId: input.familyId,
      kind: 'sms',
      phoneE164Encrypted: encryptString(phone),
      phoneE164Hash: phoneHash,
      verifiedAt: input.now,
      consentRecordId: consent.id,
    });

    await tx.insert(schema.linqGroupOnboarding).values({
      familyId: input.familyId,
      userId: user.id,
      providerChatId: input.chatId,
      step: 'awaiting_name',
      createdAt: input.now,
      updatedAt: input.now,
    });

    if (noted && noted.familyId === input.familyId) {
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
            eq(schema.caregiverInvites.id, noted.id),
            eq(schema.caregiverInvites.state, 'identity_noted'),
          ),
        );
    }

    await tx.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: user.id,
      actionTaken: 'co_parent_invite_accepted',
      targetTable: 'family_members',
      targetId: user.id,
      after: { via: 'linq_group', priorPhone: noted ? 'noted' : 'none' },
    });
    return user.id;
  });

  return { status: 'seated', userId };
}

/** The first other phone in the chat that can be a co-parent. Hale's line is not one. */
export function firstSeatableHandle(
  handles: readonly string[],
  senderHandle?: string,
): string | null {
  const sender = senderHandle ? normalizePhoneE164(senderHandle) : null;
  for (const handle of handles) {
    const phone = realHumanPhone(handle);
    if (!phone || phone === sender) continue;
    return phone;
  }
  return null;
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
  const claimed = await claimLine(database, input);
  if (!claimed) return 'already_sent';
  return sendClaimedLine(database, claimed, input);
}

/** The ledger row that IS the claim: one per dedupe key, first writer wins. Null when taken. */
async function claimLine(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    chatId: string;
    templateKey: string;
    dedupeKey: string;
    now: Date;
  },
): Promise<string | null> {
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
  return claimed?.id ?? null;
}

/** Give a claim back: the line was never written, so the key must not read as spent. */
async function releaseLine(database: Database, claimedId: string): Promise<void> {
  await database.delete(schema.channelMessages).where(eq(schema.channelMessages.id, claimedId));
}

async function sendClaimedLine(
  database: Database,
  claimedId: string,
  input: {
    familyId: string;
    parentUserId: string;
    chatId: string;
    text: string;
    fetch?: typeof fetch;
    send?: (notice: { chatId: string; text: string }) => Promise<{ providerMessageId: string }>;
  },
): Promise<'sent' | 'not_sent'> {
  try {
    const sent = input.send
      ? await input.send({ chatId: input.chatId, text: input.text })
      : await sendLinqChatMessage({ chatId: input.chatId, text: input.text, fetch: input.fetch });
    await database
      .update(schema.channelMessages)
      .set({ providerMessageId: sent.providerMessageId })
      .where(eq(schema.channelMessages.id, claimedId));
    await database.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: input.parentUserId,
      actionTaken: 'sms_reply_sent',
      targetTable: 'channel_messages',
      targetId: claimedId,
    });
    return 'sent';
  } catch (err) {
    const code = err instanceof LinqSendError ? err.code : 'unknown';
    await database
      .update(schema.channelMessages)
      .set({ status: 'failed', errorCode: code })
      .where(eq(schema.channelMessages.id, claimedId));
    console.warn({ familyId: input.familyId, code }, 'linq group coparent: the line did not land');
    return 'not_sent';
  }
}
