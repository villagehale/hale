import type { Database } from '@hale/db';
import { registrationPlanRunEnabled } from './plan/flag';
import { type ConversablePlan, loadConversablePlans } from './plan/store';
import type { SignupRunResult } from './run';
import { type PendingSignupOffer, loadPendingOffers } from './store';

/** Where an ask stands among the parent's: what their message may do to it unnamed. */
export interface AskPlace {
  /** Their newest ask of any lane and status: a take-back or a no need not name it. */
  newest: boolean;
  /** Their newest ask of any lane still waiting on a yes: a bare yes binds it. */
  newestAsk: boolean;
}

/**
 * The live sign-up asks Hale made one parent, plan and one-shot in one ordering, newest
 * first. A plan ask is read by the plan lane (`runPlanAsk`), a one-shot ask by the consent
 * read; a message one ask's reader finds unrelated goes on to the next ask, whichever lane
 * it is in.
 */
export type LiveAsk = { offerId: string; createdAt: Date; place: AskPlace } & (
  | { lane: 'plan'; plan: ConversablePlan }
  | { lane: 'one_shot'; offer: PendingSignupOffer }
);

/**
 * Every ask a parent's message may answer: the family's asks Hale made THIS parent, each
 * with its place among them. An ask made the co-parent is theirs to answer: it never takes
 * this parent's yes, a take-back of theirs never reaches it, and a newer one never makes
 * this parent name their own ask. With the plan lane on, a plan is an offer whose open is
 * still ahead (or approved, or running; see `loadConversablePlans`) and every other pending
 * offer is a one-shot ask. With it off, every pending offer is one-shot.
 */
export async function loadLiveAsks(
  database: Database,
  input: { familyId: string; parentUserId: string; now: Date },
): Promise<LiveAsk[]> {
  const plans = registrationPlanRunEnabled() ? await loadConversablePlans(database, input) : [];
  const planIds = new Set(plans.map((plan) => plan.offerId));
  const oneShots = (await loadPendingOffers(database, input.familyId)).filter(
    (offer) => !planIds.has(offer.id),
  );
  const ordered = [
    ...plans
      .filter((plan) => plan.parentUserId === input.parentUserId)
      .map((plan) => ({
        lane: 'plan' as const,
        offerId: plan.offerId,
        createdAt: plan.createdAt,
        plan,
      })),
    ...oneShots
      .filter((offer) => offer.parentUserId === input.parentUserId)
      .map((offer) => ({
        lane: 'one_shot' as const,
        offerId: offer.id,
        createdAt: offer.createdAt,
        offer,
      })),
  ].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.offerId < b.offerId ? 1 : -1),
  );
  const newestAsk = ordered.findIndex(
    (ask) => ask.lane === 'one_shot' || ask.plan.status === 'pending',
  );
  return ordered.map(
    (ask, index): LiveAsk => ({
      ...ask,
      place: { newest: index === 0, newestAsk: index === newestAsk },
    }),
  );
}

/**
 * Why a turn stopped with nothing moved: a reading failed (`*_unread`), or it would move
 * an ask other than the parent's newest that their words do not name (`*_unnamed`).
 */
export type AskStop = 'plan_unread' | 'plan_unnamed' | 'signup_unread' | 'signup_unnamed';

/** Unclaimed, logged and named: the coach answers, and no later ask reads the message. */
export function stoppedTurn(
  outcome: AskStop,
  ask: { offerId: string; status: string },
): SignupRunResult {
  console.warn({ outcome, offerId: ask.offerId, status: ask.status }, 'signup asks: turn stopped');
  return { claimed: false, outcome, reply: null, deliverOnThread: false };
}
