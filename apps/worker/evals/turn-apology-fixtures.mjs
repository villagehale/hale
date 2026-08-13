// The turn apology — the corpus.
//
// This stage is BLIND and takes no facts: every draw sends the same one-key payload
// (`{"situation":"turn_failed_nothing_changed"}`). So the corpus is not a set of inputs,
// it is a set of DRAWS — the risk a composed sentence carries that a constant does not
// is variance, and the only way to measure variance is to sample.
//
// CALIBRATED BOTH DIRECTIONS:
//
//   · Every draw must be SENDABLE and must say both halves of the pinned meaning
//     (something broke on Hale's end; nothing was changed). A composer that drifts into
//     incident language, promises a fix time, or claims partial success fails.
//
//   · The draws must not all be the SAME SENTENCE. If they are, the founder paid a model
//     call for a constant — and the whole reason the constant was deleted was that every
//     parent who hit a bug twice read the same twelve words twice. `MIN_DISTINCT` is that
//     bar, and it is the one metric a "safe" degenerate skill fails.
//
// The last three fixtures carry a `rejected` attempt, which is the recompose loop's real
// contract: the model is handed its own refused body with the mechanical reasons and has
// to fix THOSE without breaking anything else.

/**
 * Out of the plain draws below, how many distinct sentences the corpus must contain.
 *
 * A composer that answers every failed turn identically is the deleted constant with a
 * latency budget and an API bill. The bar is set from what the skill actually does — the
 * recorded corpus draws 7 distinct out of 8 — with headroom for sampling, and it is a
 * REAL bar: an earlier draft of the skill that tightened the rules without inviting
 * variation collapsed to 3 (six identical draws) and would fail here.
 */
export const MIN_DISTINCT = 5;

const PLAIN_DRAWS = 8;

export const APOLOGY_FIXTURES = [
  ...Array.from({ length: PLAIN_DRAWS }, (_, i) => ({
    id: `draw-${i + 1}`,
    rejected: [],
    countsTowardVariance: true,
    watchFor:
      'One sentence. Must own the fault as Hale\'s AND say nothing was changed. No cause named (it does not know one), no fix time, no app, no question.',
  })),

  {
    id: 'recompose-two-sentences',
    rejected: [
      { apology: 'That broke on my end. Nothing was changed.', problems: ['not_one_sentence'] },
    ],
    watchFor:
      'The refused body said the right thing in two sentences. The fix is to join them into one, NOT to drop half the meaning — an apology that no longer says nothing was changed has traded one failure for a worse one.',
  },
  {
    id: 'recompose-question-and-number',
    rejected: [
      {
        apology: 'Sorry, that broke - want to try again in 5 minutes?',
        problems: ['carries_question', 'invented_number'],
      },
    ],
    watchFor:
      'Both problems must go: no question mark anywhere, and no digit. It must still say nothing was changed, which the refused body never did.',
  },
  {
    id: 'recompose-app-pointer',
    rejected: [
      {
        apology: 'Something went wrong - check the app at https://villagehale.com for your week.',
        problems: ['carries_link'],
      },
    ],
    watchFor:
      'The link is the flagged problem, and the app pointer behind it must go too - what broke was Hale\'s end, so the parent is owed Hale, not a second surface to go and check. NOTE: "your week", "your side" and "your end" are the family\'s own schedule and their own phone, not places to visit; those are correct and must not be read as redirects.',
  },
];
