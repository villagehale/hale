// The calendar-invite WRITER — the corpus (VIL-596).
//
// Expectations come from the SPEC (packages/agent/skills/calendar-invite-voice.md): the
// text names the event by its summary, says when it is in `language`, says opening the
// link adds it to their phone's calendar, writes `[[link]]` once, and adds nothing it
// was not handed. Every name is invented; the zone is the family's own (here Chicago),
// and `when` is what inviteWhenLabel renders for `startsAt` in that zone.

export const CALENDAR_INVITE_VOICE_FIXTURES = [
  {
    id: 'en-plain',
    request: {
      summary: 'Swim class',
      when: 'Thu, Jul 23 at 10:30 AM',
      startsAt: '2026-07-23T15:30:00.000Z',
      timeZone: 'America/Chicago',
      language: 'en',
    },
    watchFor:
      'Swim class on Thursday Jul 23 at 10:30 AM; opening the link adds it to their calendar.',
  },
  {
    id: 'en-named-child',
    request: {
      summary: 'Ada - soccer practice',
      when: 'Mon, Sep 14 at 5:30 PM',
      startsAt: '2026-09-14T22:30:00.000Z',
      timeZone: 'America/Chicago',
      language: 'en',
    },
    watchFor:
      'The summary carries a child name. Name the event by it and add nothing about the child: no pronoun, no age, no team.',
  },
  {
    id: 'en-weekday-in-name',
    request: {
      summary: 'Saturday Art Club',
      when: 'Thu, Jul 23 at 10:30 AM',
      startsAt: '2026-07-23T15:30:00.000Z',
      timeZone: 'America/Chicago',
      language: 'en',
    },
    watchFor:
      'The name carries a weekday. The event is on Thursday; the text must not say it is on Saturday.',
  },
  {
    id: 'fr-pottery',
    request: {
      summary: 'Pottery for kids',
      when: 'Sat, Aug 1 at 9:00 AM',
      startsAt: '2026-08-01T14:00:00.000Z',
      timeZone: 'America/Chicago',
      language: 'fr',
    },
    watchFor:
      'Written in French. Saturday August 1 at 9:00 in the morning. The event named as given or in French.',
  },
  {
    id: 'zh-storytime',
    request: {
      summary: 'Library storytime',
      when: 'Wed, Jul 22 at 4:00 PM',
      startsAt: '2026-07-22T21:00:00.000Z',
      timeZone: 'America/Chicago',
      language: 'zh',
    },
    watchFor:
      'Written in Chinese. Wednesday July 22 at 4 in the afternoon. The event named as given or in Chinese.',
  },
];
