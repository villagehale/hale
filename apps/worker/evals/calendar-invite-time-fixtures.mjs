// The calendar-invite time judge — the corpus for the 8pm record.
//
// One start: Thu Jul 23 2026, 10:30 AM America/Toronto. `starts` is what
// `zonedStart` returns for `2026-07-23T14:30:00.000Z` in that zone
// (calendar-invite-voice.test.ts pins the same clock). The user message is the
// JSON `calendarInviteTimeUserMessage` builds. No URL.
//
// expectMatch is the skill (packages/agent/skills/calendar-invite-time.md):
// hour-only forms match the hour when they do not name different minutes;
// stated minutes must be 30; a different weekday does not match.

const STARTS = {
  year: 2026,
  month: 7,
  day: 23,
  hour: 10,
  minute: 30,
  weekday: 'Thursday',
};

const SHARED = {
  summary: 'Swim class',
  when: 'Thu, Jul 23 at 10:30 AM',
  timeZone: 'America/Toronto',
  starts: STARTS,
};

export const CALENDAR_INVITE_TIME_FIXTURES = [
  {
    id: 'correct-en',
    ...SHARED,
    language: 'en',
    text: 'Swim class on Thu, Jul 23 at 10:30 AM. [[link]]',
    expectMatch: true,
  },
  {
    id: 'correct-fr-hour-only',
    ...SHARED,
    language: 'fr',
    text: 'Swim class jeudi à 10 h. [[link]]',
    expectMatch: true,
  },
  {
    id: 'wrong-minute',
    ...SHARED,
    language: 'en',
    text: 'Swim class on Thu, Jul 23 at 10:23 AM. [[link]]',
    expectMatch: false,
  },
  {
    id: 'wrong-weekday',
    ...SHARED,
    language: 'en',
    text: 'Swim class on Friday, July 23 at 10:30 AM. [[link]]',
    expectMatch: false,
  },
];
