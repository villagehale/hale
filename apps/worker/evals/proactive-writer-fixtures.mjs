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
    // VIL-685 · the one question when no school page or email has their winter break.
    id: 'school-break-ask',
    items: [
      {
        id: 'break-ask',
        what: "Hale does not know when this family's winter break from school or daycare is this school year. Ask when it starts and ends.",
        why: 'school_break_ask year=2026-27',
        sourceUrl: null,
        worthlessAfter: '2026-12-15T17:00:00.000Z',
        parentRequested: false,
      },
    ],
    cadenceNote: null,
    expect: { names: ['break'], urls: [] },
  },
];
