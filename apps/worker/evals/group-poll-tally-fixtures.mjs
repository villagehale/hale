// Group poll live tally — the corpus (VIL-458 slice 1).
// Expectations come from the SPEC (packages/agent/skills/group-poll-tally-read.md).
// `accept` is, per voter, the option ids (or null) that are right. Scoring is the
// label, never a word in a message.

const SAT = { optionId: 'opt-sat', text: 'Saturday 10am' };
const SUN = { optionId: 'opt-sun', text: 'Sunday 2pm' };
const poll = (perFamily) => ({
  question: 'Which day for the park?',
  perFamily,
  options: [SAT, SUN],
});

const ANA = { voterId: 'ana', familyId: 'lee', firstName: 'Ana' };
const MIN = { voterId: 'min', familyId: 'lee', firstName: 'Min' };
const BART = { voterId: 'bart', familyId: 'dong', firstName: 'Barton' };
const WEI = { voterId: 'wei', familyId: 'dong', firstName: 'Wei' };
const JULIE = { voterId: 'julie', familyId: 'tremblay', firstName: 'Julie' };
const ALL = [ANA, MIN, BART, WEI, JULIE];
const vote = (v, o, removed = false) => ({
  kind: 'vote',
  voterId: v.voterId,
  optionId: o.optionId,
  removed,
});
const text = (v, t) => ({ kind: 'text', voterId: v.voterId, text: t });

export const TALLY_FIXTURES = [
  {
    id: 'native-and-free-text-en',
    input: {
      poll: poll(true),
      voters: ALL,
      answers: [
        vote(ANA, SAT),
        text(BART, 'sat works for us'),
        text(JULIE, 'sunday pls, sat is swim'),
      ],
    },
    accept: { ana: ['opt-sat'], min: ['opt-sat'], bart: ['opt-sat'], wei: ['opt-sat'], julie: ['opt-sun'] },
  },
  {
    id: 'changed-mind-vote-then-text',
    input: {
      poll: poll(true),
      voters: ALL,
      answers: [
        vote(ANA, SAT),
        text(ANA, 'oh wait we have a birthday saturday, sunday instead'),
        vote(BART, SUN),
        vote(BART, SUN, true),
      ],
    },
    accept: { ana: ['opt-sun'], min: ['opt-sun'], bart: [null], wei: [null], julie: [null] },
  },
  {
    id: 'fr-zh-emoji',
    input: {
      poll: poll(true),
      voters: ALL,
      answers: [
        text(JULIE, 'Dimanche pour nous 😊'),
        text(WEI, '周六上午可以'),
        text(MIN, 'Sunday 2pm?'),
        text(ANA, '👍'),
      ],
    },
    accept: { ana: ['opt-sun'], min: ['opt-sun'], bart: ['opt-sat'], wei: ['opt-sat'], julie: ['opt-sun'] },
  },
  {
    id: 'whatever-works-is-no-pick',
    input: {
      poll: poll(true),
      voters: ALL,
      answers: [
        text(BART, 'whatever works for everyone!'),
        text(JULIE, 'either is fine'),
        text(ANA, 'maybe sat, depends on nap'),
      ],
    },
    accept: { ana: [null], min: [null], bart: [null], wei: [null], julie: [null] },
  },
  {
    id: 'no-speaking-for-others',
    input: {
      poll: poll(true),
      voters: ALL,
      answers: [
        text(ANA, 'Saturday for us, and I think the Tremblays said Saturday too'),
        text(BART, 'pretty sure the Tremblays want Sunday'),
      ],
    },
    accept: { ana: ['opt-sat'], min: ['opt-sat'], bart: [null], wei: [null], julie: [null] },
  },
  {
    id: 'parent-for-household',
    input: {
      poll: poll(true),
      voters: ALL,
      answers: [text(ANA, 'Saturday for us!'), text(WEI, '我们家周日比较好')],
    },
    accept: {
      ana: ['opt-sat'],
      min: ['opt-sat'],
      bart: ['opt-sun'],
      wei: ['opt-sun'],
      julie: [null],
    },
    tally: { counts: { 'opt-sat': 1, 'opt-sun': 1 }, waitingOn: ['tremblay'], split: [] },
  },
  {
    id: 'household-then-member-differs-is-pending',
    input: {
      poll: poll(true),
      voters: ALL,
      answers: [vote(ANA, SAT), text(ANA, "we're all good with Saturday"), vote(MIN, SUN)],
    },
    accept: { ana: ['opt-sat'], min: ['opt-sun'], bart: [null], wei: [null], julie: [null] },
    tally: {
      counts: { 'opt-sat': 0, 'opt-sun': 0 },
      waitingOn: ['dong', 'lee', 'tremblay'],
      split: ['lee'],
    },
  },
];
