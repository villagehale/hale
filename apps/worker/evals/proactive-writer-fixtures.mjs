/**
 * VIL-226 · the writer is graded on the text a parent would read.
 * Links the model omits are appended the same way compose.ts does.
 */

export const PROACTIVE_WRITER_FIXTURES = [
  {
    id: 'one-activity',
    items: [
      {
        id: 'lantern',
        what: 'Fanous Lantern Craft at Toronto Public Library',
        why: 'Saturday afternoon is open',
        sourceUrl: 'https://www.torontopubliclibrary.ca/programs-and-classes/',
        worthlessAfter: '2026-10-10T18:00:00.000Z',
        parentRequested: false,
        dedupeKey: 'lantern',
      },
    ],
    expect: {
      names: ['lantern'],
      urls: ['https://www.torontopubliclibrary.ca/programs-and-classes/'],
      oneMessage: true,
    },
  },
  {
    id: 'weekend-and-deadline',
    items: [
      {
        id: 'lantern',
        what: 'Fanous Lantern Craft at Toronto Public Library',
        why: 'Saturday afternoon is open',
        sourceUrl: 'https://www.torontopubliclibrary.ca/programs-and-classes/',
        worthlessAfter: '2026-10-10T18:00:00.000Z',
        parentRequested: false,
        dedupeKey: 'lantern',
      },
      {
        id: 'deadline',
        what: 'Fall swim registration closes Friday',
        why: 'the window closes this week',
        sourceUrl: 'https://www.toronto.ca/swim-registration',
        worthlessAfter: '2026-10-09T23:00:00.000Z',
        parentRequested: false,
        dedupeKey: 'deadline',
      },
    ],
    expect: {
      names: ['lantern', 'registration'],
      urls: [
        'https://www.torontopubliclibrary.ca/programs-and-classes/',
        'https://www.toronto.ca/swim-registration',
      ],
      oneMessage: true,
    },
  },
  {
    id: 'shorter-when-asked',
    items: [
      {
        id: 'craft',
        what: 'Sunday craft hour at the library',
        why: 'the parent asked to hear less, so this is the one thing worth saying',
        sourceUrl: 'https://www.torontopubliclibrary.ca/programs-and-classes/',
        worthlessAfter: null,
        parentRequested: false,
        dedupeKey: 'craft',
      },
    ],
    note: 'text me less',
    expect: {
      names: ['craft'],
      urls: ['https://www.torontopubliclibrary.ca/programs-and-classes/'],
      oneMessage: true,
    },
  },
];
