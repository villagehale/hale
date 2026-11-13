import type { Database } from '@hale/db';
import { namesFacts } from './parent-quote';
import { registrationPlanRunEnabled } from './plan/flag';
import { untrustedActivityLabel } from './plan/reader';
import { type ConversablePlan, loadConversablePlans } from './plan/store';
import type { SignupRunResult } from './run';
import {
  type AskOrder,
  type PendingSignupOffer,
  byAskedLast,
  loadLastAskedOfferId,
  loadPendingOffers,
} from './store';

/** Where an ask stands among the parent's: what their message may do to it. */
export interface AskPlace {
  /**
   * Hale's text about it reached this parent last, of all their asks in any status (the
   * offer, or a question back, notice or receipt about it since). Only this ask is approved,
   * taken back or picked for. An ask none of whose texts is known to have reached them is
   * never it. Words that name another of the parent's asks only make Hale ask about that one;
   * once that question went out, it is the newest, and their next answer is its.
   */
  newest: boolean;
}

/**
 * What Hale asks about a named ask it did not ask last, as a fact for that ask's own writer,
 * which asks it in its own words. The readers never see Hale's question, so a yes or no
 * question is put so that yes means go ahead and no means take it back.
 */
export const PLAN_ASK_BACK_QUESTION = 'Do you want Hale to register for this at the open?';
export const SIGNUP_ASK_BACK_QUESTION = 'Do you want Hale to sign up for this?';
/** A plan whose site options did not match is asked for the pick itself. */
export const PICK_ASK_BACK_QUESTION =
  "Which of the site's options do you want for this, or should Hale join the waitlist or email the provider?";

/**
 * The live sign-up asks Hale made one parent, plan and one-shot in one ordering (`AskOrder`):
 * the one whose text reached them last first (the offer, or Hale's last text about it since,
 * such as a question back), then asks none of whose texts is known to have reached them. A
 * bare yes or no answers only the ask whose text reached them last. A plan ask is read by
 * the plan lane (`runPlanAsk`), a one-shot ask by the consent read; a message one ask's
 * reader finds unrelated goes on to the next ask, whichever lane it is in.
 */
export type LiveAsk = { offerId: string; place: AskPlace } & (
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
  const lastAsked = await loadLastAskedOfferId(database, input);
  const asks: LiveAsk[] = [
    ...plans
      .filter((plan) => plan.parentUserId === input.parentUserId)
      .map(
        (plan): LiveAsk => ({
          lane: 'plan',
          offerId: plan.offerId,
          plan,
          place: { newest: plan.offerId === lastAsked },
        }),
      ),
    ...oneShots
      .filter((offer) => offer.parentUserId === input.parentUserId)
      .map(
        (offer): LiveAsk => ({
          lane: 'one_shot',
          offerId: offer.id,
          offer,
          place: { newest: offer.id === lastAsked },
        }),
      ),
  ];
  return asks.sort((a, b) => byAskedLast(askOrder(a), askOrder(b)));
}

function askOrder(ask: LiveAsk): AskOrder {
  return ask.lane === 'plan' ? ask.plan : ask.offer;
}

/** The parent's words name this ask: a whole word of its program's name or of its site. */
export function wordsNameAsk(text: string, ask: LiveAsk): boolean {
  const { activityLabel, providerHost } = ask.lane === 'plan' ? ask.plan : ask.offer;
  return namesFacts(text, { activity: untrustedActivityLabel(activityLabel), host: providerHost });
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
