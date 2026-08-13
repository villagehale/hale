// The follow-up ask — the corpus.
//
// Expectations come from the SPEC (packages/agent/skills/followup-voice.md), not from
// what the model happened to write. This stage has no fixed line underneath it: what the
// model composes is what a parent reads, or nothing goes out at all. So the corpus is
// built around the two ways that fails.
//
// CALIBRATED BOTH DIRECTIONS:
//
//   · Every fixture must produce a SENDABLE ask — inside one segment, GSM-7, exactly one
//     question, naming the activity verbatim, inventing no number. A composer that
//     writes beautifully but trips a gate sends the family nothing.
//
//   · Every fixture must also produce the RIGHT ask. The pinned meaning is one warm
//     question about how the named thing went, with the pressure taken off, and nothing
//     else — so a fixture that reads well while offering to book the next session, or
//     assuming the family went and had a lovely time, fails the judge.
//
// `forbiddenPatterns` are the shapes only a WRONG ask can take, and they are the
// deterministic half of the privacy contract: the composer is handed a title and nothing
// else, so any word about a child in the output is a word it invented.
//
// Kept to exactly that one shape, deliberately. The first draft also tried to police the
// WORDING of the intro ask — a pattern meant to allow "the other family" and refuse any
// other use of the word — and it failed the model's best output on the corpus's first
// live run for saying precisely what the skill asks it to say. A deterministic gate earns
// its place by catching a fabrication, not by second-guessing a phrasing the judge is
// there to score.

/**
 * Gender, age and relationship words. The composer is handed a title and nothing else, so
 * every one of these is a fact about a child it made up — the one class of invention this
 * product cannot ship (rule #1). Gender-neutral reference is not here: "did you connect
 * with them" invents nothing.
 */
const INVENTED_CHILD_FACT = /\b(daughter|son|teen|teenager|kid|kiddo|child|she|he|her|his|him)\b/i;

export const FOLLOWUP_VOICE_FIXTURES = [
  {
    id: 'activity-swim',
    request: { kind: 'activity', activity: 'Swim class' },
    watchFor:
      'The plainest case. One warm question about how Swim class went, with the pressure taken off. Must not assume they went or that it went well.',
  },
  {
    id: 'activity-long-title',
    request: { kind: 'activity', activity: 'Saturday Storytime at Riverdale Library' },
    watchFor:
      'A long title eats most of the 160-character budget. The ask has to stay one sentence and still carry the no-pressure note, or drop the note rather than run over.',
  },
  {
    id: 'activity-numeric-title',
    request: { kind: 'activity', activity: 'Gym 2 Grow' },
    watchFor:
      'The number belongs to the venue name. Copying it through is correct; adding any OTHER number (a time, a date, a count) is invention.',
  },
  {
    /**
     * THE REDACTION-ADJACENT CASE. A teen's or health item never reaches this stage at
     * all — the sweep drops it — so what is tested here is the softer failure: a title
     * that happens to carry a child's name. The composer sees the string "Ari" and knows
     * nothing else, so any age, pronoun or relationship it writes is fabricated, and a
     * fabricated one about a CHILD is the one this product cannot ship.
     */
    id: 'activity-named-child',
    request: { kind: 'activity', activity: 'Ari swim meet' },
    watchFor:
      'The title carries what looks like a child name. Echo the title and say nothing else about the child - no age, no pronoun, no "your daughter", no guess at whether they competed or how they placed.',
    forbiddenPatterns: [INVENTED_CHILD_FACT],
  },
  {
    id: 'intro',
    request: { kind: 'intro' },
    watchFor:
      'Whether they ended up connecting with the other family. Must never name, number or describe the other household - it was handed no fact about them at all. "No pressure either way" matters most here: the honest answer is often that nothing came of it.',
    forbiddenPatterns: [INVENTED_CHILD_FACT],
  },
  {
    /**
     * The runtime recompose loop, as a PROMPT property rather than a code one. The
     * machinery is proved in apps/web/lib/channel/followup/voice.test.ts; what only a
     * real model can answer is whether being told "not_one_question" actually produces
     * one question next time, rather than the same text reworded.
     */
    id: 'recompose-two-questions',
    request: { kind: 'activity', activity: 'Swim class' },
    rejected: [
      { ask: 'How was Swim class? Are you going back next week?', problems: ['not_one_question'] },
    ],
    watchFor:
      'It was just told its last attempt had two questions. This one must have exactly one, and must not have thrown away the warmth to get there.',
  },
];
