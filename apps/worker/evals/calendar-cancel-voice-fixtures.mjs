// The calendar cancellation — the corpus.
//
// Expectations come from the SPEC (packages/agent/skills/calendar-cancel-voice.md). The
// composer is handed an already-redacted summary and a time label and nothing else, so a
// reason for the cancellation, a reschedule, or a word about a child is invention.

const INVENTED_REASON = /\b(because|due to|weather|sick|rescheduled|moved to|instead)\b/i;
const INVENTED_CHILD_FACT = /\b(daughter|son|she|he|her|his|him)\b/i;

export const CALENDAR_CANCEL_VOICE_FIXTURES = [
  {
    id: 'plain-activity',
    request: { summary: 'Swim class', when: 'Thu, Jul 23 at 10:30 AM' },
    watchFor:
      'One or two calm sentences: Swim class on Thursday at 10:30 is cancelled, and they may want to take it off their calendar. No reason, no reschedule.',
    forbiddenPatterns: [INVENTED_REASON, INVENTED_CHILD_FACT],
  },
  {
    id: 'named-child',
    request: { summary: 'Maya - swim class', when: 'Sat, Aug 1 at 9:00 AM' },
    watchFor:
      'The summary carries a child name. Echo it exactly and add nothing about the child - no pronoun, no age.',
    forbiddenPatterns: [INVENTED_REASON, INVENTED_CHILD_FACT],
  },
  {
    id: 'generic-redacted',
    request: { summary: 'Your activity', when: 'Mon, Sep 14 at 4:00 PM' },
    watchFor:
      'A redacted (teen or sensitive) event. Say "Your activity" and nothing more specific - never guess what it was.',
    forbiddenPatterns: [INVENTED_REASON, INVENTED_CHILD_FACT],
  },
  {
    id: 'recompose-invented-time',
    request: { summary: 'Library storytime', when: 'Wed, Jul 22 at 10:30 AM' },
    rejected: [{ text: 'Library storytime at 11 is cancelled.', problems: ['invented_number'] }],
    watchFor:
      'It was just told it invented a time. This attempt must use only the handed time, or no time at all.',
    forbiddenPatterns: [INVENTED_REASON, INVENTED_CHILD_FACT],
  },
];
