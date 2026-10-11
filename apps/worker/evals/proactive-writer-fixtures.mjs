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
];
