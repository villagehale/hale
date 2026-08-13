/**
 * Full coaching plans — the closed vocabulary, and every sentence built from it.
 *
 * A parent asks a raising-kids question, Hale answers it AND offers the whole plan; a
 * YES delivers it; three days later Hale asks how it went. Three surfaces, separated by
 * days, and the only thing that survives between them is a topic. This module is that
 * topic and nothing else.
 *
 * WHY AN ENUM AND NOT THE PARENT'S WORDS. The topic is chosen by a model (the
 * `offer_full_plan` tool) and then slotted into a message Hale sends UNPROMPTED three
 * days later. A free-text topic would be model-authored prose on an outbound template
 * with nobody in the loop — the one shape the reviewed-copy discipline exists to
 * prevent. A member of a seven-item union cannot be anything but one of seven reviewed
 * sentences, and it is a category rather than content, so it is safe to persist next to
 * a family id (rule #1).
 *
 * WHY THE CHECK-IN COPY IS A TABLE AND NOT ONE TEMPLATE WITH A NOUN SLOTTED. "How did
 * the first few <topic> go?" does not survive contact with English — nights, meals and
 * days are not interchangeable, and "how did the first few screen time go" is the kind
 * of sentence that tells a parent no one is home. Seven whole reviewed sentences cost
 * nothing and each one reads like a person wrote it.
 */

/**
 * The plannable subjects. Deliberately SMALL: each one has to be a thing a week of
 * concrete instructions can actually be written about, which is what rules out the
 * open-ended half of parenting ("is she behind?", "should we do daycare").
 *
 * Sleep is one topic, not three. Night wakeups, co-sleeping transitions and bedtime
 * resistance want the same plan shape — a night-by-night ladder — and splitting them
 * would make the model choose between labels for the same job while the parent's own
 * words, which say which of the three it is, are already in front of the composer.
 */
export type PlanTopic =
  | 'sleep'
  | 'solids'
  | 'potty'
  | 'picky_eating'
  | 'tantrums'
  | 'screen_time'
  | 'routines';

export const PLAN_TOPICS: readonly PlanTopic[] = [
  'sleep',
  'solids',
  'potty',
  'picky_eating',
  'tantrums',
  'screen_time',
  'routines',
];

/** Whether a persisted string is still a topic this build knows. A row written by an
 * older deploy — or by a topic since retired — reads back as unknown rather than as a
 * default, because guessing would send a parent the wrong plan's check-in. */
export function isPlanTopic(value: string | null): value is PlanTopic {
  return value !== null && (PLAN_TOPICS as readonly string[]).includes(value);
}

/** How Hale names the topic to a parent, in the middle of a sentence. Lower case
 * because every use site is mid-sentence. */
const PLAN_TOPIC_NOUN: Record<PlanTopic, string> = {
  sleep: 'sleep',
  solids: 'starting solids',
  potty: 'potty training',
  picky_eating: 'picky eating',
  tantrums: 'tantrums',
  screen_time: 'screen time',
  routines: 'routines',
};

/**
 * The ONE text the three-day check-in sends. Fixed, reviewed, whole sentences — no
 * model composes this, because there is nothing here worth a model's judgement and a
 * proactive message is the wrong place to spend one.
 *
 * Each is a question a parent can answer in a few words while walking. None of them
 * asks whether the plan "worked": a plan that did not work is the most useful thing
 * this message can surface, and a question phrased as a scorecard is one parents
 * answer with silence.
 */
const PLAN_CHECK_IN_TEXT: Record<PlanTopic, string> = {
  sleep: 'How did the first few nights go?',
  solids: 'How have the first few meals gone?',
  potty: 'How did the first few days go?',
  picky_eating: 'How have meals been going this week?',
  tantrums: 'How have the last few days been?',
  screen_time: 'How has the new screen time routine been going?',
  routines: 'How has the new routine been going?',
};

export function planCheckInText(topic: PlanTopic): string {
  return PLAN_CHECK_IN_TEXT[topic];
}

/**
 * The brief a plan is written from when the thread no longer holds the parent's own
 * question — a compacted or deleted conversation, days after the offer.
 *
 * Deliberately a WORSE brief rather than a refusal: the parent said yes, and a generic
 * plan for the right topic at the right age is worth having. The caller logs every use,
 * because a plan written from the category alone is a plan that could not be aimed.
 */
const PLAN_FALLBACK_QUESTION: Record<PlanTopic, string> = {
  sleep: 'How do I get my child sleeping better through the night?',
  solids: 'How do we start solid food?',
  potty: 'How do we start potty training?',
  picky_eating: 'What do we do about picky eating at meals?',
  tantrums: 'How should we handle tantrums?',
  screen_time: 'How much screen time, and how do we handle it?',
  routines: 'How do we build a routine that sticks?',
};

export function planFallbackQuestion(topic: PlanTopic): string {
  return PLAN_FALLBACK_QUESTION[topic];
}

/**
 * The ledger summary for an offer Hale is holding an answer for.
 *
 * This string is what the founder digest prints and what the coach's own context
 * recites back, so it is written to read correctly in an OVERDUE column too: an offer
 * nobody answered in two days is a loop left hanging, which is exactly what "waiting on
 * a yes" says.
 */
export function planOfferSummary(topic: PlanTopic): string {
  return `Offered the full ${PLAN_TOPIC_NOUN[topic]} plan - waiting on a yes.`;
}

/** The ledger summary for the promise the plan itself makes. */
export function planCheckInSummary(topic: PlanTopic): string {
  return `Check in on how the ${PLAN_TOPIC_NOUN[topic]} plan is going.`;
}

/**
 * The offer sentence itself — reviewed copy, appended by code, never composed.
 *
 * It started as a line the skill asked the model to write, and the eval caught why that
 * could not hold: a coaching answer plus this sentence runs past the two-segment budget,
 * and the post-processor trims from the END. Parents were getting "Want the full plan?"
 * with the half that says the magic word cut off — an offer with no way to accept it.
 *
 * Appending it here makes that unexpressible. The answer is fitted to the budget MINUS
 * this line, so the offer cannot be what gets dropped; whatever has to give is a clause
 * of background, which is the right thing to lose because the plan carries it anyway.
 */
export const PLAN_OFFER_LINE = "Want the full plan? Reply YES and I'll send it.";

/**
 * How long a bare YES still means "send the plan".
 *
 * Two days, because a bare affirmative is a word with several possible owners and its
 * claim on this one has to expire: a parent typing "yes" a week after an unanswered
 * offer is answering something else, and sending them a sleep plan instead of reading
 * what they meant is worse than asking. Past this the handler declines and the turn
 * falls through to the coach, which can read the message properly.
 */
export const PLAN_OFFER_TTL_HOURS = 48;

/** How long after the plan Hale comes back. Three days is one full weekend or one
 * working stretch — long enough that there is something to report, short enough that
 * the plan is still what the family is doing. */
export const PLAN_CHECK_IN_DAYS = 3;
