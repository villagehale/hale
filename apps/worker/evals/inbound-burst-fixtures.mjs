// Fixtures for run-inbound-burst-eval.mjs: texts a parent sent back to back, and every
// grouping that reads them correctly. A grouping is a list of groups of refs; order inside
// a group and between groups does not matter. Names are synthetic.

const msg = (ref, text, attachments = []) => ({ ref, text, attachments });

export const INBOUND_BURST_FIXTURES = [
  {
    id: 'correction-budget',
    note: 'The second text corrects the number in the first. Answering $600 would be wrong.',
    previousHaleLine: null,
    messages: [msg('m1', '$600 budget for a fall program for Ada'), msg('m2', '$900')],
    allowed: [[['m1', 'm2']]],
  },
  {
    id: 'correction-time',
    note: 'A time, then its correction.',
    previousHaleLine: null,
    messages: [msg('m1', 'swim thursday at 4'), msg('m2', 'sorry 5')],
    allowed: [[['m1', 'm2']]],
  },
  {
    id: 'two-unrelated-asks',
    note: 'Two different asks a second apart: two answers.',
    previousHaleLine: null,
    messages: [
      msg('m1', 'is swim still on thursday?'),
      msg('m2', 'can you find a saturday art class for Ada'),
    ],
    allowed: [[['m1'], ['m2']]],
  },
  {
    id: 'wait-two-more-coming',
    note: '"Wait, two more coming" asks nothing and never stands alone; the two asks are separate.',
    previousHaleLine: null,
    messages: [
      msg('m1', 'wait, two more coming'),
      msg('m2', 'is swim on thursday'),
      msg('m3', "what's on saturday for Milo"),
    ],
    allowed: [
      [['m1', 'm2'], ['m3']],
      [['m2'], ['m1', 'm3']],
    ],
  },
  {
    id: 'photo-then-words',
    note: 'An attachment and the words about it are one ask.',
    previousHaleLine: null,
    messages: [msg('m1', '', ['image']), msg('m2', 'add this to the calendar')],
    allowed: [[['m1', 'm2']]],
  },
  {
    id: 'sentence-in-two-bubbles',
    note: 'One sentence split across two texts.',
    previousHaleLine: null,
    messages: [msg('m1', 'can you find'), msg('m2', 'a swim class for Milo on saturdays')],
    allowed: [[['m1', 'm2']]],
  },
  {
    id: 'answer-then-new-ask',
    note: 'Hale asked for approval. The yes answers Hale; the next text is a new ask.',
    previousHaleLine: 'I drafted moving swim to Tuesday at 4:30. Want me to go ahead?',
    messages: [msg('m1', 'yes'), msg('m2', "also what's on saturday")],
    allowed: [[['m1'], ['m2']]],
  },
  {
    id: 'correction-french',
    note: 'A correction in French.',
    previousHaleLine: null,
    messages: [msg('m1', 'budget de 600 $ pour une activité cet automne'), msg('m2', 'non 900 $')],
    allowed: [[['m1', 'm2']]],
  },
  {
    id: 'correction-across-an-ask',
    note: 'The third text corrects the first; the second is its own ask.',
    previousHaleLine: null,
    messages: [
      msg('m1', 'find piano for Ada'),
      msg('m2', 'is swim on thursday'),
      msg('m3', 'make that guitar not piano'),
    ],
    allowed: [[['m1', 'm3'], ['m2']]],
  },
  {
    id: 'thanks-then-ask',
    note: '"Thanks!" asks nothing and never stands alone.',
    previousHaleLine: 'Swim is Thursday at 4 at the West pool.',
    messages: [msg('m1', 'thanks!'), msg('m2', 'what time is pickup friday')],
    allowed: [[['m1', 'm2']]],
  },
];
