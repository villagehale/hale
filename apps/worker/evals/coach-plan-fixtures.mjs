/**
 * The corpus for the full-plan composer — five real raising-kids questions a parent
 * already said YES to.
 *
 * These are not the coach-channel fixtures with more room. The coach-channel eval grades
 * the ANSWER: two sentences, the thing to try, the offer. This one grades what a parent
 * gets after they ask for the whole thing, and the property under test is the one the
 * two-sentence budget made impossible — SEQUENCE. Night by night, week by week, what to
 * expect, when to change course.
 *
 * Every fixture is a question the coach would plausibly have offered a plan for, at an
 * age where the plan is genuinely different from the plan one year either side of it.
 * That is deliberate: an eval whose fixtures are all toddlers cannot tell an age-grounded
 * plan from a generic one wearing an age.
 *
 * `expect` is a set of PROPERTIES, not a reference answer — there is no one right sleep
 * plan, and a fixture that pinned one would be grading the model's agreement with
 * whoever wrote the fixture:
 *
 *   mustMention   tokens the plan must carry, derived from the QUESTION's own facts —
 *                 the thing the parent actually asked about, not a phrase we like.
 *   forbidden     tokens that would mean the plan answered a different question, or
 *                 crossed a line the skill draws.
 *   watchFor      fixture-specific notes handed to the judge: what right and wrong look
 *                 like for THIS question, so the rubric is not judged in the abstract.
 *
 * The structural gates (sequence, budget, GSM-7, no dosing, no siren) are corpus-wide
 * and live in the runner, because none of them is a property of one question.
 *
 * PII stays out (rule #1): no real child, no real family, no area finer than a city.
 */

/** Hedges that mean the plan declined to be a plan. */
const HEDGES = [
  'every child is different',
  'consult your',
  'speak to your',
  'talk to your doctor',
  'it depends',
  'there is no one right',
];

/** A siren has no place on a guidance topic — the parent asked how to do a thing.
 * Gated corpus-wide in the runner too; named here so a fixture can say why. */
const HEALTH_LINE = ['811', '911'];

export const COACH_PLAN_FIXTURES = [
  {
    id: 'solids-6mo',
    topic: 'solids',
    question: 'When should he start solid food and how do we actually do it',
    child: { ageMonths: 6, stage: 'newborn' },
    note: "The founder's own text, one step further on. At 6 months this is a WEEK-BY-WEEK plan with textures and counts, and it is completely different from the same question at 9 months - which is what makes it a real test of whether the age grounding is doing anything.",
    expect: {
      mustMention: ['week'],
      // A plan that spends its length on readiness signs has answered "is he ready",
      // which is the question the two-sentence answer already covered.
      forbidden: [...HEDGES, ...HEALTH_LINE],
      watchFor:
        'A 6-month-old starting solids. Right: a first week of one food at one sitting, a specific texture, what a refusal looks like and that it is normal, then how the second and third weeks widen. Wrong: a list of "signs of readiness" (the parent has moved past that), any amount in millilitres or grams presented as a dose, or a plan that would read identically for a 9-month-old.',
    },
  },
  {
    id: 'cosleep-2yo',
    topic: 'sleep',
    question: 'we want to get her out of our bed and into her own room, shes 2',
    child: { ageMonths: 25, stage: 'toddler' },
    note: 'A transition, not a technique question. The plan has to be a LADDER with a first night and a last one, and it has to survive the second night getting worse - the point at which most families abandon it.',
    expect: {
      mustMention: ['night'],
      forbidden: [...HEDGES, ...HEALTH_LINE],
      watchFor:
        'Moving a 2-year-old out of the parents\' bed. Right: a staged retreat with named nights, a concrete starting position, and an explicit warning that night two or three is usually the hardest so a bad night is not the signal to stop. Wrong: "be consistent" as the whole plan, no named nights, or an endpoint the parent cannot tell they have reached.',
    },
  },
  {
    id: 'potty-2point5',
    topic: 'potty',
    question: 'how do we start potty training, she just turned 2 and a half',
    child: { ageMonths: 30, stage: 'toddler' },
    note: 'The topic that runs on DAYS, not nights or weeks. If the composer labels every plan in nights it is pattern-matching a template rather than reading the topic, and this fixture is what catches that.',
    expect: {
      mustMention: ['day'],
      forbidden: [...HEDGES, ...HEALTH_LINE],
      watchFor:
        'Starting potty training at 2.5. Right: a day-by-day start with a specific cadence (how often to offer), what accidents mean and that they are expected, and a named point at which to pause and try again later. Wrong: nights instead of days as the unit, shaming language about accidents, or a plan with no way to tell it is not working.',
    },
  },
  {
    id: 'night-wakeups-18mo',
    topic: 'sleep',
    question: 'he wakes up at 3am every single night and wont go back down',
    child: { ageMonths: 18, stage: 'toddler' },
    note: "The residual the skill audit left open (coach-channel scored 2-3 here: named what was common, gave no concrete step). It is the same question with the budget removed, so if the arc's whole premise is right this is where it shows.",
    expect: {
      // The plan must be about the 3am waking, not sleep in general.
      mustMention: ['night'],
      forbidden: [...HEDGES, ...HEALTH_LINE],
      watchFor:
        'A specific, repeated 3am waking at 18 months. Right: a plan aimed at THAT waking - what to do at 3am tonight, with a wait interval that changes across named nights, and what a normal response curve looks like over a week. Wrong: a general sleep-hygiene lecture, bedtime-routine advice that never reaches 3am, or naming what is common without saying what to do.',
    },
  },
  {
    id: 'picky-eater-4yo',
    topic: 'picky_eating',
    question: 'she wont eat anything but pasta and crackers, im losing my mind',
    child: { ageMonths: 52, stage: 'preschool' },
    note: 'The topic with no clean unit and a distressed parent in the question. It tests two things at once: whether the composer can still find a sequence where the topic does not hand it one, and whether the voice stays warm when the message is long.',
    expect: {
      mustMention: ['week'],
      forbidden: [...HEDGES, ...HEALTH_LINE],
      watchFor:
        'A 4-year-old eating two foods, and a parent at the end of their rope. Right: a weekly sequence built on serving alongside rather than instead, something concrete to do at the next meal, an explicit expectation that it takes many exposures, and warmth about how grinding it is. Wrong: clinical register, pressure tactics, calorie or nutrient targets, or a plan that promises she will be eating vegetables by a stated date.',
    },
  },
];
