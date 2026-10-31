// Who should this group reply mention? — the corpus (VIL-475).
//
// Expectations come from the SPEC (packages/agent/skills/group-mention-read.md).
// Each fixture is one already-written reply plus the seated people and inbound
// mention facts. Scoring is the mentionId the model returns, never a word in
// the reply.

const MEMBERS = [
  { id: 'm1', name: 'Dana', role: 'parent' },
  { id: 'm2', name: 'Jordan', role: 'co_parent' },
];

export const GROUP_MENTION_READ_FIXTURES = [
  {
    id: 'address-one-parent',
    input: {
      text: 'Dana, swim is at 4.',
      members: MEMBERS,
      inbound: { haleMentioned: false, mentionedMembers: [] },
    },
    accept: ['m1'],
  },
  {
    id: 'group-answer',
    input: {
      text: 'Swim is at 4 on Saturday.',
      members: MEMBERS,
      inbound: { haleMentioned: true, mentionedMembers: [] },
    },
    accept: [null],
  },
  {
    id: 'inbound-named-member',
    input: {
      text: 'Jordan has pickup.',
      members: MEMBERS,
      inbound: { haleMentioned: false, mentionedMembers: [{ name: 'Jordan' }] },
    },
    accept: ['m2'],
  },
  {
    id: 'two-people-equally',
    input: {
      text: 'You both have a window after 3.',
      members: MEMBERS,
      inbound: { haleMentioned: true, mentionedMembers: [] },
    },
    accept: [null],
  },
];
