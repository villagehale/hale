import { type Database, schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import { acceptedStatus } from '~/lib/channel/ledger';
import { deliverFamilyOutbound } from '~/lib/channel/linq/family-outbound';
import { createOutboundTransport } from '~/lib/channel/outbound-transport';
import { readParentLanguage } from '~/lib/channel/parent-language';
import { resolveReplyClient } from '~/lib/channel/reply-copy/client';
import { threadProactiveMessage } from '~/lib/channel/thread';
import { resolveSendablePhone } from '~/lib/channels/sms-consent-core';
import { runBrowserUsePlanForMode } from '../browser-use/assisted-engine';
import { liveViewUrl } from '../browser-use/live-view';
import { releasePlanRun, settleBrowserUsePlanPayment } from '../browser-use/plan-engine';
import { browserUseSignupRunnerFromEnv } from '../browser-use/runner';
import { childFirstName, parentTimeZone, replySessions } from './conversation';
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
  let delivered: Awaited<ReturnType<typeof deliverFamilyOutbound>>;
  try {
    delivered = await deliverFamilyOutbound(database, {
      familyId: notice.familyId,
      body: input.body,
      to: input.to,
      legacy: deps.transport,
      target: { channel: 'legacy' },
      shareGroupCap: false,
      now: input.now,
    });
  } catch (err) {
    return failed(err instanceof Error ? err.constructor.name : 'send_threw');
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
