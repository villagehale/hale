import { type PlaybookTopic, playbookFor } from '@hale/types';

/**
 * Full coaching plans — the vocabulary, and the two numbers the arc turns on.
 *
 * A parent asks a raising-kids question, Hale answers it AND offers the whole plan; a
 * YES delivers it; a few days later Hale asks how it went. Three surfaces separated by
 * days, and the only things that survive between them are a topic and a promised day.
 *
 * NO MESSAGE BODIES LIVE HERE. Every sentence a parent reads on this path is composed
 * per send and gated (the offer inside the coach turn, the plan, the too-young refusal,
 * the check-in). An earlier draft kept seven fixed check-in sentences and a fixed offer
 * line; both are gone. A preset body is a sentence nobody is writing for THIS family,
 * and the moment one exists it becomes the thing that ships when composition is hard —
 * which is exactly when a parent most needs a real answer.
 *
 * WHY THE TOPIC IS AN ENUM, still. It is persisted and it selects a curated PLAYBOOK
 * days later. A free-text topic would mean a plan grounded on whichever playbook a
 * fuzzy match happened to return.
 */

/**
 * The plannable subjects — exactly the topics with a verified method playbook.
 *
 * This is narrower than the coach's coaching remit on purpose. Hale still ANSWERS
 * questions about tantrums, screen time, picky eating and routines; it just does not
 * offer a week of instructions for them, because there is no named, studied method to
 * ground one in and the alternative is Opus improvising medical content per send. That
 * is the exact failure the playbooks exist to end, and it does not stop being a failure
 * because the topic is softer.
 */
export type PlanTopic = PlaybookTopic;

export const PLAN_TOPICS: readonly PlanTopic[] = ['sleep', 'potty', 'solids'];

/** Whether a persisted string is still a topic this build can plan for. A row written
 * by an older deploy — or naming a topic since retired — reads back as unknown rather
 * than as a default, because guessing sends a parent the wrong plan. */
export function isPlanTopic(value: string | null): value is PlanTopic {
  return value !== null && (PLAN_TOPICS as readonly string[]).includes(value);
}

/** How Hale names the topic mid-sentence. Used only in the ledger summary a founder
 * digest prints — never in anything sent to a parent. */
const PLAN_TOPIC_NOUN: Record<PlanTopic, string> = {
  sleep: 'sleep',
  potty: 'potty training',
  solids: 'starting solids',
};

/**
 * The ledger summary for an offer Hale is holding an answer for.
 *
 * Internal copy: the founder digest prints it and the coach's context recites it. It is
 * written to read correctly in an OVERDUE column too — an offer nobody answered in two
 * days is a loop left hanging, which is what "waiting on a yes" says.
 */
export function planOfferSummary(topic: PlanTopic): string {
  return `Offered the full ${PLAN_TOPIC_NOUN[topic]} plan - waiting on a yes.`;
}

/** The ledger summary for the promise the plan itself makes. Carries the METHOD name,
 * because that is what the check-in is asking about and what makes the row legible
 * three days later without opening the thread. */
export function planCheckInSummary(topic: PlanTopic): string {
  return `Check in on the ${playbookFor(topic).primaryMethod.name} plan.`;
}

/**
 * How many days out the check-in may be promised.
 *
 * The composer CHOOSES within this band and says the day out loud, because the right
 * gap is a property of the method: graduated check-ins show something by night three,
 * while the 3-day method wants day four — the morning after it finishes. A fixed +3
 * would land mid-method for one topic and late for another.
 *
 * The band is narrow on purpose. Under two days there is nothing to report; past five
 * the plan has stopped being the thing the family is doing.
 */
export const PLAN_CHECK_IN_DAY_CHOICES = [2, 3, 4, 5] as const;
export type PlanCheckInDays = (typeof PLAN_CHECK_IN_DAY_CHOICES)[number];

export function isPlanCheckInDays(value: number): value is PlanCheckInDays {
  return (PLAN_CHECK_IN_DAY_CHOICES as readonly number[]).includes(value);
}

/**
 * How long a bare YES still means "send the plan".
 *
 * Two days, because a bare affirmative has several possible owners and its claim on
 * this one has to expire: a parent typing "yes" a week after an unanswered offer is
 * answering something else, and sending them a sleep plan instead of reading what they
 * meant is worse than asking. Past this the handler declines and the turn falls through
 * to the coach, which can read the message properly.
 */
export const PLAN_OFFER_TTL_HOURS = 48;

/** The weekday name the plan promises, in the family's own clock. The prose and the
 * ledger row derive from the SAME chosen offset, so the day Hale said and the day it
 * comes back cannot disagree. */
export function checkInWeekday(now: Date, days: PlanCheckInDays, timeZone: string): string {
  return weekdayIn(new Date(now.getTime() + days * 24 * 3_600_000), timeZone);
}

/** The weekday an instant falls on, in the family's own clock — how the check-in names
 * the day it was promised for, reading it back off the row's own due time. */
export function weekdayIn(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, weekday: 'long' }).format(at);
}
