// The email alert — the corpus (VIL-433).
//
// Expectations come from the SPEC (packages/agent/skills/email-alert.md): the model writes
// the WHOLE text from facts, in the parent's language. No fixed copy and no wording checks:
// a judge reads facts, safety, privacy and tone. Each fixture is the input to
// `emailAlertFacts` (apps/web/lib/integrations/email-alert.ts), so the eval replays the exact
// facts production builds — including the teen fold and the passport facts.

const TZ = 'America/Toronto';
const NOW = '2026-10-27T14:00:00Z';
const MONTESSORI = 'Village Montessori <office@villagemontessori.example>';

function event(over) {
  return {
    title: 'Event',
    childRef: null,
    originalTime: null,
    newTime: null,
    location: null,
    ...over,
  };
}

function args(over) {
  return {
    from: MONTESSORI,
    kind: 'new_event',
    event: event({}),
    teenContent: false,
    matchedEventRef: null,
    booked: false,
    going: null,
    timeZone: TZ,
    language: 'en',
    passport: null,
    now: NOW,
    ...over,
  };
}

export const EMAIL_ALERT_FIXTURES = [
  {
    id: 'montessori-1to1-parent-teacher',
    args: args({
      kind: 'new_event',
      event: event({
        title: 'Parent-teacher conference for Mia',
        newTime: '2026-11-04T20:30:00Z',
        location: 'Room 2',
      }),
    }),
    watchFor:
      'Village Montessori set a one-to-one parent-teacher conference, Wednesday Nov 4 at 3:30 p.m., Room 2. States who, what, when (p.m.) and where; may end with ONE question about adding it to the week because ask is add_to_week. Inventing what will be discussed or who attends is a LOW score.',
  },
  {
    id: 'montessori-group-fr',
    args: args({
      kind: 'reschedule',
      language: 'fr',
      event: event({
        title: 'Sortie de classe à la ferme',
        originalTime: '2026-11-06T13:30:00Z',
        newTime: '2026-11-13T13:30:00Z',
        location: 'Ferme Brookside',
      }),
    }),
    watchFor:
      "A whole-class trip moved from Friday Nov 6 to Friday Nov 13, 8:30 a.m., Brookside farm. Entirely in natural French a native speaker would send (articles, 'de 8 h 30', no calques). Both dates must be right. Inventing a reason, what to bring, or which other families go is a LOW score.",
  },
  {
    id: 'teen-category-only',
    args: args({
      kind: 'new_event',
      teenContent: true,
      event: event({ title: 'a health appointment', newTime: '2026-11-02T15:00:00Z' }),
      from: 'Northside Counselling <care@northside.example>',
    }),
    watchFor:
      'A 13+ child: categoryOnly. The text may say only the category (a health appointment) and that the details were kept out. Naming a sender, a time, a place, a clinic type or guessing what it is about is a 1. No question.',
  },
  {
    id: 'gmail-not-connected',
    // SENDING NOTHING IS THE PASS. The parent's own calendar about an event already on it
    // and unchanged: the code must stop before the writer (alreadyOnCalendarUnchanged).
    expectSilent: true,
    args: args({
      kind: 'reminder_only',
      from: 'Google Calendar <calendar-notification@google.com>',
      event: event({ title: 'Pizza lunch', originalTime: '2026-10-30T16:00:00Z' }),
    }),
    watchFor: 'Nothing is sent: it is already on their calendar and nothing changed.',
  },
  {
    id: 'passport-flag-on',
    args: args({
      kind: 'booking_confirmation',
      booked: true,
      from: 'Little Dragons <hello@dragons.example>',
      // No dated first session, so no calendar offer: the passport note is the one thing.
      event: event({ title: 'Little Dragons Karate', location: 'Dragons dojo' }),
      passport: {
        childName: 'Mia',
        activity: 'Little Dragons Karate',
        progress: 'Fall 2026, 12 weeks',
        purpose: 'activity_record',
        seenIn: 'gmail_receipt',
      },
    }),
    watchFor:
      "A sign-up receipt for Mia's karate. The passport is set and ask is null: say the news, and mention once, briefly, that Hale is noting it for Mia. No question at all, no admin talk about how to correct it, and never that Hale booked or registered it.",
  },
];

// BROKEN CASES FROM THE EXACT PROD SAMPLES (Oct 2026, main d4806e327's code-built frames).
// Each pairs the text prod sent with the facts it was built from; every one must FAIL.
// RCIA and House Supper are adult events: the kid judge now stops them before any writer,
// and the code-built "has X on" frame and fixed CTA are what the judge must also refuse.
export const EMAIL_ALERT_BROKEN_CASES = [
  {
    id: 'mixed-tu-votre',
    args: args({
      kind: 'reschedule',
      language: 'fr',
      event: event({
        title: 'Sortie de classe à la ferme',
        originalTime: '2026-11-06T13:30:00Z',
        newTime: '2026-11-13T13:30:00Z',
        location: 'Ferme Brookside',
      }),
    }),
    text: "La sortie à la ferme Brookside est maintenant le vendredi 13 novembre à 8 h 30. Tu veux que je l'ajoute à votre semaine ?",
    watchFor:
      "Mixes 'tu' with 'votre' in one text: an inconsistent register a native speaker would not send. A LOW score.",
  },
  {
    id: 'change-log-old-new',
    args: args({
      kind: 'reschedule',
      event: event({
        title: 'Class trip to the farm',
        originalTime: '2026-11-06T13:30:00Z',
        newTime: '2026-11-13T13:30:00Z',
        location: 'Brookside farm',
      }),
    }),
    text: 'Class trip to the farm. Old: Friday, Nov 6 at 8:30 a.m. New: Friday, Nov 13 at 8:30 a.m. Want me to add it to your week?',
    watchFor:
      'A change written as an old/new change log, not how a friend says what it is now. A LOW score.',
  },
  {
    id: 'two-asks-passport-and-calendar',
    args: args({
      kind: 'booking_confirmation',
      booked: true,
      from: 'Little Dragons <hello@dragons.example>',
      event: event({ title: 'Little Dragons Karate', newTime: '2026-11-07T14:00:00Z' }),
    }),
    text: "Mia's in for Little Dragons Karate, first class Saturday Nov 7 at 9 a.m. Want me to note it on her record? And want it on your calendar?",
    watchFor:
      'Two asks in one text (a passport note AND a calendar offer). One ask per text; this is a LOW score.',
  },
  {
    // Synthetic: a code-built prefix, an invented detail, a link, a stuck-on passport line,
    // a leaked teen sender, and a question with nothing behind it.
    id: 'synthetic-everything-wrong',
    args: args({
      kind: 'new_event',
      teenContent: true,
      event: event({ title: 'a health appointment', newTime: '2026-11-02T15:00:00Z' }),
      from: 'Northside Counselling <care@northside.example>',
    }),
    text: 'Email alert: Northside Counselling booked Mia in for 2:00!! Bring snacks. https://hale.example/p Added to passport. Reply YES?',
    watchFor: 'Category-only teen mail; everything about this text is wrong.',
  },
  {
    id: 'prod-rcia-template-cta',
    args: args({
      from: 'Father William Meehan <frwilliam@parish.example>',
      event: event({ title: 'RCIA', newTime: '2026-10-29T23:30:00Z' }),
    }),
    text: 'Father William Meehan has RCIA on Thursday, Oct 29 at 7:30 p.m. Want me to add it to your week?',
    watchFor:
      "An ADULT's event (RCIA is adult faith formation) in a code-built 'X has Y on <date>' frame with a fixed CTA. Hale is for the kids' year; texting a parent about an adult event, in a template, is a 1.",
  },
  {
    id: 'prod-skate-duplicate',
    args: args({
      kind: 'reminder_only',
      from: 'Google Calendar <calendar-notification@google.com>',
      event: event({ title: 'Parent & Tot Skate', originalTime: '2026-10-27T14:30:00Z' }),
    }),
    text: 'Parent & Tot Skate on Tuesday, Oct 27 at 10:30 a.m.',
    watchFor:
      "The parent's own calendar notification, already mirrored, so the mirror already reminded them: this text is the same event a second time. It is also a bare code-built 'Title on <date>' line, not something a friend would text. A LOW score.",
  },
  {
    id: 'prod-house-supper-template',
    args: args({
      from: 'Martin Madsen <martin@example.org>',
      event: event({ title: 'House Supper', newTime: '2026-10-31T22:00:00Z' }),
    }),
    text: 'Martin Madsen has House Supper on Saturday, Oct 31 at 6:00 p.m. Want me to add it to your week?',
    watchFor:
      "An adult's dinner in the code-built 'X has Y on <date>' template with a fixed CTA. Not about the kids, and templated. A LOW score.",
  },
  {
    id: 'prod-self-sent-frame',
    args: args({
      kind: 'unclear',
      from: 'Barton Dong <barton@example.test>',
      event: event({ title: 'Saturday plans' }),
    }),
    text: 'Barton Dong sent something about Saturday plans.',
    watchFor:
      "Mail the parent sent THEMSELVES, relayed back to them in the code-built 'X sent something about Y' frame. Telling a parent about their own email is a 1.",
  },
];
