/**
 * VIL-226 · the writer is graded on the text a parent would read, after the runtime's
 * own grounding check and link rule (readWriterText in apps/web/lib/channel/proactive/
 * tools.ts). Invented places and links only.
 */

const LANTERN = {
  id: 'lantern',
  what: 'Paper Lantern Craft at the Elm Street library',
  why: 'Saturday afternoon is open',
  sourceUrl: 'https://library.example.test/programs',
  worthlessAfter: '2026-10-10T18:00:00.000Z',
  parentRequested: false,
};

export const PROACTIVE_WRITER_FIXTURES = [
  {
    id: 'one-activity',
    items: [LANTERN],
    cadenceNote: null,
    expect: { names: ['lantern'], urls: [LANTERN.sourceUrl] },
  },
  {
    id: 'weekend-and-deadline',
    items: [
      LANTERN,
      {
        id: 'deadline',
        what: 'Fall swim registration closes Friday',
        why: 'the window closes this week',
        sourceUrl: 'https://rec.example.test/swim-registration',
        worthlessAfter: '2026-10-09T23:00:00.000Z',
        parentRequested: false,
      },
    ],
    cadenceNote: null,
    expect: {
      names: ['lantern', 'registration'],
      urls: [LANTERN.sourceUrl, 'https://rec.example.test/swim-registration'],
    },
  },
  {
    id: 'shorter-when-asked',
    items: [
      {
        id: 'craft',
        what: 'Sunday craft hour at the library',
        why: 'the parent asked to hear less, so this is the one thing worth saying',
        sourceUrl: 'https://library.example.test/craft',
        worthlessAfter: null,
        parentRequested: false,
      },
    ],
    cadenceNote: 'text me less',
    expect: { names: ['craft'], urls: ['https://library.example.test/craft'] },
  },
  {
    // VIL-393 · the one ask the evening after a first class: facts only on the item.
    id: 'mid-activity-ask',
    items: [
      {
        id: 'mid-ask',
        what: 'Parent and tot swim',
        why: 'mid_activity_ask start=signup first_session_ended=2026-10-06T16:00:00.000Z',
        sourceUrl: null,
        worthlessAfter: '2026-10-07T12:00:00.000Z',
        parentRequested: false,
      },
    ],
    cadenceNote: null,
    expect: { names: ['swim'], urls: [] },
  },
  {
    // VIL-681 · one check-back on something the parent started yesterday: the thread's
    // own title and next step, no link.
    id: 'next-day-checkback',
    items: [
      {
        id: 'checkback',
        what: 'Fall swim registration for the 4 year old: pick a session',
        why: 'next_day_checkback asked=2026-10-08T01:40:00.000Z',
        sourceUrl: null,
        worthlessAfter: '2026-10-09T12:00:00.000Z',
        parentRequested: false,
      },
    ],
    cadenceNote: null,
    expect: { names: ['swim'], urls: [] },
  },
  {
    // VIL-684 · when winter registration opens in their own city, read off its own page.
    id: 'registration-opening',
    items: [
      {
        id: 'opening',
        what: 'Elm Falls Winter 2027 recreation programs registration opens Dec 1, 6:30 a.m.; everyone else Dec 2, 6:30 a.m.',
        why: 'registration_opening read=2026-11-12T20:00:00.000Z',
        sourceUrl: 'https://rec.example.test/winter-registration',
        worthlessAfter: '2026-12-01T11:30:00.000Z',
        parentRequested: false,
      },
    ],
    cadenceNote: null,
    expect: { names: ['dec 1', 'registration'], urls: [] },
  },
];
