// Fixtures for run-email-alert-notice-eval.mjs. Every name, address and business here is
// invented. The first five are the incidents, recreated: a vendor newsletter read as
// "Unknown", the parent's own mail about "Regular hour program", and the second Storytime
// text for an event already on the calendar.
//
// `expect` is the decision, checked in code: 'silent' means nothing may be sent (by the
// code gate before the writer, or by the writer's own verdict), 'send' means the writer
// must say yes and its text is then judged. `watchFor` is read by the judge only.

const NOW = '2026-09-17T15:00:00.000Z';
const ZONE = 'America/Toronto';
const ROBIN = { id: 'child-robin', name: 'Robin', ageInMonths: 40 };
const MAYA = { id: 'child-maya', name: 'Maya', ageInMonths: 170 };
const STORYTIME_EVENT = { table: 'family_events', id: 'evt-storytime' };

function extraction(kind, event, over = {}) {
  return {
    kind,
    event: {
      title: 'Untitled',
      childRef: null,
      originalTime: null,
      newTime: null,
      location: null,
      ...event,
    },
    sourceConfidence: 0.8,
    quoteEvidence: '',
    teenContent: false,
    teenAttributed: false,
    matchedEventRef: null,
    ...over,
  };
}

function args(over) {
  return {
    children: [ROBIN],
    fromParentsOwnCalendar: false,
    offer: null,
    otherHaleFamiliesGoing: null,
    timeZone: ZONE,
    now: NOW,
    ...over,
  };
}

export const EMAIL_ALERT_NOTICE_FIXTURES = [
  // ── THE INCIDENTS ─────────────────────────────────────────────────────────
  {
    id: 'incident-vendor-unknown-unclear',
    expect: 'silent',
    args: args({
      from: 'Holade <hello@holade.example>',
      subject: 'Your weekly update',
      kind: 'unclear',
      extraction: extraction('unclear', { title: 'Unknown' }),
    }),
    watchFor: 'The reading step could not say what changed. Nothing is sent.',
  },
  {
    id: 'incident-vendor-unknown-as-event',
    expect: 'silent',
    args: args({
      from: 'Holade <hello@holade.example>',
      subject: 'Your weekly update',
      kind: 'new_event',
      extraction: extraction('new_event', { title: 'Unknown' }),
    }),
    watchFor: 'A placeholder title from a vendor newsletter: not clear, so nothing is sent.',
  },
  {
    id: 'incident-parent-self-mail-unclear',
    expect: 'silent',
    args: args({
      from: 'Avery Lin <avery.lin@mail.example>',
      subject: 'Regular hour program',
      kind: 'unclear',
      extraction: extraction('unclear', { title: 'Regular hour program' }),
    }),
    watchFor: 'The parent mailed themself; the reading step was unclear. Nothing is sent.',
  },
  {
    id: 'incident-parent-self-mail-as-event',
    expect: 'silent',
    args: args({
      from: 'Avery Lin <avery.lin@mail.example>',
      subject: 'Regular hour program',
      kind: 'new_event',
      extraction: extraction('new_event', { title: 'Regular hour program' }),
    }),
    watchFor:
      'A person (not a school, club or program provider) wrote about "Regular hour program", which names no child and no date. Not shown to be about the kids: nothing is sent.',
  },
  {
    id: 'incident-storytime-matched-unchanged',
    expect: 'silent',
    args: args({
      from: 'Maplewood Library <events@maplewood-library.example>',
      subject: 'Reminder: Storytime this Saturday',
      kind: 'reminder_only',
      extraction: extraction(
        'reminder_only',
        { title: 'Storytime', childRef: 'child-robin', originalTime: '2026-09-19T17:00:00.000Z' },
        { matchedEventRef: STORYTIME_EVENT },
      ),
    }),
    watchFor: 'Already on the calendar and unchanged. Nothing is sent.',
  },

  // ── MATCHED, AND THE NEWS IS THE CHANGE ───────────────────────────────────
  {
    id: 'storytime-matched-cancelled',
    expect: 'send',
    args: args({
      from: 'Maplewood Library <events@maplewood-library.example>',
      subject: 'Storytime cancelled this Saturday',
      kind: 'cancellation',
      extraction: extraction(
        'cancellation',
        { title: 'Storytime', childRef: 'child-robin', originalTime: '2026-09-19T17:00:00.000Z' },
        { matchedEventRef: STORYTIME_EVENT },
      ),
    }),
    watchFor:
      'Says Storytime this Saturday (Sept 19, 1 PM) is cancelled. It is already on their calendar. No question.',
  },
  {
    id: 'storytime-matched-rescheduled',
    expect: 'send',
    args: args({
      from: 'Maplewood Library <events@maplewood-library.example>',
      subject: 'Storytime moved to Sunday',
      kind: 'reschedule',
      extraction: extraction(
        'reschedule',
        {
          title: 'Storytime',
          childRef: 'child-robin',
          originalTime: '2026-09-19T17:00:00.000Z',
          newTime: '2026-09-20T17:00:00.000Z',
        },
        { matchedEventRef: STORYTIME_EVENT },
      ),
    }),
    watchFor: 'Moved from Saturday Sept 19 to Sunday Sept 20, both at 1 PM. No question.',
  },

  // ── THE WRITER SAYS NO ────────────────────────────────────────────────────
  {
    id: 'parent-own-dentist',
    expect: 'silent',
    args: args({
      from: 'Lakeshore Dental <reminders@lakeshore-dental.example>',
      subject: 'Avery, your cleaning is confirmed',
      kind: 'new_event',
      extraction: extraction('new_event', {
        title: 'Dental cleaning',
        newTime: '2026-09-24T14:00:00.000Z',
      }),
    }),
    watchFor: "The parent's own appointment, addressed to Avery. Nothing is sent.",
  },

  // ── THE WRITER SAYS YES ───────────────────────────────────────────────────
  {
    id: 'swim-cancelled',
    expect: 'send',
    args: args({
      from: 'Riverside Pool <info@riverside.example>',
      subject: 'Swim class cancelled Saturday',
      kind: 'cancellation',
      extraction: extraction('cancellation', {
        title: 'Parent and tot swim',
        childRef: 'child-robin',
        originalTime: '2026-09-19T13:00:00.000Z',
      }),
    }),
    watchFor: "Robin's parent and tot swim on Saturday Sept 19 at 9 AM is off. No question.",
  },
  {
    id: 'picture-day-offer',
    expect: 'send',
    args: args({
      from: 'Maple Daycare <office@maple-daycare.example>',
      subject: 'Picture day next Friday',
      kind: 'new_event',
      offer: 'add_to_week',
      extraction: extraction('new_event', {
        title: 'Picture day',
        childRef: 'child-robin',
        newTime: '2026-10-02T13:00:00.000Z',
        location: 'the daycare',
      }),
    }),
    watchFor:
      'Picture day Friday Oct 2 at 9 AM. Ends on ONE question offering to add it to their week.',
  },
  {
    id: 'swim-booked-with-count',
    expect: 'send',
    args: args({
      from: 'Brookfield Recreation <noreply@recreation.brookfield.example>',
      subject: 'Registration Confirmation - Swim Level 1',
      kind: 'booking_confirmation',
      offer: 'add_to_calendar',
      otherHaleFamiliesGoing: 2,
      extraction: extraction('booking_confirmation', {
        title: 'Swim Level 1',
        childRef: 'child-robin',
        newTime: '2026-09-26T13:00:00.000Z',
        location: 'the Leisure Centre',
      }),
    }),
    watchFor:
      'Robin is registered for Swim Level 1, first class Saturday Sept 26 at 9 AM. Mentions two other Hale families (never just "families"). ONE question offering to add it to the calendar.',
  },
  {
    id: 'teen-private',
    expect: 'send',
    args: args({
      from: 'Northview Secondary <office@northview.example>',
      subject: 'Maya - exam schedule change',
      kind: 'reschedule',
      children: [MAYA],
      extraction: extraction(
        'reschedule',
        {
          title: 'a message about school',
          childRef: 'child-maya',
          originalTime: '2026-09-22T13:00:00.000Z',
          newTime: '2026-09-23T13:00:00.000Z',
          location: 'Room 4',
        },
        { teenContent: true },
      ),
    }),
    watchFor:
      'Private: says only that there was a message about school and that details were kept out. No sender, time, place or subject. No question.',
  },
];
