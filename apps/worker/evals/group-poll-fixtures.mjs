/**
 * VIL-471 judge cases. Meaning, not wording. A 1–5 score.
 *
 * The runner does not assert a phrase. The judge scores whether the reading
 * or the spoken line matches the situation.
 */

const LIVE_SATURDAY = {
  question: 'Saturday',
  options: [
    { key: 'o1', text: 'park' },
    { key: 'o2', text: 'pool' },
  ],
};

export const GROUP_POLL_READ_FIXTURES = [
  {
    id: 'start-with-options',
    situation:
      'A parent asks Hale, in their own words, to let the group vote between the park and the pool on Saturday. No poll is open yet.',
    input: {
      text: 'Hale can we vote Saturday — park or the pool?',
      tapback: null,
      senderName: 'Priya',
      plan: null,
      recent: [],
      polls: { live: null },
    },
    accept: ['start_poll'],
  },
  {
    id: 'vote-other-language',
    situation:
      'Someone picks the pool on the open Saturday poll (o1 park, o2 pool), writing in French.',
    input: {
      text: 'la piscine pour nous',
      tapback: null,
      senderName: 'Sam',
      plan: null,
      recent: [],
      polls: { live: LIVE_SATURDAY },
    },
    accept: ['poll_vote'],
  },
  {
    id: 'changed-mind',
    situation:
      'Someone who already picked the park on the open Saturday poll now wants the pool instead.',
    input: {
      text: 'actually let us do the pool',
      tapback: null,
      senderName: 'Maya',
      plan: null,
      recent: [],
      polls: { live: LIVE_SATURDAY },
    },
    accept: ['poll_vote'],
  },
  {
    id: 'banter-during-poll',
    situation: 'People joking during an open Saturday poll. Not a pick and not an ask.',
    input: {
      text: 'lol remember last time at the pool with the wasps',
      tapback: null,
      senderName: 'Maya',
      plan: null,
      recent: [],
      polls: { live: LIVE_SATURDAY },
    },
    accept: ['chatter'],
  },
  {
    id: 'ask-tally',
    situation: 'Someone wants the live picture of the open Saturday poll.',
    input: {
      text: 'where do we stand',
      tapback: null,
      senderName: 'Priya',
      plan: null,
      recent: [],
      polls: { live: LIVE_SATURDAY },
    },
    accept: ['ask_poll'],
  },
  {
    id: 'whatever-works',
    situation:
      'Someone says either Saturday choice is fine. That is not their own pick on the open poll.',
    input: {
      text: 'whatever works',
      tapback: null,
      senderName: 'Sam',
      plan: null,
      recent: [],
      polls: { live: LIVE_SATURDAY },
    },
    accept: ['chatter'],
  },
  {
    id: 'speaking-for-someone-else',
    situation:
      'Someone says what another person wants on the open Saturday poll. That is not their own pick.',
    input: {
      text: 'Sam wants the pool',
      tapback: null,
      senderName: 'Maya',
      plan: null,
      recent: [],
      polls: { live: LIVE_SATURDAY },
    },
    accept: ['chatter'],
  },
];

export const GROUP_POLL_VOICE_FIXTURES = [
  {
    id: 'poll-started',
    kind: 'poll_started',
    question: 'Saturday',
    card: true,
    options: [
      { key: 'o1', text: 'park', providerOptionId: null },
      { key: 'o2', text: 'pool', providerOptionId: null },
    ],
    votes: [],
    expected: [
      { memberKey: 'priya', displayName: 'Priya' },
      { memberKey: 'sam', displayName: 'Sam' },
    ],
    situation:
      'Hale just opened a Saturday poll. Facts: choices park and pool, waitingNames Priya Sam, card true. One question.',
    watchFor:
      'Must name the choices from facts and ask which one. Must not invent a reply keyword, a winner, or a count.',
  },
  {
    id: 'poll-needs-options',
    kind: 'poll_needs_options',
    question: 'Saturday',
    card: false,
    options: [],
    votes: [],
    expected: [{ memberKey: 'priya', displayName: 'Priya' }],
    situation:
      'A parent asked for a Saturday poll but did not give two choices. Facts: question Saturday, no options. One question.',
    watchFor: 'Must ask for the choices. Must not invent options, a winner, or a reply keyword.',
  },
  {
    id: 'poll-tally',
    kind: 'poll_tally',
    question: 'Saturday',
    card: false,
    options: [
      { key: 'o1', text: 'park', providerOptionId: null },
      { key: 'o2', text: 'pool', providerOptionId: null },
    ],
    votes: [
      { memberKey: 'priya', displayName: 'Priya', optionKey: 'o1' },
      { memberKey: 'sam', displayName: 'Sam', optionKey: 'o2' },
    ],
    expected: [
      { memberKey: 'priya', displayName: 'Priya' },
      { memberKey: 'sam', displayName: 'Sam' },
      { memberKey: 'maya', displayName: 'Maya' },
    ],
    situation:
      'Hale is reporting the live Saturday poll. Facts: park 1 (Priya), pool 1 (Sam), waiting Maya, leaders park and pool. No question.',
    watchFor:
      'Must carry each choice count, the tie, and who is waiting from facts. No ask. Must not invent a winner or a reply keyword.',
  },
  {
    id: 'all-in-tie',
    kind: 'poll_tally',
    question: 'Saturday',
    card: false,
    options: [
      { key: 'o1', text: 'park', providerOptionId: null },
      { key: 'o2', text: 'pool', providerOptionId: null },
    ],
    votes: [
      { memberKey: 'priya', displayName: 'Priya', optionKey: 'o1' },
      { memberKey: 'sam', displayName: 'Sam', optionKey: 'o2' },
    ],
    expected: [
      { memberKey: 'priya', displayName: 'Priya' },
      { memberKey: 'sam', displayName: 'Sam' },
    ],
    situation:
      'Everyone Hale was waiting on has picked. Facts: park 1 (Priya), pool 1 (Sam), allIn true, leaders park and pool (a tie). No question.',
    watchFor:
      'Must say the group has landed on a tie. Must not pick a winner. No ask. Must not invent a calendar write or a reply keyword.',
  },
];
