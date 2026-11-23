import type { Database } from '@hale/db';
import { readParentLanguage } from '~/lib/channel/parent-language';
import { resolveReplyClient } from '~/lib/channel/reply-copy/client';
import { createOutboundTransport } from '~/lib/channel/outbound-transport';
import { pageOps } from '~/lib/monitoring/failure-page';
import { CHECKOUT_KEEP_ALIVE_SECONDS } from '../browser-use/keep-alive';
import type { BrowserUsePlanResult } from '../browser-use/plan-engine';
import { consumeLoginLink, mintTakeoverLink } from '../login-link/store';
import type { TakeoverPurpose } from '../takeover/purpose';
import { type TakeoverToken, parkPlanForTakeover } from '../takeover/store';
import { takeoverWindow } from '../takeover/window';
import { type PlanNoticePart, asBubbles, withLinkBubbles } from './bubbles';
import { childFirstName, parentTimeZone } from './conversation';
import { createPlanPrepDeliver } from './notice';
import { SIGNUP_TAKEOVER_NOTICE_SKILL, createProviderNoticeWriter } from './notice-writer';
import {
  type PlanPrepDeps,
  type PlanPrepFacts,
  type TakeoverNoticeFacts,
  firstChoiceLabel,
} from './prep';
import { type ClaimedPlan, planLapse, planTakenBack, writePlanAudit } from './store';
import { planOpensAtLocal } from './writer';

/**
 * VIL-718 · THE ONE TAKEOVER LINK, on the plan lane.
 *
 * A run that stops for a step only the parent can do keeps its browser. The parent gets one
 * model-written text and one Hale link (`/l/<code>`, single use, closing before the browser
 * does) that opens that browser on the site; Hale never shows a saved password and never
 * solves the step. The plan waits, still `submitting`, until the parent taps done (the next
 * sweep picks the same session back up) or the link runs out (the browser is let go, the
 * parent is told so in the model's words, and nothing retries).
 *
 * Every text here is the model's. When it writes nothing, nothing is sent and #ops is paged.
 */

/** A stopped run the parent can take over: its browser, live view and session are known. */
export type TakeoverStop = BrowserUsePlanResult & {
  liveViewUrl: string;
  sessionId: string;
  runId: string;
};

export function isTakeoverStop(result: BrowserUsePlanResult): result is TakeoverStop {
  return result.liveViewUrl !== null && result.sessionId !== null && result.runId !== null;
}

export type TakeoverOffer =
  /** The text and the link went; the plan waits on the parent. */
  | { status: 'parked'; token: TakeoverToken }
  /** Too little time left, or the plan was no longer this sweep's: the run ends as today. */
  | { status: 'not_offered'; why: 'no_window' | 'not_parked' }
  /** The parent took the plan back, or their yes lapsed: nothing was sent, the link is spent. */
  | { status: 'withdrawn'; why: 'taken_back' | 'lapsed' }
  /** The model wrote nothing: nothing was sent, #ops was paged. */
  | { status: 'unwritten' }
  /** Linq did not accept every part, though one may still have landed. The link is spent. */
  | { status: 'undelivered'; delivery: 'failed' | 'withheld' };

/** The takeover's writer and door, and the clock the time left on its link is counted from. */
export interface TakeoverDeps extends PlanPrepDeps {
  /** When the text goes. The sweep's `now` is when it began, often minutes before the stop. */
  now: () => Date;
}

/** The facts every takeover text shares. The session is the plan's first choice. */
async function baseFacts(
  database: Database,
  plan: ClaimedPlan,
  host: string,
): Promise<Omit<PlanPrepFacts, 'kind'>> {
  return {
    childFirstName: await childFirstName(database, {
      familyId: plan.familyId,
      childId: plan.childId,
    }),
    opensAt: planOpensAtLocal(plan.opensAt, await parentTimeZone(database, plan.parentUserId)),
    host,
    language: await readParentLanguage(database, {
      familyId: plan.familyId,
      parentUserId: plan.parentUserId,
    }),
    sessionLabel: firstChoiceLabel(plan.sessions, plan.choiceIds),
  };
}

/** Why this plan may no longer text its parent. The lapse's reason stays out of the result. */
async function yesGone(
  database: Database,
  plan: ClaimedPlan,
): Promise<'taken_back' | 'lapsed' | null> {
  if (await planTakenBack(database, plan)) return 'taken_back';
  return (await planLapse(database, plan)) ? 'lapsed' : null;
}

/**
 * Offers the takeover for one stopped run: the text first (nothing is minted for a text the
 * model could not write), then the card, then the plan parked on it, then the send. The yes
 * is read before the write and again right before the send, because the write can be slow.
 * Audit row `plan_takeover` when it went (rule #6): the step, the round, the minutes and the
 * host.
 */
export async function offerTakeover(
  database: Database,
  input: {
    plan: ClaimedPlan;
    stop: TakeoverStop;
    purpose: TakeoverPurpose;
    round: number;
    mode: 'auto' | 'assisted';
    host: string;
  },
  deps: TakeoverDeps,
): Promise<TakeoverOffer> {
  const { plan, stop, purpose } = input;
  const gone = await yesGone(database, plan);
  if (gone) return { status: 'withdrawn', why: gone };
  const now = deps.now();
  const window = takeoverWindow({
    now,
    browserEndsAt:
      stop.holdExpiresAt ?? new Date(now.getTime() + CHECKOUT_KEEP_ALIVE_SECONDS * 1000),
  });
  if (!window) return { status: 'not_offered', why: 'no_window' };
  const base = await baseFacts(database, plan, input.host);
  const sessionLabel = base.sessionLabel ?? null;
  const takeover: TakeoverNoticeFacts = {
    purpose,
    mode: input.mode,
    minutes: window.minutes,
    ended: null,
  };
  const draft = await deps.writer.write({
    ...base,
    kind: 'takeover',
    takeover,
    loginCard: { sessionLabel, opensAt: null, takeover: purpose },
  });
  const bubbles = draft ? asBubbles(draft.bubbles) : null;
  if (!draft || !bubbles) {
    const page = await pageOps(database, {
      site: 'takeover_unwritten',
      facts: { purpose, moment: 'ask' },
      ref: plan.offerId,
    });
    console.warn({ offerId: plan.offerId, purpose, page }, 'takeover: the text was not written');
    return { status: 'unwritten' };
  }
  const link = await mintTakeoverLink(database, {
    familyId: plan.familyId,
    parentUserId: plan.parentUserId,
    offerId: plan.offerId,
    providerHost: input.host,
    purpose: { kind: 'takeover', sessionLabel, opensAt: null, card: draft.card, takeover: purpose },
    expiresAt: window.expiresAt,
    browser: { browserId: stop.browserId, liveViewUrl: stop.liveViewUrl },
    now,
  });
  const token: TakeoverToken = {
    phase: 'takeover',
    runId: stop.runId,
    sessionId: stop.sessionId,
    browserId: stop.browserId,
    purpose,
    loginLinkId: link.id,
    expiresAt: window.expiresAt.toISOString(),
    round: input.round,
    doneAt: null,
    lapsedAt: null,
  };
  const parked = await parkPlanForTakeover(database, {
    offerId: plan.offerId,
    familyId: plan.familyId,
    token,
    now,
  });
  if (!parked) {
    await consumeLoginLink(database, { id: link.id, now });
    const refused = await yesGone(database, plan);
    return refused
      ? { status: 'withdrawn', why: refused }
      : { status: 'not_offered', why: 'not_parked' };
  }
  const goneAtSend = await yesGone(database, plan);
  if (goneAtSend) {
    await consumeLoginLink(database, { id: link.id, now });
    return { status: 'withdrawn', why: goneAtSend };
  }
  // A door that throws has not sent: the plan must not sit parked on a card nobody got.
  const delivered = await deps
    .deliver({
      familyId: plan.familyId,
      parentUserId: plan.parentUserId,
      offerId: plan.offerId,
      kind: 'takeover',
      noticeKey: `${plan.offerId}:takeover:${input.round}`,
      parts: withLinkBubbles(bubbles, link, 0),
      now,
    })
    .catch((err: unknown) => {
      console.warn(
        { offerId: plan.offerId, purpose, error: err instanceof Error ? err.name : 'unknown' },
        'takeover: the door threw',
      );
      return 'failed' as const;
    });
  if (delivered !== 'sent') {
    await consumeLoginLink(database, { id: link.id, now });
    console.warn({ offerId: plan.offerId, purpose, delivered }, 'takeover: the link did not go');
    return { status: 'undelivered', delivery: delivered };
  }
  await writePlanAudit(database, {
    familyId: plan.familyId,
    actor: plan.parentUserId,
    offerId: plan.offerId,
    after: {
      step: 'plan_takeover',
      purpose,
      round: input.round,
      minutes: window.minutes,
      host: input.host,
    },
  });
  return { status: 'parked', token };
}

/**
 * The honest close, in the model's words: the takeover ended without the step done, Hale
 * stopped and did not register, and the site's page follows for the parent to do it
 * themselves. Withheld when the plan was taken back or the parent's yes no longer stands, read
 * again after the write. Nothing written: nothing sent, #ops paged.
 */
export async function tellTakeoverUnfinished(
  database: Database,
  input: {
    plan: ClaimedPlan;
    purpose: TakeoverPurpose;
    ended: 'ran_out' | 'still_there' | 'again';
    mode: 'auto' | 'assisted';
    host: string;
    /** The registration page, already allowed. Null sends the text alone. */
    registrationUrl: string | null;
    now: Date;
  },
  deps: PlanPrepDeps,
): Promise<'sent' | 'failed' | 'withheld'> {
  const { plan, purpose } = input;
  if (await yesGone(database, plan)) return 'withheld';
  const draft = await deps.writer.write({
    ...(await baseFacts(database, plan, input.host)),
    kind: 'takeover_unfinished',
    takeover: { purpose, mode: input.mode, minutes: null, ended: input.ended },
    loginCard: null,
  });
  const bubbles = draft ? asBubbles(draft.bubbles) : null;
  if (!bubbles) {
    const page = await pageOps(database, {
      site: 'takeover_unwritten',
      facts: { purpose, moment: 'unfinished' },
      ref: plan.offerId,
    });
    console.warn({ offerId: plan.offerId, purpose, page }, 'takeover: the close was not written');
    return 'failed';
  }
  if (await yesGone(database, plan)) return 'withheld';
  const parts: PlanNoticePart[] = [
    ...bubbles.map((body): PlanNoticePart => ({ type: 'text', body })),
    ...(input.registrationUrl ? [{ type: 'text' as const, body: input.registrationUrl }] : []),
  ];
  return deps.deliver({
    familyId: plan.familyId,
    parentUserId: plan.parentUserId,
    offerId: plan.offerId,
    kind: 'takeover_unfinished',
    noticeKey: `${plan.offerId}:takeover_unfinished`,
    parts,
    now: input.now,
  });
}

/** Real wiring: the takeover skill's writer and the same 1:1 door as the plan notices. */
export function takeoverDepsFromEnv(database: Database): TakeoverDeps {
  return {
    writer: createProviderNoticeWriter(() => resolveReplyClient(undefined), {
      skill: SIGNUP_TAKEOVER_NOTICE_SKILL,
    }),
    deliver: createPlanPrepDeliver(database, { transport: createOutboundTransport() }),
    now: () => new Date(),
  };
}
