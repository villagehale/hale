// Reading a parent's reply in the evening check-in lane — the corpus.
//
// Expectations are derived from the SPEC (packages/agent/skills/checkin-intent.md, plus
// the guards in apps/web/lib/channel/checkin/intent-reading.ts), NOT from what the model
// happened to answer. Every `expect` is asserted against the SETTLED reading — what
// `settleCheckInIntent` hands production after the verbatim, confidence and
// already-there guards — because that, and not the raw JSON, is what acts.
//
// CALIBRATED BOTH DIRECTIONS, in the corpus itself:
//
//   · Nine fixtures MUST read as a cadence change. Until VIL-413 / VIL-417 this lane
//     matched LESS, NO and DAILY whole-string and taught parents to type them; the words
//     are no longer printed, so a reader that misses "less often please" or "no thanks"
//     leaves a parent asking in plain English and being asked again tomorrow.
//
//   · The rest MUST NOT read as a cadence change - a "no" about the day, a "less" about
//     the chaos, a tired tone, a request, a greeting with nothing open. A cadence change
//     costs a family a month of evenings; the harm of a wrong one is the reason the
//     confidence floor exists. A reader that eagerly hears "stop" in everything would
//     pass the first nine and fail these.
//
//   · Three fixtures are REQUESTS, one of them half a diary line. A request read as a
//     day note is a parent who asked for something and got a thank-you.
//
// `input` is the exact CheckInIntentInput the handler builds; `checkInIntentUserMessage`
// (loaded live) turns it into the user turn, so a change to what the model is told
// re-keys the cache here.

export const CHECKIN_INTENT_FIXTURES = [
  // ── cadence_off ──────────────────────────────────────────────────────────────
  {
    id: 'bare-no-en',
    input: { reply: 'no', language: 'en', questionStanding: true, cadence: 'daily' },
    expect: 'cadence_off',
    why: 'The evening question has no yes-or-no answer, so a bare no can only be about the asking.',
  },
  {
    id: 'bare-non-fr',
    input: { reply: 'non', language: 'fr', questionStanding: true, cadence: 'daily' },
    expect: 'cadence_off',
    why: 'Same as the English bare no.',
  },
  {
    id: 'no-thanks-en',
    input: { reply: 'No thanks', language: 'en', questionStanding: true, cadence: 'daily' },
    expect: 'cadence_off',
    why: 'A polite refusal of the asking.',
  },
  {
    id: 'stop-asking-en',
    input: {
      reply: 'please stop asking every night',
      language: 'en',
      questionStanding: false,
      cadence: 'daily',
    },
    expect: 'cadence_off',
    why: 'A stated wish that the questions stop, sent after the evening lapsed. Not weekly: nothing in it asks for less, it asks for none.',
  },
  {
    id: 'no-more-of-these-en',
    input: { reply: 'no more of these', language: 'en', questionStanding: true, cadence: 'weekly' },
    expect: 'cadence_off',
    why: 'Already on weekly and wants none; the skill names this exact phrase.',
  },

  // ── cadence_weekly ───────────────────────────────────────────────────────────
  {
    id: 'less-alone-en',
    input: { reply: 'less', language: 'en', questionStanding: true, cadence: 'daily' },
    expect: 'cadence_weekly',
    why: '"less" on its own is about the asking (the skill says so). The old keyword, now read rather than matched.',
  },
  {
    id: 'less-often-please-en',
    input: { reply: 'less often please', language: 'en', questionStanding: true, cadence: 'daily' },
    expect: 'cadence_weekly',
    why: 'Plain English for fewer evening questions.',
  },
  {
    id: 'not-every-night-question-en',
    input: {
      reply: 'could you not ask every night? once a week is fine',
      language: 'en',
      questionStanding: true,
      cadence: 'daily',
    },
    expect: 'cadence_weekly',
    why: 'Phrased as a question, but it is a wish about cadence, not a request for Hale to do or find something.',
  },
  {
    id: 'weekly-fr',
    input: {
      reply: 'une fois par semaine ça irait',
      language: 'fr',
      questionStanding: true,
      cadence: 'daily',
    },
    expect: 'cadence_weekly',
    why: 'French for once a week.',
  },

  // ── cadence_daily ────────────────────────────────────────────────────────────
  {
    id: 'every-night-when-weekly-en',
    input: {
      reply: 'every night please',
      language: 'en',
      questionStanding: false,
      cadence: 'weekly',
    },
    expect: 'cadence_daily',
    why: 'On weekly, asking for nightly back. The reach rules in the handler let a reoffer carry exactly this.',
  },
  {
    id: 'miss-these-when-off-en',
    input: {
      reply: 'I miss these, can you go back to asking every day',
      language: 'en',
      questionStanding: false,
      cadence: 'off',
    },
    expect: 'cadence_daily',
    why: 'Turned off, wants it back. The "can you" is about cadence, not a request for a find.',
  },

  // ── the already-there guard ──────────────────────────────────────────────────
  {
    id: 'every-night-when-daily-en',
    input: {
      reply: 'every night please',
      language: 'en',
      questionStanding: true,
      cadence: 'daily',
    },
    expect: 'other',
    why: 'Already nightly. Whether the model says cadence_daily or other, the settled reading is other: there is nothing to change.',
  },

  // ── day_note - including the hard "no" and "less" ────────────────────────────
  {
    id: 'no-it-was-fine-en',
    input: {
      reply: 'no, it was fine actually',
      language: 'en',
      questionStanding: true,
      cadence: 'daily',
    },
    expect: 'day_note',
    why: 'A no with a reason about the day is about the day. Reading this as cadence_off is the harm the floor exists for.',
  },
  {
    id: 'less-chaos-en',
    input: {
      reply: 'less chaos than yesterday',
      language: 'en',
      questionStanding: true,
      cadence: 'daily',
    },
    expect: 'day_note',
    why: '"less" about the day, not the asking.',
  },
  {
    id: 'every-day-park-en',
    input: {
      reply: 'every day she asks for the park',
      language: 'en',
      questionStanding: true,
      cadence: 'daily',
    },
    expect: 'day_note',
    why: '"every day" about the child, not the cadence.',
  },
  {
    id: 'fine-standing-en',
    input: { reply: 'fine', language: 'en', questionStanding: true, cadence: 'daily' },
    expect: 'day_note',
    why: 'One word with the question open is an answer to it.',
  },
  {
    id: 'diary-en',
    input: {
      reply: 'Long day. Park then early bed, both asleep by 7.',
      language: 'en',
      questionStanding: true,
      cadence: 'daily',
    },
    expect: 'day_note',
    why: 'The ordinary case: a diary line.',
  },
  {
    id: 'diary-fr',
    input: {
      reply: 'bof, journée difficile, mais elle a adoré la natation',
      language: 'fr',
      questionStanding: true,
      cadence: 'daily',
    },
    expect: 'day_note',
    why: 'A French diary line with a mood in it.',
  },
  {
    id: 'tired-tone-en',
    input: { reply: 'so tired tonight', language: 'en', questionStanding: true, cadence: 'daily' },
    expect: 'day_note',
    why: 'Tired is not "stop". Never infer a cadence change from tone.',
  },
  {
    id: 'diary-after-lapse-en',
    input: {
      reply: 'swim went great, she did a whole length',
      language: 'en',
      questionStanding: false,
      cadence: 'daily',
    },
    expect: 'day_note',
    why: 'A late answer is still a day note; the handler decides whether to file it, not the reader.',
  },

  // ── request ──────────────────────────────────────────────────────────────────
  {
    id: 'request-find-en',
    input: {
      reply: 'can you find a swim class for Mia',
      language: 'en',
      questionStanding: true,
      cadence: 'daily',
    },
    expect: 'request',
    why: 'Asks Hale to find something.',
  },
  {
    id: 'request-mixed-en',
    input: {
      reply: 'good day, swim went well. can you add dentist to the calendar for next week',
      language: 'en',
      questionStanding: true,
      cadence: 'daily',
    },
    expect: 'request',
    why: 'Half diary, half request: the request wins, because losing it costs the parent the thing they asked for.',
  },
  {
    id: 'request-fr',
    input: {
      reply: 'peux-tu trouver un cours de natation',
      language: 'fr',
      questionStanding: true,
      cadence: 'daily',
    },
    expect: 'request',
    why: 'French request for a find.',
  },

  // ── other ────────────────────────────────────────────────────────────────────
  {
    id: 'ok-not-standing-en',
    input: { reply: 'ok', language: 'en', questionStanding: false, cadence: 'daily' },
    expect: 'other',
    why: 'Nothing open to answer; a bare ok is nothing.',
  },
  {
    id: 'thanks-not-standing-en',
    input: { reply: 'thanks!', language: 'en', questionStanding: false, cadence: 'weekly' },
    expect: 'other',
    why: 'A thank-you with no content.',
  },
  {
    id: 'greeting-en',
    input: { reply: 'hi', language: 'en', questionStanding: false, cadence: 'daily' },
    expect: 'other',
    why: 'A greeting.',
  },
  {
    id: 'emoji-only-en',
    input: { reply: '👍', language: 'en', questionStanding: false, cadence: 'daily' },
    expect: 'other',
    why: 'An emoji on its own with nothing open.',
  },
  {
    id: 'carrier-stop-en',
    input: { reply: 'STOP', language: 'en', questionStanding: true, cadence: 'daily' },
    expect: 'other',
    why: 'The carrier layer handles STOP before the lane; if it reaches the reader anyway, it is other, never a cadence read.',
  },
  {
    id: 'third-party-en',
    input: {
      reply: 'Sam can you grab milk on the way home',
      language: 'en',
      questionStanding: true,
      cadence: 'daily',
    },
    expect: 'other',
    why: 'A message to the other parent that landed in the thread. Not a request to Hale, not a note about the day.',
  },
];
