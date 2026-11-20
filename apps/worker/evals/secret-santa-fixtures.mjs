// VIL-686 · Secret Santa eval cases (run-secret-santa-eval.mjs).
//
// People are seeded into one shared chat over the real DDL. `state` is the chat's draw as
// it stands before the message: who organized it, who is in and by what name. No case
// ever holds a pairing: the turn reader and the group lines never see one.

/** Everyone in the chat, by index. Families A and B; the rest are guests. */
export const SECRET_SANTA_PEOPLE = [
  { family: 'A', name: 'Priya' },
  { family: 'A', name: 'Ben' },
  { family: 'B', name: 'Hélène' },
  { family: null, name: 'Ana' },
  { family: null, name: '小明' },
  { family: null, name: 'Cy' },
];

const collecting = (organizer, ins) => ({
  status: 'collecting',
  organizer,
  participants: ins.map(([person, called]) => ({ person, called })),
});
const drawn = (organizer, ins) => ({ ...collecting(organizer, ins), status: 'drawn' });
const FOUR_IN = [
  [0, 'Priya'],
  [1, 'Ben'],
  [2, 'Hélène'],
  [3, 'Ana'],
];

/**
 * expect:
 *   santaTurn: whether the read is a Secret Santa turn at all
 *   outcome: the code outcome the turn must include (started, joined, left, drawn,
 *            not_organizer), or null for none
 *   called: the name the speaker must end up in with (string), or null for in-without-a-name
 *   noLine: the code must not send a group line on this turn
 */
export const SECRET_SANTA_TURN_FIXTURES = [
  {
    id: 'start-en',
    language: 'en',
    speaker: 0,
    text: "Let's do a Secret Santa this year!",
    state: null,
    expect: { santaTurn: true, outcome: 'started' },
  },
  {
    id: 'start-fr',
    language: 'fr',
    speaker: 2,
    text: 'On fait un Secret Santa cette année ?',
    state: null,
    expect: { santaTurn: true, outcome: 'started' },
  },
  {
    id: 'start-zh',
    language: 'zh',
    speaker: 0,
    text: '今年我们来抽秘密圣诞老人吧！',
    state: null,
    expect: { santaTurn: true, outcome: 'started' },
  },
  {
    id: 'join-named-en',
    language: 'en',
    speaker: 3,
    text: "Count me in! It's Ana",
    state: collecting(0, [[0, 'Priya']]),
    expect: { santaTurn: true, outcome: 'joined', called: 'Ana' },
  },
  {
    id: 'join-named-fr',
    language: 'fr',
    speaker: 2,
    text: "Je participe, c'est Hélène",
    state: collecting(0, [[0, 'Priya']]),
    expect: { santaTurn: true, outcome: 'joined', called: 'Hélène' },
  },
  {
    id: 'join-named-zh',
    language: 'zh',
    speaker: 4,
    text: '我也参加，我叫小明',
    state: collecting(0, [[0, 'Priya']]),
    expect: { santaTurn: true, outcome: 'joined', called: '小明' },
  },
  {
    id: 'join-unnamed-en',
    language: 'en',
    speaker: 5,
    text: "I'm in!",
    state: collecting(0, [[0, 'Priya']]),
    expect: { santaTurn: true, outcome: 'joined', called: null },
  },
  {
    id: 'join-unnamed-fr',
    language: 'fr',
    speaker: 5,
    text: 'Moi aussi !',
    state: collecting(2, [[2, 'Hélène']]),
    expect: { santaTurn: true, outcome: 'joined', called: null },
  },
  {
    id: 'join-unnamed-zh',
    language: 'zh',
    speaker: 5,
    text: '算我一个！',
    state: collecting(0, [[0, 'Priya']]),
    expect: { santaTurn: true, outcome: 'joined', called: null },
  },
  {
    id: 'leave-en',
    language: 'en',
    speaker: 1,
    text: 'Actually count me out this year, sorry',
    state: collecting(0, [
      [0, 'Priya'],
      [1, 'Ben'],
    ]),
    expect: { santaTurn: true, outcome: 'left' },
  },
  {
    id: 'leave-fr',
    language: 'fr',
    speaker: 1,
    text: 'Finalement je passe mon tour',
    state: collecting(2, [
      [2, 'Hélène'],
      [1, 'Ben'],
    ]),
    expect: { santaTurn: true, outcome: 'left' },
  },
  {
    id: 'leave-zh',
    language: 'zh',
    speaker: 1,
    text: '我这次不参加了',
    state: collecting(0, [
      [0, 'Priya'],
      [1, 'Ben'],
    ]),
    expect: { santaTurn: true, outcome: 'left' },
  },
  {
    id: 'draw-organizer-en',
    language: 'en',
    speaker: 0,
    text: "Everyone's in, draw the names!",
    state: collecting(0, FOUR_IN),
    expect: { santaTurn: true, outcome: 'drawn' },
  },
  {
    id: 'draw-organizer-fr',
    language: 'fr',
    speaker: 2,
    text: 'Tout le monde est là, on tire au sort !',
    state: collecting(2, FOUR_IN),
    expect: { santaTurn: true, outcome: 'drawn' },
  },
  {
    id: 'draw-organizer-zh',
    language: 'zh',
    speaker: 0,
    text: '人齐了，开始抽签吧！',
    state: collecting(0, FOUR_IN),
    expect: { santaTurn: true, outcome: 'drawn' },
  },
  {
    id: 'draw-not-organizer-en',
    language: 'en',
    speaker: 3,
    text: 'Can we draw now?',
    state: collecting(0, FOUR_IN),
    expect: { santaTurn: true, outcome: 'not_organizer' },
  },
  {
    id: 'lookalike-believes-en',
    language: 'en',
    speaker: 1,
    text: 'my kid still believes in Santa lol',
    state: null,
    expect: { santaTurn: false },
  },
  {
    id: 'lookalike-giftwrap-en',
    language: 'en',
    speaker: 2,
    text: "I'll bring gift wrap",
    state: collecting(0, [[0, 'Priya']]),
    expect: { santaTurn: false },
  },
  {
    id: 'lookalike-believes-fr',
    language: 'fr',
    speaker: 2,
    text: 'Ma fille croit encore au père Noël',
    state: null,
    expect: { santaTurn: false },
  },
  {
    id: 'who-got-whom-en',
    language: 'en',
    speaker: 3,
    text: 'who did Ben get?',
    state: drawn(0, FOUR_IN),
    expect: { santaTurn: true, outcome: null, noNames: true },
    secrets: ['who any participant drew'],
  },
  {
    id: 'who-got-whom-zh',
    language: 'zh',
    speaker: 3,
    text: 'Ben抽到谁了？',
    state: drawn(0, FOUR_IN),
    expect: { santaTurn: true, outcome: null, noNames: true },
    secrets: ['who any participant drew'],
  },
];

const EVERYONE = ['Priya', 'Ben', 'Hélène', 'Ana', '小明', 'Cy'];

/** Lines written straight from facts, through the real secret-santa-line skill. */
export const SECRET_SANTA_LINE_FIXTURES = [
  {
    id: 'giver-en',
    language: 'en',
    request: {
      purpose: 'giver_draw',
      language: 'en',
      facts: { giver: 'Priya', receiver: 'Ana', firstOneToOne: false, mayNotBeHaleFamily: false },
      verbatim: ['Ana'],
    },
    names: { giver: 'Priya', receiver: 'Ana', everyone: EVERYONE },
  },
  {
    id: 'giver-first-en',
    language: 'en',
    request: {
      purpose: 'giver_draw',
      language: 'en',
      facts: { giver: 'Cy', receiver: 'Ben', firstOneToOne: true, mayNotBeHaleFamily: true },
      verbatim: ['Ben'],
    },
    names: { giver: 'Cy', receiver: 'Ben', everyone: EVERYONE },
    watchFor: 'first 1:1: says it is Hale from the group chat and that they can ask Hale to stop',
  },
  {
    id: 'giver-first-fr',
    language: 'fr',
    request: {
      purpose: 'giver_draw',
      language: 'fr',
      facts: { giver: 'Hélène', receiver: 'Priya', firstOneToOne: true, mayNotBeHaleFamily: false },
      verbatim: ['Priya'],
    },
    names: { giver: 'Hélène', receiver: 'Priya', everyone: EVERYONE },
    watchFor: 'first 1:1: says it is Hale from the group chat and that they can ask Hale to stop',
  },
  {
    id: 'giver-first-zh',
    language: 'zh',
    request: {
      purpose: 'giver_draw',
      language: 'zh',
      facts: { giver: '小明', receiver: 'Hélène', firstOneToOne: true, mayNotBeHaleFamily: true },
      verbatim: ['Hélène'],
    },
    names: { giver: '小明', receiver: 'Hélène', everyone: EVERYONE },
    watchFor: 'first 1:1: says it is Hale from the group chat and that they can ask Hale to stop',
  },
  {
    id: 'done-en',
    language: 'en',
    request: { purpose: 'group_done', language: 'en', facts: { participants: 6, waiting: 2 } },
    names: { everyone: EVERYONE },
  },
  {
    id: 'done-fr',
    language: 'fr',
    request: { purpose: 'group_done', language: 'fr', facts: { participants: 4, waiting: 0 } },
    names: { everyone: EVERYONE },
  },
  {
    id: 'done-zh',
    language: 'zh',
    request: { purpose: 'group_done', language: 'zh', facts: { participants: 5, waiting: 1 } },
    names: { everyone: EVERYONE },
  },
  {
    id: 'refusal-too-few-en',
    language: 'en',
    request: {
      purpose: 'group_refusal',
      language: 'en',
      facts: { outcome: 'too_few', count: 3, minimum: 4 },
    },
    names: { everyone: EVERYONE },
  },
  {
    id: 'refusal-name-taken-fr',
    language: 'fr',
    request: {
      purpose: 'group_refusal',
      language: 'fr',
      facts: { outcome: 'name_taken', minimum: 4 },
    },
    names: { everyone: EVERYONE },
  },
  {
    id: 'refusal-unnamed-zh',
    language: 'zh',
    request: {
      purpose: 'group_refusal',
      language: 'zh',
      facts: { outcome: 'unnamed', count: 1, minimum: 4 },
    },
    names: { everyone: EVERYONE },
  },
  {
    id: 'note-missing-en',
    language: 'en',
    request: {
      purpose: 'organizer_note',
      language: 'en',
      facts: {
        kind: 'missing',
        waiting: [
          { called: 'Cy', why: 'needs_to_text_hale' },
          { called: 'Ana', why: 'cannot_reach' },
        ],
      },
    },
    names: { allowed: ['Cy', 'Ana', 'Priya'], everyone: EVERYONE },
  },
  {
    id: 'note-stale-fr',
    language: 'fr',
    request: { purpose: 'organizer_note', language: 'fr', facts: { kind: 'stale' } },
    names: { allowed: ['Hélène'], everyone: EVERYONE },
  },
];

/** The RSVP reader must not take a Secret Santa start ask, with or without a live plan. */
const PICNIC = {
  title: 'Saturday picnic',
  deadline: null,
  yesNames: ['Priya'],
  waitingNames: ['Ben', 'Hélène'],
};
// `takes`: whether the RSVP reader must take the turn. Every Santa start must not; the
// plan asks beside them are the positive control that `secretSanta` did not blind it.
export const SECRET_SANTA_CROSS_DOOR_FIXTURES = [
  { id: 'rsvp-start-en', text: "Let's do a Secret Santa this year!", plan: null, takes: false },
  { id: 'rsvp-start-fr', text: 'On fait un Secret Santa cette année ?', plan: null, takes: false },
  { id: 'rsvp-start-zh', text: '今年我们来抽秘密圣诞老人吧！', plan: null, takes: false },
  { id: 'rsvp-start-en-plan', text: "Let's do a Secret Santa this year!", plan: PICNIC, takes: false },
  { id: 'rsvp-start-fr-plan', text: 'On fait un Secret Santa cette année ?', plan: PICNIC, takes: false },
  { id: 'rsvp-start-zh-plan', text: '今年我们来抽秘密圣诞老人吧！', plan: PICNIC, takes: false },
  { id: 'rsvp-santa-in-plan', text: "I'm in for Secret Santa!", plan: PICNIC, takes: false },
  {
    id: 'rsvp-control-start-en',
    text: 'Hale can you keep track of who is coming to the picnic Saturday?',
    plan: null,
    takes: true,
  },
  { id: 'rsvp-control-yes-fr', text: 'Nous serons là samedi, toute la famille !', plan: PICNIC, takes: true },
  { id: 'rsvp-control-yes-zh', text: '我们周六会去野餐，一家三口', plan: PICNIC, takes: true },
];

/**
 * Known-bad lines. Each must FAIL on its own, by a code check or the judge. `fixture` names
 * the line case whose request and names it is checked against.
 */
export const SECRET_SANTA_BROKEN = [
  { id: 'broken-group-reveal', fixture: 'done-en', reply: 'All drawn! Ana has Ben 🎁' },
  {
    id: 'broken-two-receivers',
    fixture: 'giver-en',
    reply: "Psst Priya, you're Secret Santa for Ana. (Ben got Cy, don't tell!)",
  },
  {
    id: 'broken-done-pairs',
    fixture: 'done-fr',
    reply: 'C’est tiré ! Priya → Ana, Ben → Hélène, Ana → Priya, Hélène → Ben.',
  },
  {
    id: 'broken-first-no-identity',
    fixture: 'giver-first-en',
    reply: "You've got Ben! Keep it secret 🤫",
  },
  {
    id: 'broken-link',
    fixture: 'giver-en',
    reply: 'Priya, your Secret Santa is Ana! Gift ideas: bit.ly/santa-ideas',
  },
];
