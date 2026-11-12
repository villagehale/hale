// Fixtures for run-inbound-side-turn-eval.mjs: a text that lands while Hale is still
// answering the parent's last one. `expect` is the verdict the side read must give.
// `mentions` (any one, case-insensitive) is what an answer must say; `replyMayBeEmpty`
// marks a question another reader answers (the world, health, safety). Names are synthetic.

const NOW = { date: '2026-11-12', weekday: 'Thursday', time: '09:40', timeZone: 'America/Toronto' };

const FAMILY = {
  thread: [
    { role: 'user', content: 'what do the kids have this week?' },
    {
      role: 'assistant',
      content: "Ada's swim is Thursday at 4:30 at the Y, and Milo has soccer Saturday at 10.",
    },
  ],
  children: [
    { name: 'Ada', stage: 'school_age', ageMonths: 86 },
    { name: 'Milo', stage: 'preschool', ageMonths: 50 },
  ],
  city: 'Toronto',
  memory: "Ada is in grade 2; her teacher is Ms. Okafor. Milo's daycare closes at 6.",
  localNow: NOW,
};

const FAMILY_FR = {
  ...FAMILY,
  thread: [
    { role: 'user', content: 'les enfants ont quoi cette semaine?' },
    {
      role: 'assistant',
      content: "La natation d'Ada est jeudi à 16 h 30 au Y, et Milo a soccer samedi à 10 h.",
    },
  ],
};

const RUNNING = ['can you find a saturday art class for Ada'];

const fixture = (id, note, input, expected) => ({
  id,
  note,
  input: { workingOn: RUNNING, waitingOn: [], family: FAMILY, ...input },
  ...expected,
});

export const INBOUND_SIDE_TURN_FIXTURES = [
  fixture(
    'fact-from-thread',
    'Hale already said the swim time in this thread: answer it now.',
    { text: 'what time is swim on thursday again?' },
    { expect: 'answer', mentions: ['4:30', '4.30', '430'] },
  ),
  fixture(
    'fact-from-family',
    "A child's age is in the family Hale can see.",
    { text: 'how old is Milo now?' },
    { expect: 'answer', mentions: ['4', 'four'] },
  ),
  fixture(
    'fact-from-memory',
    "The teacher's name is in what Hale remembers.",
    { text: "whats ada's teacher's name" },
    { expect: 'answer', mentions: ['Okafor'] },
  ),
  fixture(
    'fact-in-french',
    'A quick question in French, answered in French from the thread.',
    { text: "c'est à quelle heure la natation jeudi?", family: FAMILY_FR },
    { expect: 'answer', mentions: ['16 h 30', '16h30', '16 h30', '16:30'] },
  ),
  fixture(
    'world-question',
    'A question about the world stands on its own; the off-domain lane writes it.',
    { text: 'is the library open on remembrance day?' },
    { expect: 'answer', replyMayBeEmpty: true },
  ),
  fixture(
    'health-worry',
    'A health worry stands on its own; the medical lane writes it.',
    { text: 'Milo has a fever of 39.5, should I be worried?' },
    { expect: 'answer', replyMayBeEmpty: true },
  ),
  fixture(
    'correction-of-running',
    'It changes what Hale is working on: it belongs to that turn.',
    { text: 'actually make it sunday', workingOn: RUNNING },
    { expect: 'hand_back' },
  ),
  fixture(
    'bare-yes',
    'It answers a question Hale is waiting on.',
    {
      text: 'yes',
      waitingOn: ['adding Thursday swim to the calendar'],
      family: {
        ...FAMILY,
        thread: [
          ...FAMILY.thread,
          {
            role: 'assistant',
            content: 'Want me to add Thursday swim at 4:30 to your calendar?',
          },
        ],
      },
    },
    { expect: 'hand_back' },
  ),
  fixture(
    'write-ask',
    'It asks Hale to change the calendar.',
    { text: 'add dentist friday at 3 for Ada' },
    { expect: 'hand_back' },
  ),
  fixture(
    'new-find',
    'A new find needs the full turn.',
    { text: 'can you also find a piano teacher for Milo' },
    { expect: 'hand_back' },
  ),
  fixture(
    'asks-nothing',
    'A thanks asks nothing; it waits for its own turn.',
    { text: 'thanks!' },
    { expect: 'hand_back' },
  ),
];
