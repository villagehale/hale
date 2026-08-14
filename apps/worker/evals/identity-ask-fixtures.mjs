// The identity ask — the corpus.
//
// Expectations come from the SPEC (packages/agent/skills/identity-ask.md), not from what
// the model happened to write. This stage has no fixed line underneath it: what it
// composes is what a parent reads, or nothing goes out. So the corpus is built around the
// two ways that fails.
//
// CALIBRATED BOTH DIRECTIONS:
//
//   · Every fixture must produce a SENDABLE ask — inside its budget, GSM-7, at most one
//     question, carrying the required word for every gap, no digit, no link, no example
//     address. A composer that writes beautifully but trips a gate sends nothing.
//
//   · Every fixture must also produce the RIGHT ask. The pinned meaning differs sharply by
//     reason, and the corpus covers both: a `getting_started` ask that re-thanks the parent
//     or re-confirms the consent is wrong (the sentence it is appended to already did
//     that), and an `introduction` ask that reads as a company collecting an address is
//     wrong even when every gate passes.
//
// THE TAIL BUDGET IS THE SHARP ONE. `getting_started` is APPENDED to the consent
// acknowledgment, so it has roughly seventy characters, not a hundred and sixty. It is the
// gate most likely to be tripped by an otherwise good sentence, and the fixture exists to
// keep the skill honest about how little room there is.
//
// `forbiddenPatterns` are the shapes only a WRONG ask can take. For the introduction
// reason they are the deterministic half of the privacy contract: the composer is handed a
// reason and a gap list and NOTHING about the other household, so any word about them is a
// word it invented.

/**
 * Words that describe the other family. The composer was handed nothing about them, so
 * every one of these is a fabrication about a household that consented to an introduction
 * and to nothing else (rule #1). "Introduction" itself is required, not forbidden — what
 * is out of bounds is characterising who is on the other end of it.
 */
const NAMES_THE_COUNTERPART =
  /\b(they have|their (kid|child|son|daughter|toddler|baby)|another (mum|mom|dad|parent)|nearby family|family near|down the street|in your (area|neighbourhood|neighborhood))\b/i;

/** A child fact. No child reaches this stage at all — the request carries a reason and a
 * gap list — so any of these is invented. */
const INVENTED_CHILD_FACT =
  /\b(daughter|son|teen|teenager|kiddo|toddler|baby|she|he|her|his|him)\b/i;

/**
 * The `getting_started` service clause, arriving in the WRONG message. Saying what Hale
 * watches and what it will answer is the whole point of the start-of-life tail; said to a
 * parent who has been a Hale family for months, days after they agreed to an
 * introduction, it is a company re-introducing itself instead of asking the one small
 * thing it needs.
 *
 * A forbidden pattern nothing can trip is a test that passes on garbage, so this one has
 * a positive control: the `getting_started` fixtures require exactly this content, judged
 * through the same run. If the clause ever stops being produced at all, those go red
 * before this one goes quietly green.
 */
const MISPLACED_CAPABILITY_PITCH =
  /\b(any parenting question|any question|watch(ing)? (the|your) dates|keep an eye on)\b/i;

export const IDENTITY_ASK_FIXTURES = [
  {
    /**
     * THE TIGHT ONE, and now the loaded one. Appended to "Done - you're covered. I only
     * text when something actually matters, and STOP always works." — so about seventy
     * characters, and the sentence in front of it has already confirmed everything.
     *
     * What it has to carry changed on 2026-08-13. "Covered" is the only word a brand-new
     * parent has for what they just switched on, and it tells them nothing: the founder
     * read the old tail as "I am confused what Hale can do, or how it is different from
     * ChatGPT". So the tail now also says what covered MEANS from here — Hale keeps
     * watching the dates on its own, and they can text it a question whenever they have
     * one. That is the whole difference, and it is stated without naming the thing it is
     * different from: Hale goes first.
     *
     * Seventy characters did not become eighty to make room. Both clauses and the ask fit
     * or the ask is refused and the parent is never asked their name at all.
     */
    id: 'start-name',
    request: { reason: 'getting_started', missing: ['name'] },
    watchFor:
      'The tail of a confirmation that has already been written. It must do TWO things inside roughly seventy characters: say what being covered means from here (Hale keeps watching this family\'s dates by itself, AND they can text a parenting question whenever they have one), and ask what name to use, containing the word "name". A bare name question is a failure now, however well it reads. Must NOT re-thank, re-confirm coverage, mention STOP, greet, or explain why Hale wants the name.',
    forbiddenPatterns: [/\bthank/i, /\bSTOP\b/, /covered/i, /^\s*(?:and|also)\b/i],
  },
  {
    id: 'intro-email',
    request: { reason: 'introduction', missing: ['email'] },
    watchFor:
      'The parent said yes to an introduction days ago and Hale cannot send it without an address. Must tie the ask to that introduction and use the word "email". Must not name, number or describe the other household, must not read as a company collecting an address, and must not pitch what Hale watches or answers - this family has known that for months.',
    forbiddenPatterns: [NAMES_THE_COUNTERPART, INVENTED_CHILD_FACT, MISPLACED_CAPABILITY_PITCH],
  },
  {
    id: 'intro-name',
    request: { reason: 'introduction', missing: ['name'] },
    watchFor:
      'Same moment, but what is missing is what to call them. Must contain "name" and tie to the introduction. The honest reason is that the introduction email has to greet them by name - saying so plainly is fine; inventing anything about the other family is not, and neither is a line about what Hale watches or answers.',
    forbiddenPatterns: [NAMES_THE_COUNTERPART, INVENTED_CHILD_FACT, MISPLACED_CAPABILITY_PITCH],
  },
  {
    /**
     * BOTH GAPS, ONE MESSAGE. The sweep sends exactly one ask per side however much is
     * missing, so this has to carry two requests inside one segment without becoming an
     * interrogation — at most one question mark, both required words present.
     */
    id: 'intro-both',
    request: { reason: 'introduction', missing: ['name', 'email'] },
    watchFor:
      'Two things missing, ONE message, one question mark at most. Both "name" and "email" must appear. A statement ending in an instruction is usually the better shape here than a compound question.',
    forbiddenPatterns: [NAMES_THE_COUNTERPART, INVENTED_CHILD_FACT, MISPLACED_CAPABILITY_PITCH],
  },
  {
    /**
     * The runtime recompose loop, as a PROMPT property rather than a code one. The
     * machinery is proved in apps/web/lib/channel/identity/ask-voice.test.ts; what only a
     * real model can answer is whether being told the word is missing produces a sentence
     * that contains it, rather than the same sentence reworded.
     */
    id: 'recompose-missing-word',
    request: { reason: 'getting_started', missing: ['name'] },
    rejected: [{ ask: 'What should I call you?', problems: ['name_word_missing'] }],
    watchFor:
      'It was just told its last attempt never used the word "name". This one must contain it, keep both halves of what happens from here (Hale watches the dates by itself, they can text a question anytime), stay inside the tail budget, and not have become stiff or formal in the process. Losing the service clause to make room for the word is the failure to watch for.',
    forbiddenPatterns: [/\bthank/i, /^\s*(?:and|also)\b/i],
  },
  {
    /**
     * The over-budget recompose. The commonest real failure on the tight fixture is a
     * sentence that is good and thirty characters too long, and what matters is whether
     * being told so produces a SHORTER one rather than a differently-worded long one.
     */
    id: 'recompose-too-long',
    request: { reason: 'introduction', missing: ['name', 'email'] },
    rejected: [
      {
        ask: "Before I can write that introduction I need to know what name you'd like me to use for you, and an email address I can send it to - text both back whenever you get a minute and I will take it from there.",
        problems: ['over_char_cap'],
      },
    ],
    watchFor:
      'It was just told its last attempt was too long. This one must fit one segment while keeping both required words and the tie to the introduction - shortened, not re-padded.',
    forbiddenPatterns: [NAMES_THE_COUNTERPART, MISPLACED_CAPABILITY_PITCH],
  },
];
