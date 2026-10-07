import { type Database, schema } from '@hale/db';
import { and, eq, isNull, ne, or, sql } from 'drizzle-orm';
import { acceptedStatus } from '~/lib/channel/ledger';
import { linqGroupCoparentEnabled } from '~/lib/channel/linq/config';
import { groupAudienceAllows } from '~/lib/channel/linq/group-audience';
import { LinqSendError, sendLinqChatMessage } from '~/lib/channel/linq/transport';
import type { PaidTier } from '~/lib/webhooks/stripe-billing';
import { checkoutPriceIdFromEnv } from '~/lib/webhooks/stripe-billing';
import { paymentLinkUrlForFamily } from './payment-link.js';
import type { StripeCheckoutClient } from './stripe-client.js';
import { stripeCheckoutClientFromEnv } from './stripe-client.js';
import { YEAR_RETENTION_COPY } from './upgrade-copy.js';

/**
 * ENG-1 — the later iMessage upgrade ask.
 *
 * Off unless IMESSAGE_UPGRADE_ASK is exactly `on`. Onboard and the first
 * utility reply stay free. A co-parent Linq group gets the ask when one
 * exists and its audience may hear `family_settings` (group-audience.ts: with
 * group onboarding v2 on, never). With no such group, Hale replies only in a thread the parent already
 * opened — it does not start a 1:1 to collect money. Yes sends a Payment
 * Link (or a Checkout Session URL). No leaves the free plan.
 */

/** Past the door. Intake and the web setup stages are still onboard. */
const PAST_THE_DOOR = new Set(['sms_active', 'observation_mode', 'drafts_mode', 'autonomous_mode']);

export type UpgradeOfferStatus = 'asked' | 'declined' | 'link_sent';

export type UpgradeAskSkipReason =
  | 'flag_off'
  | 'not_imessage'
  | 'onboard'
  | 'already_paid'
  | 'not_yet'
  | 'already_offered'
  | 'would_initiate_1_1'
  | 'not_configured';

export type UpgradeAskDecision =
  | { action: 'skip'; reason: UpgradeAskSkipReason }
  | { action: 'ask'; channel: 'group' | 'direct'; chatId: string };

export function imessageUpgradeAskEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return (env.IMESSAGE_UPGRADE_ASK ?? '').trim() === 'on';
}

/**
 * Where the ask may go, if it may go at all.
 *
 * `priorUtilityReplies` counts utility replies already on the ledger before
 * this turn's answer. Zero means this is still the first helpful reply.
 */
export function decideUpgradeAsk(input: {
  flagOn: boolean;
  channel: 'imessage' | 'sms' | 'email';
  parentChatId: string | null;
  onboardingStage: string;
  planTier: 'free' | 'plus' | 'family';
  priorUtilityReplies: number;
  offerStatus: UpgradeOfferStatus | null;
  groupChatId: string | null;
}): UpgradeAskDecision {
  if (!input.flagOn) return { action: 'skip', reason: 'flag_off' };
  if (input.channel !== 'imessage') return { action: 'skip', reason: 'not_imessage' };
  if (!PAST_THE_DOOR.has(input.onboardingStage)) return { action: 'skip', reason: 'onboard' };
  if (input.planTier !== 'free') return { action: 'skip', reason: 'already_paid' };
  if (input.offerStatus) return { action: 'skip', reason: 'already_offered' };
  if (input.priorUtilityReplies < 1) return { action: 'skip', reason: 'not_yet' };

  const groupChatId = input.groupChatId?.trim() || null;
  const parentChatId = input.parentChatId?.trim() || null;
  if (groupChatId) return { action: 'ask', channel: 'group', chatId: groupChatId };
  if (parentChatId) return { action: 'ask', channel: 'direct', chatId: parentChatId };
  return { action: 'skip', reason: 'would_initiate_1_1' };
}

/** The bubble a yes or no becomes. A missing url leaves the offer open. */
export function yearRetentionReply(input: {
  polarity: 'yes' | 'no';
  paymentUrl: string | null;
}): { reply: string; templateKey: string; nextStatus: UpgradeOfferStatus | 'asked' } {
  if (input.polarity === 'no') {
    return {
      reply: YEAR_RETENTION_COPY.declined,
      templateKey: 'linq:upgrade_declined',
      nextStatus: 'declined',
    };
  }
  if (!input.paymentUrl) {
    return {
      reply: YEAR_RETENTION_COPY.notReady,
      templateKey: 'linq:upgrade_pending',
      nextStatus: 'asked',
    };
  }
  return {
    reply: YEAR_RETENTION_COPY.link(input.paymentUrl),
    templateKey: 'linq:upgrade_link',
    nextStatus: 'link_sent',
  };
}

function upgradeTierFromEnv(env: Record<string, string | undefined>): PaidTier {
  return env.STRIPE_UPGRADE_TIER === 'family' ? 'family' : 'plus';
}

/**
 * Payment Link when STRIPE_PAYMENT_LINK_URL is set. Otherwise one annual
 * Checkout Session for the upgrade tier (plus, unless STRIPE_UPGRADE_TIER
 * is family). Null when neither can be built — named by the caller.
 */
export async function upgradePaymentUrl(
  familyId: string,
  env: Record<string, string | undefined> = process.env,
  client: StripeCheckoutClient | null = stripeCheckoutClientFromEnv(env),
): Promise<string | null> {
  const link = paymentLinkUrlForFamily(familyId, env.STRIPE_PAYMENT_LINK_URL);
  if (link) return link;
  const tier = upgradeTierFromEnv(env);
  const priceId = checkoutPriceIdFromEnv(tier, 'annual', env);
  const origin = env.APP_URL?.trim();
  if (!priceId || !client || !origin) return null;
  const session = await client.createCheckoutSession({
    priceId,
    familyId,
    tier,
    period: 'annual',
    successUrl: `${origin}/settings?checkout=success#billing`,
    cancelUrl: `${origin}/settings?checkout=cancelled#billing`,
  });
  return session.url;
}

type SendText = (input: {
  chatId: string;
  text: string;
}) => Promise<{ providerMessageId: string }>;

async function priorUtilityReplyCount(
  database: Database,
  familyId: string,
  excludeMessageId: string | null,
): Promise<number> {
  const rows = await database
    .select({ id: schema.channelMessages.id })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.familyId, familyId),
        eq(schema.channelMessages.direction, 'out'),
        eq(schema.channelMessages.category, 'reply'),
        excludeMessageId ? ne(schema.channelMessages.id, excludeMessageId) : undefined,
        or(
          isNull(schema.channelMessages.templateKey),
          sql`${schema.channelMessages.templateKey} NOT LIKE 'linq:upgrade%'`,
        ),
      ),
    )
    .limit(1);
  return rows.length;
}

/** The claimed group, only when everyone in it may hear about the plan. */
async function billingGroupChatId(
  database: Database,
  claimed: string | null,
): Promise<string | null> {
  const chatId = linqGroupCoparentEnabled() ? claimed?.trim() || null : null;
  if (!chatId) return null;
  const audience = await groupAudienceAllows(database, chatId, 'family_settings');
  return audience.allowed ? chatId : null;
}

/**
 * Follow a utility reply with the year-retention ask, once.
 *
 * Flag off returns before any read. A send that cannot leave because Linq
 * has no key returns `not_configured` and writes no offer.
 */
export async function maybeOfferYearRetention(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    parentChatId: string | null;
    channel: 'imessage' | 'sms' | 'email';
    templateKey: string | null;
    excludeMessageId: string | null;
    now: Date;
  },
  deps: { send?: SendText } = {},
): Promise<UpgradeAskDecision | { action: 'asked'; channel: 'group' | 'direct'; chatId: string }> {
  if (!imessageUpgradeAskEnabled()) return { action: 'skip', reason: 'flag_off' };
  if (input.templateKey?.startsWith('linq:upgrade')) {
    return { action: 'skip', reason: 'already_offered' };
  }

  const [family] = await database
    .select({
      planTier: schema.families.planTier,
      onboardingStage: schema.families.onboardingStage,
      linqGroupChatId: schema.families.linqGroupChatId,
    })
    .from(schema.families)
    .where(eq(schema.families.id, input.familyId))
    .limit(1);
  if (!family) return { action: 'skip', reason: 'onboard' };

  const [offer] = await database
    .select({ status: schema.familyUpgradeOffers.status })
    .from(schema.familyUpgradeOffers)
    .where(eq(schema.familyUpgradeOffers.familyId, input.familyId))
    .limit(1);

  const priorUtilityReplies = await priorUtilityReplyCount(
    database,
    input.familyId,
    input.excludeMessageId,
  );
  const groupChatId = await billingGroupChatId(database, family.linqGroupChatId);
  const decision = decideUpgradeAsk({
    flagOn: true,
    channel: input.channel,
    parentChatId: input.parentChatId,
    onboardingStage: family.onboardingStage,
    planTier: family.planTier,
    priorUtilityReplies,
    offerStatus: (offer?.status as UpgradeOfferStatus | undefined) ?? null,
    groupChatId,
  });
  if (decision.action === 'skip') return decision;

  const send = deps.send ?? ((message) => sendLinqChatMessage(message));
  let providerMessageId: string;
  try {
    const sent = await send({ chatId: decision.chatId, text: YEAR_RETENTION_COPY.ask });
    providerMessageId = sent.providerMessageId;
  } catch (err) {
    if (err instanceof LinqSendError && err.code === 'not_configured') {
      console.warn(
        { familyId: input.familyId },
        'year retention: linq not configured — ask not sent',
      );
      return { action: 'skip', reason: 'not_configured' };
    }
    throw err;
  }

  const inserted = await database
    .insert(schema.familyUpgradeOffers)
    .values({
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      chatId: decision.chatId,
      channel: decision.channel,
      status: 'asked',
      askedAt: input.now,
    })
    .onConflictDoNothing()
    .returning({ id: schema.familyUpgradeOffers.id });
  if (inserted.length === 0) return { action: 'skip', reason: 'already_offered' };

  const [row] = await database
    .insert(schema.channelMessages)
    .values({
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      channel: 'imessage',
      direction: 'out',
      category: 'reply',
      templateKey: 'linq:upgrade_ask',
      providerMessageId,
      providerChatId: decision.chatId,
      status: acceptedStatus('imessage'),
      sentAt: input.now,
    })
    .returning({ id: schema.channelMessages.id });

  await database.insert(schema.auditLog).values({
    familyId: input.familyId,
    actor: input.parentUserId,
    actionTaken: 'upgrade_ask_sent',
    targetTable: 'family_upgrade_offers',
    targetId: inserted[0]?.id,
    after: { channel: decision.channel, channelMessageId: row?.id ?? null },
  });

  return { action: 'asked', channel: decision.channel, chatId: decision.chatId };
}

/**
 * The open year-retention question, or null.
 *
 * Flag off hides the row, so a bare yes cannot bind to an ask Hale is not
 * allowed to make. A paid family is hidden for the same reason.
 */
export async function openYearRetentionQuestion(
  database: Database,
  input: { familyId: string },
): Promise<{ id: string; askedAt: Date } | null> {
  if (!imessageUpgradeAskEnabled()) return null;
  const [family] = await database
    .select({ planTier: schema.families.planTier })
    .from(schema.families)
    .where(eq(schema.families.id, input.familyId))
    .limit(1);
  if (!family || family.planTier !== 'free') return null;
  const [offer] = await database
    .select({
      id: schema.familyUpgradeOffers.id,
      askedAt: schema.familyUpgradeOffers.askedAt,
      status: schema.familyUpgradeOffers.status,
    })
    .from(schema.familyUpgradeOffers)
    .where(eq(schema.familyUpgradeOffers.familyId, input.familyId))
    .limit(1);
  if (!offer || offer.status !== 'asked') return null;
  return { id: offer.id, askedAt: offer.askedAt };
}

export type YearRetentionAnswer =
  | { claimed: false }
  | {
      claimed: true;
      reply: string;
      templateKey: string;
      outcome: string;
      afterSend?: (channelMessageId: string) => Promise<void>;
    };

/**
 * Turn a yes or no into the link, the decline, or "not ready".
 *
 * The offer stays `asked` when Stripe has no link to send, so a later yes
 * can still deliver one. The group hears the decision only when the answer
 * arrived somewhere else.
 */
export async function prepareYearRetentionAnswer(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    inboundChannelMessageId: string | null;
    now: Date;
    polarity: 'yes' | 'no';
  },
  deps: {
    paymentUrl?: (familyId: string) => Promise<string | null>;
    send?: SendText;
  } = {},
): Promise<YearRetentionAnswer> {
  if (!imessageUpgradeAskEnabled()) return { claimed: false };
  const [offer] = await database
    .select({
      id: schema.familyUpgradeOffers.id,
      status: schema.familyUpgradeOffers.status,
    })
    .from(schema.familyUpgradeOffers)
    .where(eq(schema.familyUpgradeOffers.familyId, input.familyId))
    .limit(1);
  if (!offer || offer.status !== 'asked') return { claimed: false };

  const [family] = await database
    .select({
      planTier: schema.families.planTier,
      linqGroupChatId: schema.families.linqGroupChatId,
    })
    .from(schema.families)
    .where(eq(schema.families.id, input.familyId))
    .limit(1);
  if (!family) return { claimed: false };

  if (input.polarity === 'yes' && family.planTier !== 'free') {
    return {
      claimed: true,
      reply: YEAR_RETENTION_COPY.alreadyPaid,
      templateKey: 'linq:upgrade_already_paid',
      outcome: 'already_paid',
      afterSend: () =>
        closeOffer(database, input, offer.id, 'link_sent', 'upgrade_already_paid', null),
    };
  }

  const paymentUrl =
    input.polarity === 'yes'
      ? await (deps.paymentUrl ?? ((familyId: string) => upgradePaymentUrl(familyId)))(
          input.familyId,
        )
      : null;
  const composed = yearRetentionReply({ polarity: input.polarity, paymentUrl });
  if (composed.nextStatus === 'asked') {
    return {
      claimed: true,
      reply: composed.reply,
      templateKey: composed.templateKey,
      outcome: 'not_configured',
    };
  }

  const syncText =
    composed.nextStatus === 'declined'
      ? YEAR_RETENTION_COPY.groupSyncNo
      : YEAR_RETENTION_COPY.groupSyncYes;
  return {
    claimed: true,
    reply: composed.reply,
    templateKey: composed.templateKey,
    outcome: composed.nextStatus,
    afterSend: () =>
      closeOffer(
        database,
        input,
        offer.id,
        composed.nextStatus === 'declined' ? 'declined' : 'link_sent',
        composed.nextStatus === 'declined' ? 'upgrade_declined' : 'upgrade_link_sent',
        {
          groupChatId: family.linqGroupChatId,
          syncText,
          send: deps.send,
        },
      ),
  };
}

async function closeOffer(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    inboundChannelMessageId: string | null;
    now: Date;
  },
  offerId: string,
  status: 'declined' | 'link_sent',
  actionTaken: 'upgrade_declined' | 'upgrade_link_sent' | 'upgrade_already_paid',
  sync: {
    groupChatId: string | null;
    syncText: string;
    send?: SendText;
  } | null,
): Promise<void> {
  await database
    .update(schema.familyUpgradeOffers)
    .set({
      status,
      answeredAt: input.now,
      linkSentAt: status === 'link_sent' ? input.now : null,
    })
    .where(
      and(
        eq(schema.familyUpgradeOffers.id, offerId),
        eq(schema.familyUpgradeOffers.status, 'asked'),
      ),
    );

  await database.insert(schema.auditLog).values({
    familyId: input.familyId,
    actor: input.parentUserId,
    actionTaken,
    targetTable: 'family_upgrade_offers',
    targetId: offerId,
    after: { status },
  });

  if (!sync) return;
  const groupChatId = await billingGroupChatId(database, sync.groupChatId);
  if (!groupChatId || !input.inboundChannelMessageId) return;

  const [inbound] = await database
    .select({ providerChatId: schema.channelMessages.providerChatId })
    .from(schema.channelMessages)
    .where(eq(schema.channelMessages.id, input.inboundChannelMessageId))
    .limit(1);
  const origin = inbound?.providerChatId ?? null;
  if (!origin || origin === groupChatId) return;

  const send = sync.send ?? ((message) => sendLinqChatMessage(message));
  try {
    const sent = await send({ chatId: groupChatId, text: sync.syncText });
    await database.insert(schema.channelMessages).values({
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      channel: 'imessage',
      direction: 'out',
      category: 'reply',
      templateKey: 'linq:upgrade_sync',
      providerMessageId: sent.providerMessageId,
      providerChatId: groupChatId,
      status: acceptedStatus('imessage'),
      sentAt: input.now,
    });
    await database.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: input.parentUserId,
      actionTaken: 'upgrade_decision_synced',
      targetTable: 'channel_messages',
      targetId: input.inboundChannelMessageId,
      after: { status },
    });
  } catch (err) {
    const code = err instanceof LinqSendError ? err.code : 'unknown';
    console.warn({ familyId: input.familyId, code }, 'year retention: group sync did not send');
  }
}
