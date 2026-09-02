// The introduction ask — the corpus.
//
// Expectations come from the SPEC (packages/agent/skills/intro-voice.md and the refusals
// in apps/web/lib/village/intros/voice.ts), never from what the model happened to write.
// Nothing in this file was copied out of a live run: every `watchFor` restates something
// the skill already says, and every deterministic gate restates something the composer
// would itself refuse.
//
// WHAT THIS STAGE REPLACED, AND WHY THE CORPUS IS SHAPED LIKE THIS. Until 2026-08-13 both
// intro asks were fixed strings, and both ended by handing the parent a magic word to
// recite. The founder read them live: it is not how a person writes, and it is certainly
// not how a chief of staff writes. So the suite is not only "is this ask good" — it is
// "is this ask still a marketing blast wearing a model's clothes".
//
// CALIBRATED BOTH DIRECTIONS:
//
//   · Every fixture must produce a SENDABLE ask — everything introAskRefusals() refuses is
//     a hard zero. There is no preset underneath this stage (founder doctrine 2026-08-12):
//     three refusals and the composer defers, so the family hears nothing at all. An
//     unsendable ask is not a worse message, it is a missing one.
//   · Every fixture must also produce the RIGHT ask, which is the judge's bar: a competent
//     human raising something small, with a reason rather than a claim.
//   · The corpus must not collapse onto ONE sentence.
//   · No ask may come back as the RETIRED COPY, or as a near-miss of it.
//
// WHAT THE OPT-IN CORPUS IS AND IS NOT. There is exactly ONE optin request in the whole
// product — `{"kind":"optin"}`, no facts at all — so every family that ever reaches this
// question is composed from a byte-identical prompt. This corpus therefore holds one optin
// fixture, and the variation gate runs ONCE over both kinds together (see the runner): a
// corpus of one has nothing to be a near-duplicate of.
//
// That is a deliberate limit, recorded rather than hidden. The first live recording of this
// suite (2026-08-13) drew the same optin request three times to see what cross-family
// sameness looks like, and it looks like this: 0.81 trigram Dice between two of the three
// draws, and one shared opener across all three. Whether that matters is the distinction
// reminder-voice's header already draws — a parent gets several reminders a week, so
// repetition there is SEEN, while the optin is a once-ever surface where convergence is a
// doctrine problem rather than something any single parent can perceive. Gating three draws
// of one prompt would have made this suite fail on a property no family experiences, so it
// is not gated. What IS gated on that surface is the thing a family would notice: the
// retired copy coming back, and the judge's bar.

/**
 * THE TWO STRINGS THIS ARC DELETED, verbatim from the pre-arc
 * apps/web/lib/village/intros/copy.ts (`INTRO_DISCOVERABILITY_ASK`, and `coarseCard`
 * rendered with a 'toddler' counterpart and "Maya's" own child).
 *
 * They are FIXTURES NOW: the copy the composer replaced is the copy it must never write
 * again. `instructs_keyword` already catches the tail of each one mechanically, so this
 * array is aimed at the other half — the announcement grammar in front of it, which no
 * refusal can see. A composed ask that lands within `MAX_RETIRED_SIMILARITY` of either
 * string has not composed anything; it has remembered.
 */
export const RETIRED_COPY = [
  "Something new: other Hale families are near you. Want me to introduce you when there's a great match? Reply YES INTROS or NO INTROS.",
  "A Hale family near you has a toddler around Maya's age. Want an intro? Reply YES INTRO or NO INTRO.",
];

/**
 * Trigram-Dice ceiling against each retired string.
 *
 * Set deliberately low, and NOT free of tension: a proposal ask is REQUIRED to carry the
 * same handful of facts the retired card carried (a Hale family, the band word, the
 * recipient's child, the word "intro"), so shared texture is partly the spec's doing. The
 * calibration point is the body apps/web/lib/village/intros/voice.test.ts asserts is a
 * GOOD one — "Another Hale family nearby has a toddler about Maya's age. Want me to
 * introduce you?" — which measures 0.596 against the retired card, just inside this
 * ceiling. That is the line: copy that carries the pinned facts in its own grammar sits
 * under it, and copy that has merely filed the keyword sentence off the old string sits
 * well above it. It is a tight fit by construction and it is meant to be.
 */
export const MAX_RETIRED_SIMILARITY = 0.6;

/** The plain proposal request, reused so the recompose fixture retries the SAME match. */
const PLAIN_PROPOSAL = {
  kind: 'proposal',
  counterpartWord: 'toddler',
  ownChildPossessive: "Maya's",
  anchorTitle: null,
  anchorDay: null,
};

export const INTRO_VOICE_FIXTURES = [
  {
    id: 'optin',
    request: { kind: 'optin' },
    noProperNames: true,
    watchFor:
      'The first and only time Hale raises introductions unprompted, composed from NO facts at all: no name, no neighbourhood, no child, no count of families. It has to say there are other Hale families near them, that Hale can introduce them when there is a genuinely good match, that nothing about them is shared unless both families say yes, and that they can turn it off. The reassurance is the point - a parent\'s first reaction to "we can introduce you" is "what did you tell them". An announcement ("Something new", "Good news"), an exclamation mark, or a sentence telling them what to type back is the failure this stage exists to remove.',
  },

  // ── the proposal ───────────────────────────────────────────────────────────
  {
    /**
     * THE BARE MATCH. Its counterpart to `REDACTION-generic-possessive` is deliberate and
     * has to STAY deliberate: for one recording the two differed only in
     * `ownChildPossessive`, which made them the same message sent to two families, and the
     * pair gate duly scored them 0.95 and told nobody anything. Two fixtures that differ in
     * one word cannot measure whether a composer varies; they can only measure whether it
     * is deterministic. Every proposal in this corpus now differs in its band word and in
     * whether it has an anchor, so a high pair score means the model wrote one template for
     * genuinely different matches — which is the thing worth failing on.
     */
    id: 'proposal-plain',
    request: PLAIN_PROPOSAL,
    watchFor:
      'A match with NO activity behind it, which is the hardest one to write honestly: the only reason on offer is that a nearby family is raising a child at the same stage. Say that and stop. "A great match" is the product congratulating itself; overselling a bare age match is the failure here. It knows nothing else about the other family - not a name, not a street, not how far, not how many - so any of those is invented.',
  },
  {
    id: 'proposal-anchor-digits',
    request: {
      kind: 'proposal',
      counterpartWord: 'preschooler',
      ownChildPossessive: "Leo's",
      anchorTitle: 'Ready for Reading (Ages 3-6)',
      anchorDay: 'Saturday',
    },
    watchFor:
      'The activity is the whole reason this introduction is a good one, and its title is owned by the civic dataset: it must appear EXACTLY as given, digits, parentheses and all. A reworded title ("the reading group") is a fact Hale invented. The digits inside the title are the dataset\'s; any OTHER number - a time, a count of families, an age, a distance - is the model\'s own arithmetic and it has no source for it.',
  },
  {
    /**
     * THE REDACTED POSSESSIVE. "your kid's" is what `loopChildName` renders for a 13+
     * child, or for a parent who has dialled child_name_level down — the name was
     * withheld on purpose before the composer ever saw the request. The composer has
     * therefore never been told a name, so any proper noun it writes about this family is
     * one it made up, and a made-up name for a teenager is the rule #1 failure this
     * surface is most exposed to.
     */
    id: 'REDACTION-generic-possessive',
    request: {
      kind: 'proposal',
      counterpartWord: 'baby',
      ownChildPossessive: "your kid's",
      anchorTitle: 'Rhyme Time at Danforth Library',
      anchorDay: 'Tuesday',
    },
    noProperNames: true,
    watchFor:
      'The recipient\'s own child is generic on purpose - "your kid\'s" is a redaction decision already made upstream. Use it as given. Inventing a name, or guessing an age, a gender or a pronoun for either child, is fabricating a fact about a child. Do not soften the genericness into a guess. The activity title is a real listing and carries a place name; say it exactly and do not add anything about the place.',
  },
  {
    /**
     * THE THIRD BARE MATCH, and the oldest band in the corpus. It exists so the opener
     * floor is measured against three independently-composed un-anchored cards rather than
     * two: with only two, "three distinct openers" is satisfied by the optin differing from
     * the proposals, which is not the question anybody is asking. Its band word is the one
     * the retired card never used.
     */
    id: 'proposal-school-age',
    request: {
      kind: 'proposal',
      counterpartWord: 'kid',
      ownChildPossessive: "Ravi's",
      anchorTitle: null,
      anchorDay: null,
    },
    watchFor:
      'An older child, no activity behind the match, so the only reason on offer is that a nearby family is at the same stage. Say the ages match and whose child it is, offer the introduction, stop. Nothing about school, grade, class or friendship groups - none of that was handed over, and a guess about an older child is still a guess about a child.',
  },
  {
    /**
     * AN HONEST NOTE ON THIS FIXTURE'S RECORDING. Its first live draw (anchorDay
     * 'Wednesday', 2026-08-13) came back as "There's a local preschooler whose family is
     * also eyeing Forest School Drop-In this Wednesday. Hale can make an introduction if
     * you'd both like - nothing goes to them unless you say so. Worth connecting?" — with
     * no mention of the recipient's own child AND no mention of the two children being the
     * same age, which is the whole reason the introduction is a good one.
     * `own_child_missing` refused it; in production the composer would have been handed
     * that refusal and tried again. The day was changed and it was drawn again.
     *
     * So, plainly: this suite measures FIRST ATTEMPTS while the stage it measures gets
     * three, which makes it a stricter gate than production — and one of the two anchored
     * proposals here needed a second draw when the corpus was recorded. Worth knowing
     * before reading a future red run as a regression.
     */
    id: 'proposal-daughter-anchored',
    request: {
      kind: 'proposal',
      counterpartWord: 'preschooler',
      ownChildPossessive: "your daughter's",
      anchorTitle: 'Forest School Drop-In',
      anchorDay: 'Thursday',
    },
    noProperNames: true,
    watchFor:
      'A relationship possessive rather than a name, plus an activity coming up nearby that both families could go to. Use the possessive as given and name the activity verbatim. Never claim either family has shown interest in the activity, registered for it, or is attending - it is only a nearby upcoming session they could both drop into. The one fact about the other household is the band word - it must not acquire a name, a number, a distance or a personality, and "they sound lovely" is a claim about people Hale has never seen.',
  },
  {
    /**
     * THE RECOMPOSE, as a PROMPT property rather than a code one. The retry machinery is
     * proved deterministically in apps/web/lib/village/intros/voice.test.ts; what only a
     * real model can answer is whether being handed `instructs_keyword` produces an ask
     * that asks like a person, rather than the same sentence with the keyword filed off.
     *
     * The refused attempt is the DELETED CARD ITSELF, which is what a live regression
     * would actually look like: the composer wrote the old string, the gate caught it, and
     * this is the only turn left before the family hears nothing.
     *
     * Excluded from the variation corpus (`countsTowardVariance: false`): it is handed a
     * sentence to react to, so it is not an independent draw and its opener would be
     * measuring the fixture rather than the model.
     */
    id: 'recompose-instructed-keyword',
    request: PLAIN_PROPOSAL,
    rejected: [{ ask: RETIRED_COPY[1], problems: ['instructs_keyword'] }],
    countsTowardVariance: false,
    watchFor:
      "It was just told its last attempt handed the parent a keyword to recite. This one must ask the question the way a person asks a question, and must keep everything about the previous attempt that was fine - the nearby family, the band word, the recipient's own child, the offer. Rewording the old sentence while keeping its announcement grammar is not a fix.",
  },
  {
    /**
     * THE OTHER RECOMPOSE, and it is not a duplicate of the one above.
     *
     * The refused attempt here is not invented copy: it is what this stage's FIRST live
     * recording actually produced, six times out of six, before `third_person_self`
     * existed — "Hale can make an introduction". A composer that can be told
     * `instructs_keyword` and fix it has not been shown to fix a voice problem, which is a
     * subtler thing to be handed: the sentence is not malformed, it is spoken by the wrong
     * person. Everything else about the refused attempt is correct, so the retry has to
     * change the speaker and keep the rest.
     *
     * Excluded from the variation corpus for the same reason as its sibling: it was handed
     * a sentence to react to, so its opening is the fixture's rather than the model's.
     */
    id: 'recompose-third-person',
    request: PLAIN_PROPOSAL,
    rejected: [
      {
        ask: "There's a family nearby with a toddler around Maya's age. Hale can make an introduction if you're both up for it - nothing is shared until you each say so.",
        problems: ['third_person_self'],
      },
    ],
    countsTowardVariance: false,
    // The speaker rule is NOT restated here. It is in the rubric already, and a per-fixture
    // note that primes on "speaker" made the judge hunt for one: it scored a correct
    // first-person ask a 2 twice, once conceding mid-reason that the construction was "technically
    // about the other family". What is left is the thing only this fixture knows — that the
    // refused attempt was right about everything except who was speaking, so the retry has
    // something to preserve rather than merely something to avoid.
    watchFor:
      'Its last attempt was refused for one reason only, and everything else about it was right: the nearby family, the toddler, Maya, the offer, and the reassurance that nothing is shared. The retry has to keep all of that. Throwing the reassurance away, or dropping to a bare one-line offer, is a worse message than the one it replaced.',
  },
];
