import { type Database, schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { coachBubblesEnabled } from '~/lib/channel/coach/bubbles';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import { acceptedStatus } from '~/lib/channel/ledger';
import { type BubbleGaps, readBubbleGaps } from '~/lib/channel/linq/bubble-gap';
import { deliverFamilyOutbound } from '~/lib/channel/linq/family-outbound';
import { sendLinkOnce } from '~/lib/channel/linq/link-preview';
import { chatServiceSaid } from '~/lib/channel/messaging-door';
import { createOutboundTransport } from '~/lib/channel/outbound-transport';
import { readParentLanguage } from '~/lib/channel/parent-language';
import { resolveReplyClient } from '~/lib/channel/reply-copy/client';
import { threadProactiveMessage } from '~/lib/channel/thread';
import { resolveSendablePhone } from '~/lib/channels/sms-consent-core';
import { runBrowserUsePlanForMode } from '../browser-use/assisted-engine';
import { liveViewUrl } from '../browser-use/live-view';
import { releasePlanRun, settleBrowserUsePlanPayment } from '../browser-use/plan-engine';
import { browserUseSignupRunnerFromEnv } from '../browser-use/runner';
import { markLoginLinkSent } from '../login-link/store';
import { AskOrderUnmarked, type AskedAbout, type SendStamp, askStamp } from '../store';
import { childFirstName, parentTimeZone, replySessions } from './conversation';
import { createProviderNoticeWriter } from './notice-writer';
import type { PlanNoticeKind, PlanPrepDeliver, PlanPrepDeps } from './prep';
import type { PlanNotice, PlanOutcomeNotice, PlanRunDeps } from './run';
import { planLapse } from './store';
import { planReplyMode } from './towns';
import {
  type PlanReplyWriter,
  createPlanReplyWriter,
  planOpensAtLocal,
  planReplyBody,
} from './writer';

export const PLAN_NOTICE_TEMPLATE = 'signup_plan_notice';
export const PLAN_PREP_TEMPLATE = 'signup_plan_prep';

export interface PlanNotifierDeps {
  writer: PlanReplyWriter;
  transport: ChannelTransport;
  now: () => Date;
}

/**
 * VIL-558 · the one text after a plan's run, to the parent who approved it and to no one
 * else: it can carry a live browser on their city account.
 *
 * - The model writes it from the run's facts ({@link PlanReplyWriter}); the live-view link
 *   never reaches the model. Code re-pins its host and appends it after the text.
 * - It goes 1:1, never to a family group. The thread copy goes through `appendMessage`,
 *   which stores a placeholder in place of any live-view link (VIL-578), so the link never
 *   enters conversation history.
 * - The parent's yes is read again first. A parent who left, opted out or is held as a
 *   possible stop is not texted: `withheld`, the same code for every reason, so the
 *   family-visible audit row never says which adult did what.
 * - This is the receipt for a registration the parent set up, not an unprompted message,
 *   so it does not wait for quiet hours: a held cart cannot wait until morning.
 */
export function createPlanNotifier(
  database: Database,
  deps: PlanNotifierDeps,
): (notice: PlanOutcomeNotice) => Promise<PlanNotice> {
  return async (notice) => {
    const now = deps.now();
    const lapse = await planLapse(database, notice);
    if (lapse) {
      console.info({ offerId: notice.offerId, code: 'withheld' }, 'signup plans: notice withheld');
      return 'withheld';
    }
    const offers = schema.authorizedSignupOffers;
    const [offer] = await database
      .select()
      .from(offers)
      .where(and(eq(offers.id, notice.offerId), eq(offers.familyId, notice.familyId)))
      .limit(1);
    if (!offer?.planOpensAt) {
      console.warn({ offerId: notice.offerId, code: 'offer_gone' }, 'signup plans: notice failed');
      return 'failed';
    }
    const choices = (offer.planChoiceIds ?? []).flatMap((id) =>
      offer.sessions.filter((session) => session.id === id),
    );
    const live = liveViewUrl(notice.liveViewUrl);
    const confirmed = notice.outcome === 'completed' && notice.confirmationNumber !== null;
    const holdMinutes =
      live && notice.holdExpiresAt
        ? Math.max(0, Math.ceil((notice.holdExpiresAt.getTime() - now.getTime()) / 60_000))
        : null;
    const text = await deps.writer.write({
      moment: 'run_finished',
      mode: planReplyMode(offer.registrationUrl),
      childFirstName: await childFirstName(database, {
        familyId: notice.familyId,
        childId: offer.childId,
      }),
      opensAt: planOpensAtLocal(
        offer.planOpensAt,
        await parentTimeZone(database, notice.parentUserId),
      ),
      sessions: replySessions(choices),
      maxPriceCents: offer.planMaxPriceCents,
      waiverAccepted: offer.planWaiverAccepted,
      question: null,
      refusal: null,
      run: {
        outcome: notice.outcome,
        detail: notice.detail,
        confirmed,
        sessionLabel:
          notice.choiceIndex === null ? null : (choices[notice.choiceIndex]?.label ?? null),
        cartTotalCents: notice.cartTotalCents,
        amountChargedCents: notice.amountChargedCents,
        charged: notice.charged,
        liveBrowser: live !== null,
        holdMinutes,
      },
      language: await readParentLanguage(database, {
        familyId: notice.familyId,
        parentUserId: notice.parentUserId,
      }),
    });
    if (text === null) {
      console.warn({ offerId: notice.offerId, code: 'unwritten' }, 'signup plans: notice failed');
      return 'failed';
    }
    const body = planReplyBody(text, live ?? (confirmed ? null : offer.registrationUrl));
    const to = await resolveSendablePhone(database, notice.parentUserId);
    if (!to) {
      console.info({ offerId: notice.offerId, code: 'withheld' }, 'signup plans: notice withheld');
      return 'withheld';
    }
    return deliverDirect(database, deps, notice, { body, to, now });
  };
}

async function deliverDirect(
  database: Database,
  deps: PlanNotifierDeps,
  notice: PlanOutcomeNotice,
  input: { body: string; to: string; now: Date },
): Promise<PlanNotice> {
  const messages = schema.channelMessages;
  const [row] = await database
    .insert(messages)
    .values({
      familyId: notice.familyId,
      parentUserId: notice.parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'reply',
      templateKey: PLAN_NOTICE_TEMPLATE,
      dedupeKey: `${PLAN_NOTICE_TEMPLATE}:${notice.offerId}`,
      status: 'queued',
      sentAt: null,
    })
    .onConflictDoNothing()
    .returning({ id: messages.id });
  if (!row) return 'sent';
  const failed = async (code: string): Promise<PlanNotice> => {
    await database
      .update(messages)
      .set({ status: 'failed', errorCode: code.slice(0, 80) })
      .where(and(eq(messages.id, row.id), eq(messages.familyId, notice.familyId)));
    console.warn({ offerId: notice.offerId, code }, 'signup plans: notice failed');
    return 'failed';
  };
  let delivered: Awaited<ReturnType<typeof deliverStamped>>;
  try {
    delivered = await deliverStamped(
      database,
      {
        familyId: notice.familyId,
        parentUserId: notice.parentUserId,
        offerIds: [notice.offerId],
      },
      {
        familyId: notice.familyId,
        body: input.body,
        to: input.to,
        legacy: deps.transport,
        target: { channel: 'legacy' },
        shareGroupCap: false,
        now: input.now,
      },
    );
  } catch (err) {
    return failed(err instanceof Error ? err.constructor.name : 'send_threw');
  }
  if (delivered instanceof AskOrderUnmarked) {
    // The transport was never called. A failed row under this key would make every later
    // call answer 'sent' above, so the claim is let go and a later call can send it.
    await database
      .delete(messages)
      .where(and(eq(messages.id, row.id), eq(messages.familyId, notice.familyId)));
    console.warn(
      { offerId: notice.offerId, code: delivered.message },
      'signup plans: notice failed',
    );
    return 'failed';
  }
  if (delivered.status !== 'sent') return failed(delivered.reason);
  await database
    .update(messages)
    .set({
      channel: delivered.channel,
      status: acceptedStatus(delivered.channel),
      providerMessageId: delivered.providerMessageId,
      providerChatId: delivered.chatId,
      sentAt: input.now,
    })
    .where(and(eq(messages.id, row.id), eq(messages.familyId, notice.familyId)));
  await threadProactiveMessage(database, {
    familyId: notice.familyId,
    parentUserId: notice.parentUserId,
    body: input.body,
  });
  return 'sent';
}

/**
 * The door for the login ask, account prep, the 30-minute reminder and the event notices.
 * Each bubble has its own ledger row beside its send; under a notice key that row is keyed
 * `signup_plan_prep:<noticeKey>:<index>`, so the sweep's retry skips a bubble that went and
 * sends one whose try failed. The login link goes once through {@link sendLinkOnce}, on the
 * chat the bubble before it used: a Linq link card on iMessage, its own text where a card
 * cannot go. A card that went is stamped sent, so the retry reuses it instead of minting a
 * second. A part that does not go stops the notice as `failed`, and the sweep sends the
 * rest next time. Each text bubble that goes stamps the offer as asked (`askStamp`), so
 * a notice that partly went still counts, and a bubble a retry skips stamps nothing again.
 *
 * Lit for bubbles (VIL-682 K5), a part that follows one this call sent, in a chat Linq said
 * is iMessage, waits the bubble gap with typing up: the model's bubbles and the card alike.
 */
export function createPlanPrepDeliver(
  database: Database,
  deps: { transport: ChannelTransport; fetch?: typeof fetch },
): PlanPrepDeliver {
  return async (input) => {
    const to = await resolveSendablePhone(database, input.parentUserId);
    if (!to) {
      console.info(
        { offerId: input.offerId, kind: input.kind, code: 'withheld' },
        'signup plan prep: not sent',
      );
      return 'withheld';
    }
    let carried: { channel: 'sms' | 'imessage'; chatId: string | null } = {
      channel: 'sms',
      chatId: null,
    };
    const lit = coachBubblesEnabled(input.familyId);
    // Opened at the first part that follows a send, on the chat that send used.
    let gaps: BubbleGaps | null | undefined;
    let sentHere = false;
    const pace: PrepPace = async (send, went) => {
      if (sentHere && gaps === undefined) {
        const chatId = carried.channel === 'imessage' ? carried.chatId : null;
        gaps =
          lit && chatId
            ? await readBubbleGaps({
                chatId,
                readService: () => chatServiceSaid(database, input.parentUserId, chatId),
                log: console,
              })
            : null;
      }
      const out = sentHere && gaps ? await gaps(send, went) : await send();
      sentHere = true;
      return out;
    };
    let textIndex = 0;
    for (const part of input.parts) {
      if (part.type === 'text') {
        const sent = await sendPrepText(database, deps.transport, pace, {
          ...input,
          to,
          body: part.body,
          dedupeKey:
            input.noticeKey === null
              ? null
              : `${PLAN_PREP_TEMPLATE}:${input.noticeKey}:${textIndex}`,
        });
        textIndex += 1;
        if (!sent) return 'failed';
        carried = sent;
        continue;
      }
      const link = await pace(
        () =>
          sendLinkOnce({
            transport: deps.transport,
            to,
            channel: carried.channel,
            chatId: carried.chatId,
            url: part.url,
            database,
            familyId: input.familyId,
            parentUserId: input.parentUserId,
            now: input.now,
            fetch: deps.fetch,
          }),
        (sent) => sent.status !== 'not_sent',
      );
      if (link.status === 'not_sent') {
        console.warn(
          { offerId: input.offerId, kind: input.kind, why: link.why, code: link.code },
          'signup plan prep: the login link did not go',
        );
        return 'failed';
      }
      if (link.status === 'text') {
        console.info(
          { offerId: input.offerId, kind: input.kind, why: link.why },
          'signup plan prep: the login link went as a text, not a card',
        );
      }
      await markLoginLinkSent(database, {
        id: part.loginLinkId,
        familyId: input.familyId,
        now: input.now,
      });
    }
    return 'sent';
  };
}

/**
 * The row a text sends under. With a dedupe key, a bubble that already went (or is going)
 * is not sent again: its row comes back as `went`, with the chat it used. A bubble whose
 * try failed is claimed again and sent.
 */
async function claimPrepText(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    offerId: string;
    kind: PlanNoticeKind;
    dedupeKey: string | null;
  },
): Promise<
  | { claimed: true; id: string }
  | { claimed: false; went: { channel: 'sms' | 'imessage'; chatId: string | null } }
> {
  const messages = schema.channelMessages;
  const [row] = await database
    .insert(messages)
    .values({
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'reply',
      templateKey: `${PLAN_PREP_TEMPLATE}:${input.kind}`,
      dedupeKey: input.dedupeKey,
      status: 'queued',
      sentAt: null,
    })
    .onConflictDoNothing()
    .returning({ id: messages.id });
  if (row) return { claimed: true, id: row.id };
  if (input.dedupeKey === null) throw new Error('channel_messages insert returned no row');
  const [retried] = await database
    .update(messages)
    .set({ status: 'queued', errorCode: null })
    .where(
      and(
        eq(messages.dedupeKey, input.dedupeKey),
        eq(messages.familyId, input.familyId),
        eq(messages.status, 'failed'),
      ),
    )
    .returning({ id: messages.id });
  if (retried) return { claimed: true, id: retried.id };
  const [prior] = await database
    .select({ channel: messages.channel, chatId: messages.providerChatId, sentAt: messages.sentAt })
    .from(messages)
    .where(and(eq(messages.dedupeKey, input.dedupeKey), eq(messages.familyId, input.familyId)))
    .limit(1);
  if (!prior) throw new Error('channel_messages dedupe row not found');
  if (!prior.sentAt) {
    console.warn(
      { offerId: input.offerId, kind: input.kind, code: 'claimed_unconfirmed' },
      'signup plan prep: a bubble was claimed but never confirmed; not sending it again',
    );
  }
  return {
    claimed: false,
    went: { channel: prior.channel === 'imessage' ? 'imessage' : 'sms', chatId: prior.chatId },
  };
}

/** Wraps each send of one prep notice: the bubble gap before any after the first.
 * `went` says whether the result is a part that went. */
type PrepPace = <T>(send: () => Promise<T>, went: (result: T) => boolean) => Promise<T>;

async function sendPrepText(
  database: Database,
  transport: ChannelTransport,
  pace: PrepPace,
  input: {
    familyId: string;
    parentUserId: string;
    offerId: string;
    kind: PlanNoticeKind;
    to: string;
    body: string;
    dedupeKey: string | null;
    now: Date;
  },
): Promise<{ channel: 'sms' | 'imessage'; chatId: string | null } | null> {
  const messages = schema.channelMessages;
  const claim = await claimPrepText(database, input);
  if (!claim.claimed) return claim.went;
  const failed = async (code: string): Promise<null> => {
    await database
      .update(messages)
      .set({ status: 'failed', errorCode: code.slice(0, 80) })
      .where(and(eq(messages.id, claim.id), eq(messages.familyId, input.familyId)));
    console.warn(
      { offerId: input.offerId, kind: input.kind, code },
      'signup plan prep: a text did not go',
    );
    return null;
  };
  let delivered: Awaited<ReturnType<typeof deliverStamped>>;
  try {
    delivered = await pace(
      () =>
        deliverStamped(
          database,
          {
            familyId: input.familyId,
            parentUserId: input.parentUserId,
            offerIds: [input.offerId],
          },
          {
            familyId: input.familyId,
            body: input.body,
            to: input.to,
            legacy: transport,
            target: { channel: 'legacy' },
            shareGroupCap: false,
            now: input.now,
          },
        ),
      (sent) => !(sent instanceof AskOrderUnmarked) && sent.status === 'sent',
    );
  } catch (err) {
    return failed(err instanceof Error ? err.constructor.name : 'send_threw');
  }
  if (delivered instanceof AskOrderUnmarked) return failed(delivered.message);
  if (delivered.status !== 'sent') return failed(delivered.reason);
  await database
    .update(messages)
    .set({
      channel: delivered.channel,
      status: acceptedStatus(delivered.channel),
      providerMessageId: delivered.providerMessageId,
      providerChatId: delivered.chatId,
      sentAt: input.now,
    })
    .where(and(eq(messages.id, claim.id), eq(messages.familyId, input.familyId)));
  return { channel: delivered.channel, chatId: delivered.chatId };
}

/**
 * One notice text about its ask, as one call: the stamp (`askStamp`) right before the
 * transport call, and the number kept once the text went, so the parent's next bare answer
 * is this ask's even if a later part of the notice does not go. A send that could not be
 * marked is not made: its named failure comes back in place of the delivery.
 *
 * The stamp and the transport call are never apart: a paced notice hands this whole call
 * to the bubble gap, so the gap comes before the stamp, and a text another sender starts
 * during the gap ranks below this one, which the parent gets after it.
 */
async function deliverStamped(
  database: Database,
  asks: AskedAbout,
  outbound: Parameters<typeof deliverFamilyOutbound>[1],
): Promise<Awaited<ReturnType<typeof deliverFamilyOutbound>> | AskOrderUnmarked> {
  let keep: Awaited<ReturnType<SendStamp>>;
  try {
    keep = await askStamp(database, asks)();
  } catch (err) {
    if (err instanceof AskOrderUnmarked) return err;
    throw err;
  }
  const delivered = await deliverFamilyOutbound(database, outbound);
  if (delivered.status === 'sent') await keep();
  return delivered;
}

/** Login-ask, account-prep and 30-minute reminder on the same minute cron. */
export function signupPlanPrepDepsFromEnv(database: Database): PlanPrepDeps {
  return {
    writer: createProviderNoticeWriter(() => resolveReplyClient(undefined)),
    deliver: createPlanPrepDeliver(database, { transport: createOutboundTransport() }),
  };
}

/** Real wiring for the cron. The engine is a named absence without BROWSER_USE_API_KEY. */
export function signupPlanDepsFromEnv(database: Database): PlanRunDeps {
  const built = browserUseSignupRunnerFromEnv();
  const engine = built.deps;
  return {
    runner: engine
      ? {
          run: (input) => runBrowserUsePlanForMode(input, engine),
          release: (resume) => releasePlanRun(resume, engine),
          settlePayment: (input) => settleBrowserUsePlanPayment(input, engine),
        }
      : null,
    notifyParent: createPlanNotifier(database, {
      writer: createPlanReplyWriter(() => resolveReplyClient(undefined)),
      transport: createOutboundTransport(),
      now: () => new Date(),
    }),
  };
}
