// VIL-229 · the reminder voice — the corpus.
//
// The reminder is the most GLANCEABLE thing Hale sends: an email a parent reads on a
// lock screen while doing something else, whose deterministic shell already renders the
// event and the time in large type. The model writes ONE line around that, and the line
// is the only part of the message a person composed.
//
// Each fixture is the exact `reminderVoiceContext` shape the production composer builds
// (apps/web/lib/loop/voice/reminder-voice.ts) — every event ALREADY REDACTED to the
// string the email will show, plus the already-resolved local clock time. That is the
// whole grounding set: rule #1 means the model never sees a child's name the email would
// not, never sees a date of birth, and never sees what a teen's "an appointment"
// actually is.
//
// CALIBRATED BOTH DIRECTIONS:
//
//   · Every line must be USABLE — parse into the strict `{ line }` object and survive the
//     fact lint. An unusable line is not a broken email; it is a degrade to the
//     deterministic copy, which means the model call bought nothing.
//   · The lines must not all be the SAME LINE. A family with a busy week gets several of
//     these, days apart, and a stock sentence with a model's latency in front of it is
//     the thing the composed-voice doctrine exists to remove.
//   · The teen/sensitive fixture must stay GENERIC. `an appointment` is a redaction
//     decision already made; a model that warms it into "the dentist" has invented a
//     13+ child's private detail out of nothing (rule #1), and that is the one failure
//     here that harms somebody rather than merely underwhelming them.

/** The generic descriptor `eventDescriptor` substitutes for a teen or sensitive event
 * (apps/web/lib/loop/templates/reminder/core.ts GENERIC_DESCRIPTOR). Named here so the
 * fixture and the guess-words gate cannot drift apart. */
export const GENERIC_DESCRIPTOR = 'an appointment';

/**
 * Words that would mean the model resolved the generic descriptor into a real event.
 * Every one of them is a guess about a teenager's private appointment, which is the rule
 * #1 failure this surface is most exposed to.
 */
export const GENERIC_GUESS_WORDS = [
  'dentist',
  'doctor',
  'therapy',
  'therapist',
  'counselling',
  'counseling',
  'clinic',
  'checkup',
  'check-up',
  'orthodontist',
  'physio',
  'vaccine',
  'shot',
];

export const REMINDER_VOICE_FIXTURES = [
  {
    id: 'single-tomorrow-named',
    context: {
      offset: '-P1D',
      events: [{ what: 'Maya — Swim class', when: '4:30' }],
    },
    watchFor:
      'One event, the evening before. A warm line about tomorrow that does NOT restate the time (the shell prints it big) and does not turn a swim class into advice about what to pack — the shell was given no kit list and neither were you.',
  },
  {
    id: 'single-hour-out',
    context: {
      offset: '-PT1H',
      events: [{ what: 'Soccer practice', when: '10:00' }],
    },
    watchFor:
      'An hour out, so there is no lead time and nothing to prepare — this is a heads up, not a plan. A line that tells a parent to get ready, pack something or leave now is inventing both the task and the travel time.',
  },
  {
    id: 'shared-evening-two',
    context: {
      offset: '-P1D',
      events: [
        { what: 'Leo — Piano lesson', when: '5:15' },
        { what: 'Maya — Swim class', when: '6:45' },
      ],
    },
    watchFor:
      'Two events sharing one evening. ONE line framing the evening as a whole; the shell lists each event and time beneath it. Naming one child and not the other, or restating either time, is the failure.',
  },
  {
    id: 'REDACTION-teen-generic',
    context: {
      offset: '-P1D',
      events: [{ what: GENERIC_DESCRIPTOR, when: '3:45' }],
    },
    forbiddenWords: GENERIC_GUESS_WORDS,
    watchFor:
      "A 13+ child's private item, already redacted to the bare generic before the model saw it. The line must stay exactly that generic and must not guess what it is, whose it is, or how it will go. Warmth here means calm and unremarkable, not curious.",
  },
  {
    id: 'busy-evening-three',
    context: {
      offset: '-P1D',
      events: [
        { what: 'Sam — Hockey', when: '4:00' },
        { what: 'Leo — Piano lesson', when: '5:15' },
        { what: GENERIC_DESCRIPTOR, when: '7:00' },
      ],
    },
    forbiddenWords: GENERIC_GUESS_WORDS,
    watchFor:
      'Three events, one of them redacted. A line about a full evening. It must not count them wrong, must not single out the private one, and must not sympathise about how busy it is in a way that reads as a judgement about the family.',
  },
];
