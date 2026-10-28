import type { ReplyLanguage } from '~/lib/channel/language';
import {
  type ClashPerson,
  type ClashPlan,
  type GroupClash,
  clashTitleNorm,
  planRestsOn,
  planWhen,
  watchedPlan,
} from './group-conflict';

/**
 * VIL-444 (T24) — a pickup someone takes in the family group settles it.
 *
 * The model reads, by meaning and in any language, whether the sender just took one of the
 * family's coming pickups themselves or gave back one they had (skill
 * `group-pickup-claim-read`). No words are matched here or anywhere on this path. Code
 * offers only plans the clash planner already watches, so a private plan (a health item, a
 * teen's) is never offered, and a reading that names anything not offered changes nothing.
 * A claim is stored as the who-takes decision for that plan; the planner then never alerts
 * about it and holds the claimer busy then (group-conflict.ts).
 *
 * HOOK: PR #938 (VIL-442), the shared group reader. A claim belongs in that reader's
 * contract, read once per group turn alongside RSVPs and votes. #938 is not merged, so the
 * contract lives here, shaped like it (intent, refs, high or low confidence, null when the
 * read fails). When #938 lands:
 *   - in its group-plan-rsvp/reading.ts, `claim_pickup` and `drop_pickup` join
 *     GROUP_PLAN_RSVP_INTENTS, `pickups` ({@link PickupOffer}[]) joins
 *     GroupPlanRsvpReadInput, and `pickupRefs` its reading;
 *   - the rules in group-pickup-claim-read.md move into group-plan-rsvp-read.md;
 *   - the turn that reader already takes hands a claim reading to `takeGroupPickupClaim`
 *     through a {@link GroupPickupClaimReader} adapter, and the separate read in
 *     inbound.ts goes.
 */

export const GROUP_PICKUP_CLAIM_INTENTS = [
  'claim_pickup',
  'drop_pickup',
  'chatter',
  'unclear',
] as const;
export type GroupPickupClaimIntent = (typeof GROUP_PICKUP_CLAIM_INTENTS)[number];

/** One plan as the reader sees it. */
export interface PickupOffer {
  ref: string;
  title: string;
  day: string;
  start: string;
  end: string;
  /** Who has it now, or null when nobody has said. */
  has: string | null;
  /** Hale already told the group this one clashes. */
  inAlert: boolean;
  /** The person that alert asked to take it. */
  askedOf: string | null;
}

export interface GroupPickupClaimReadInput {
  text: string;
  senderName: string | null;
  pickups: readonly PickupOffer[];
  recent: readonly { from: 'hale' | 'member'; text: string }[];
}

export interface GroupPickupClaimReading {
  intent: GroupPickupClaimIntent;
  pickupRefs: string[];
  /** Low changes nothing. */
  confidence: 'high' | 'low';
}

export interface GroupPickupClaimReader {
  /** Null: the read failed after its retry, and nothing changes. */
  read(input: GroupPickupClaimReadInput): Promise<GroupPickupClaimReading | null>;
}

export interface PickupCandidate {
  offer: PickupOffer;
  plan: ClashPlan;
}

/** Enough for two busy weeks; the ones an alert named come first. */
export const PICKUP_OFFERS_MAX = 16;
export const GROUP_PICKUP_RECENT_LINES = 6;

/**
 * The plans a group message may take or give back: every plan the clash planner watches,
 * claimed ones included, the ones in an alert the group was sent first, then soonest.
 */
export function pickupCandidates(input: {
  plans: readonly ClashPlan[];
  /** Clashes the group was already sent. */
  sent: readonly GroupClash[];
  people: readonly ClashPerson[];
  now: Date;
  timeZone: string;
  language: ReplyLanguage;
}): PickupCandidate[] {
  const asked = new Map<string, string | null>();
  for (const clash of input.sent) {
    const pair = 'plan' in clash.second ? [clash.first, clash.second.plan] : [clash.first];
    for (const plan of pair) {
      const of = clash.suggested?.planKey === plan.key ? clash.suggested.personId : null;
      if (!asked.has(plan.key) || of !== null) asked.set(plan.key, of);
    }
  }
  const nameOf = (id: string | null): string | null =>
    (id ? input.people.find((person) => person.id === id)?.name : null) || null;
  return input.plans
    .filter((plan) => watchedPlan(plan, input.now))
    .sort(
      (a, b) =>
        Number(asked.has(b.key)) - Number(asked.has(a.key)) ||
        a.start.getTime() - b.start.getTime() ||
        a.key.localeCompare(b.key),
    )
    .slice(0, PICKUP_OFFERS_MAX)
    .map((plan, index) => ({
      plan,
      offer: {
        ref: `p${index + 1}`,
        title: plan.title,
        ...planWhen(plan, input.timeZone, input.language),
        has: nameOf(planRestsOn(plan)),
        inAlert: asked.has(plan.key),
        askedOf: nameOf(asked.get(plan.key) ?? null),
      },
    }));
}

/** The user-turn payload. Shared with the eval, which replays this request shape. */
export function groupPickupClaimUserMessage(input: GroupPickupClaimReadInput): string {
  return JSON.stringify({
    text: input.text,
    senderName: input.senderName,
    pickups: [...input.pickups],
    recent: input.recent.slice(-GROUP_PICKUP_RECENT_LINES),
  });
}

/** The reader's forced tool, shared with the eval so both ask the model the same thing. */
export const GROUP_PICKUP_CLAIM_TOOL = {
  name: 'group_pickup_claim',
  description: 'Return whether the sender took, or gave back, any of these pickups.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      intent: { type: 'string', enum: [...GROUP_PICKUP_CLAIM_INTENTS] },
      pickupRefs: { type: 'array', items: { type: 'string' } },
      confidence: { type: 'string', enum: ['high', 'low'] },
    },
    required: ['intent', 'pickupRefs', 'confidence'],
  },
} as const;

export const GROUP_PICKUP_CLAIM_MAX_TOKENS = 400;

/**
 * What a reading does, or null. Only a high-confidence claim or drop naming plans that were
 * offered does anything; one ref that was not offered and the whole reading is set aside.
 * So is a reading that would change a plan it did not name: plans with one title and start
 * share one stored decision, so taking one of two that differ only in their end takes both.
 */
export function pickupClaimAction(
  reading: GroupPickupClaimReading | null,
  candidates: readonly PickupCandidate[],
  /** Every plan the clash planner watches, offered or not. */
  watched: readonly ClashPlan[],
): { kind: 'claim' | 'drop'; plans: ClashPlan[] } | null {
  if (!reading || reading.confidence !== 'high') return null;
  if (reading.intent !== 'claim_pickup' && reading.intent !== 'drop_pickup') return null;
  const refs = [...new Set(reading.pickupRefs)];
  if (refs.length === 0) return null;
  const plans: ClashPlan[] = [];
  for (const ref of refs) {
    const found = candidates.find((candidate) => candidate.offer.ref === ref);
    if (!found) return null;
    plans.push(found.plan);
  }
  const decision = (plan: ClashPlan) => {
    const key = pickupDecisionKey(plan);
    return `${key.startIso}|${key.titleNorm}`;
  };
  const named = new Set(plans.map((plan) => plan.key));
  const decided = new Set(plans.map(decision));
  if (watched.some((plan) => !named.has(plan.key) && decided.has(decision(plan)))) return null;
  return { kind: reading.intent === 'claim_pickup' ? 'claim' : 'drop', plans };
}

/** The who-takes decision a claim is stored under, the same one the planner reads back. */
export function pickupDecisionKey(plan: Pick<ClashPlan, 'start' | 'title'>): {
  startIso: string;
  titleNorm: string;
} {
  return { startIso: plan.start.toISOString(), titleNorm: clashTitleNorm(plan.title) };
}
