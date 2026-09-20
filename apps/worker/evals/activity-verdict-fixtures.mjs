// What a parent's reply to "how did it go?" amounts to — the fixtures for the
// activity-verdict skill (packages/agent/skills/activity-verdict.md).
//
// EVERY EXPECTATION HERE IS DERIVED FROM THE SPEC, never from what the model happened
// to produce. The skill says the ambiguous middle is `none`, that a question is `none`,
// that a tag may only be something the parent actually SAID, and that no name may leave
// the extractor; each of those rules has a fixture whose expected value was written by
// reading the rule, before any run.
//
// `verdict` is exact — it is the whole row, and a wrong one attributes a household's
// opinion to a venue. `tags` is asserted as an exact SET where the reply plainly states
// one, and as "must be empty" where it states none: a tag the parent did not say is the
// thing that travels to another family.

export const VERDICT_FIXTURES = [
  {
    id: 'plain-positive',
    why: 'The ordinary yes. If this misses, nothing else matters.',
    body: "She loved it, we'll definitely go back.",
    verdict: 'worth_it',
    tags: [],
  },
  {
    id: 'plain-negative',
    why: 'The ordinary no. It is never spoken to another family, but it must be READ, because a majority-negative subject is demoted rather than offered.',
    body: 'Honestly a waste of a morning. We won’t bother again.',
    verdict: 'not_worth_it',
    tags: [],
  },
  {
    id: 'ambiguous-middle',
    why: 'THE fixture that decides whether this feature is honest. "Fine" is a shrug, and reading one as worth_it puts a household behind an opinion it never gave.',
    body: 'It was fine.',
    verdict: 'none',
    tags: [],
  },
  {
    id: 'did-not-go',
    why: 'The only attendance signal this product can honestly obtain. It is stored and deliberately not counted as an opinion.',
    body: "We didn't end up going, she came down with something.",
    verdict: 'did_not_attend',
    tags: [],
  },
  {
    id: 'a-question-back',
    why: 'A parent asking something has told you nothing about how it went. Reading a question as an answer is how a pool fills with noise.',
    body: 'Is there one on Saturdays?',
    verdict: 'none',
    tags: [],
  },
  {
    id: 'names-a-child',
    why: "Rule #1: the verdict may be read, the name may never come out. The extractor is handed the body and returns a state — nothing that could carry a child's name has a field to live in.",
    body: 'Mia had the best time, she was still singing the songs in the car.',
    verdict: 'worth_it',
    tags: [],
    forbidInOutput: ['Mia', 'mia'],
  },
  {
    id: 'two-clauses',
    why: 'The shape most replies actually take: a verdict and one concrete complaint that is not about the activity.',
    body: 'Loved it, parking was a nightmare though.',
    verdict: 'worth_it',
    tags: ['hard_parking'],
  },
  {
    id: 'about-something-else',
    why: 'People change the subject. A reply about next week’s swim is not a review of last week’s storytime.',
    body: 'Can you move Thursday swim to Friday? Thursdays are getting tight.',
    verdict: 'none',
    tags: [],
  },
  {
    id: 'crowded-and-chaotic',
    why: 'Two tags at once, both stated outright, and a negative verdict that will only ever be used to rank.',
    body: 'Way too many kids crammed into that room and nobody seemed to know what was happening.',
    verdict: 'not_worth_it',
    tags: ['too_crowded', 'disorganised'],
  },
  {
    id: 'age-mismatch',
    why: 'The tag a parent states about their own child rather than the venue — it is about FIT, never about the child.',
    body: 'Bit too old for him really, he was bored within ten minutes.',
    verdict: 'not_worth_it',
    tags: ['wrong_age_fit'],
  },
  {
    id: 'long-reply',
    why: 'THE TRUNCATION FIXTURE. max_tokens bounds thinking AND text together on Sonnet 5, so a long body with an adaptive-thinking lane is where a clipped tool call would first appear — and a clipped call reads downstream as a model that found nothing.',
    body: "Okay so we made it in the end, we were about ten minutes late because the car park was completely rammed and I had to go round three times, but once we were in it was honestly lovely. The woman running it was so organised, she had everything laid out and she noticed straight away that Leo is a bit younger than the others and gave him his own corner with the soft blocks. He was in there a full hour which never happens. It's a bit more than I'd usually pay for 45 minutes but I think we'll keep going for the rest of the term.",
    verdict: 'worth_it',
    tags: ['hard_parking', 'well_run', 'pricey'],
  },
];
