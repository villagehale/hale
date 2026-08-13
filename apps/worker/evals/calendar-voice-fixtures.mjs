// VIL-249 · the two composed calendar surfaces — the corpus.
//
// Expectations come from the SKILLS (packages/agent/skills/calendar-email-ask.md and
// calendar-invite-note.md), never from what a model happened to write.
//
// CALIBRATED BOTH DIRECTIONS:
//
//   · The ASK must actually ASK — a message that never says "email", or that offers
//     without asking for anything, fails the deterministic gates. It must also survive
//     being told what it got wrong: two of the three ask fixtures are RETRY turns, the
//     shape the composer sends when a first draft breaks a gate, so "the model fixes a
//     named violation" is measured rather than assumed.
//
//   · The NOTE must REPRODUCE and never EXPAND. Every note fixture carries the summary
//     the recipient's own privacy dial produced, and the containment gate holds the
//     subject and the body to it verbatim. The teen fixture is the sharp end: the model
//     is handed "an appointment" and nothing else, so ANY concrete noun in the output
//     is invented — `forbiddenPatterns` catches exactly that class mechanically, which
//     is the redaction-containment check in its strongest form.
//
// `mustRecall` is asserted only where a string must appear by contract (the time, the
// summary). `watchFor` is fixture-specific context for the judge; the general bars live
// in the runner's two JUDGE_SYSTEMs.

/**
 * The line this feature shipped with before the no-preset-bodies doctrine (founder,
 * 2026-08-12). It is kept HERE, as a reference for the judge and for anyone reading
 * what the ask is supposed to accomplish — it is not copy any code can reach.
 */
export const REFERENCE_ASK =
  "Want this in your real calendar too? Text me your email and I'll send invites there from now on.";

export const ASK_FIXTURES = [
  {
    id: 'ask-blind',
    // The real first turn: the composer hands the model nothing at all.
    turn: {},
    watchFor:
      'The standing offer, cold. Must offer to put things in their real calendar by email AND ask them to text their address. No greeting, no pressure, no explanation of why it helps Hale.',
  },
  {
    id: 'ask-retry-link',
    turn: {
      original: {},
      yourLastAttempt: 'Want invites in your real calendar? Add your email at https://villagehale.com/settings',
      problems: ['the message carried a link; there is nothing to link to'],
      instruction: 'Write it again, fixing every problem listed. Same JSON shape.',
    },
    watchFor:
      'A retry. The link must be gone and the ask must now be to TEXT the address back, not to go anywhere. Same one-question shape.',
  },
  {
    id: 'ask-retry-two-questions',
    turn: {
      original: {},
      yourLastAttempt: "Want calendar invites by email? What's your address?",
      problems: ['the message had 2 question marks; it must ask exactly one'],
      instruction: 'Write it again, fixing every problem listed. Same JSON shape.',
    },
    watchFor:
      'A retry. Exactly one question mark, and the message must still both offer the invites and ask for the address.',
  },
];

export const NOTE_FIXTURES = [
  {
    id: 'note-named-child',
    context: {
      summary: 'Maya — Swim class',
      when: 'Thu, Jul 23 at 10:30 AM',
      method: 'added',
    },
    mustRecall: ['Maya — Swim class', 'Thu, Jul 23 at 10:30 AM'],
    watchFor:
      'Warm, two sentences at most, says the invite is attached and their calendar can add it. Must not invent a place, a duration, what to bring, or a second time.',
  },
  {
    id: 'note-teen-generic',
    context: {
      // The teen floor: the dial produced this and the model knows nothing more.
      summary: 'an appointment',
      when: 'Mon, Aug 3 at 4:15 PM',
      method: 'added',
    },
    mustRecall: ['an appointment', 'Mon, Aug 3 at 4:15 PM'],
    // Any concrete noun here is a guess about a 13+ child's private event (rule #1).
    forbiddenPatterns: [
      /\b(doctor|dentist|therapy|therapist|clinic|school|practice|lesson|class|game|checkup|check-up)\b/i,
    ],
    watchFor:
      'The event is deliberately vague — a teenager\'s. The note must stay exactly that vague: no guess at what kind of appointment it is, no "your child", no reassurance that implies knowledge of it.',
  },
  {
    id: 'note-relation-level',
    context: {
      summary: 'your daughter — Dentist',
      when: 'Fri, Sep 12 at 9:00 AM',
      method: 'added',
    },
    mustRecall: ['your daughter — Dentist', 'Fri, Sep 12 at 9:00 AM'],
    // The parent's dial says relation, not name. A first name here is a level breach.
    forbiddenPatterns: [/\b(Maya|Ada|Nora|Leo|Ben)\b/],
    watchFor:
      'The child is described by relation, not named, because that is this parent\'s setting. The note must reuse that phrasing exactly and never reach for a name.',
  },
  {
    id: 'note-cancelled',
    context: {
      summary: 'Maya — Swim class',
      when: 'Thu, Jul 23 at 10:30 AM',
      method: 'cancelled',
    },
    mustRecall: ['Maya — Swim class', 'Thu, Jul 23 at 10:30 AM'],
    watchFor:
      'A withdrawal. Matter-of-fact, never apologetic, and it must say the attachment takes it back off their calendar rather than adding anything.',
  },
];
