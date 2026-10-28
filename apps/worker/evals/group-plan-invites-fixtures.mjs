// Which families are in on a group plan, and the private note when one family's copy
// fails — the corpus (VIL-455).
//
// Expectations come from the SPEC (packages/agent/skills/group-plan-attendance-read.md and
// group-plan-invite-note.md). Families are fixtures standing in for the VIL-399 group ->
// families mapping. `accept` is, per family, the set of readings that are right; a family
// where `unclear` and `out` both send no invite lists both. Scoring is the label, never a
// word in a message.

const PLAN = {
  title: 'Playdate at Riverdale Park',
  startsAt: new Date('2026-11-07T15:00:00Z'),
  endsAt: new Date('2026-11-07T17:00:00Z'),
  location: 'Riverdale Park',
};

const LEE = { familyId: 'fam-lee', label: 'Lee', memberFirstNames: ['Ana', 'Min'] };
const DONG = { familyId: 'fam-dong', label: 'Dong', memberFirstNames: ['Barton', 'Wei'] };
const TREMBLAY = { familyId: 'fam-tremblay', label: 'Tremblay', memberFirstNames: ['Julie'] };
const FAMS = [LEE, DONG, TREMBLAY];
const NO = ['out', 'unclear'];

export const ATTENDANCE_FIXTURES = [
  {
    id: 'en-two-yes-one-silent',
    input: {
      plan: PLAN,
      families: FAMS,
      messages: [
        {
          familyId: 'fam-lee',
          senderName: 'Ana',
          text: 'Park saturday 10-12? kids are going stir crazy',
        },
        { familyId: 'fam-dong', senderName: 'Barton', text: 'count us in!' },
      ],
    },
    accept: { 'fam-lee': ['in'], 'fam-dong': ['in'], 'fam-tremblay': ['unclear'] },
  },
  {
    id: 'fr-yes-zh-no',
    input: {
      plan: PLAN,
      families: FAMS,
      messages: [
        { familyId: 'fam-lee', senderName: 'Ana', text: 'Park on Saturday morning, who is in?' },
        { familyId: 'fam-tremblay', senderName: 'Julie', text: 'On sera là avec plaisir 🙌' },
        { familyId: 'fam-dong', senderName: 'Wei', text: '这周六我们去不了，下次吧' },
      ],
    },
    accept: { 'fam-lee': ['in'], 'fam-tremblay': ['in'], 'fam-dong': ['out'] },
  },
  {
    id: 'backed-out-later',
    input: {
      plan: PLAN,
      families: FAMS,
      messages: [
        { familyId: 'fam-lee', senderName: 'Ana', text: 'Riverdale sat 10?' },
        { familyId: 'fam-dong', senderName: 'Barton', text: 'yes!' },
        { familyId: 'fam-tremblay', senderName: 'Julie', text: 'sure' },
        {
          familyId: 'fam-dong',
          senderName: 'Wei',
          text: 'ugh sorry, Leo has a fever, we have to skip',
        },
      ],
    },
    accept: { 'fam-lee': ['in'], 'fam-dong': ['out'], 'fam-tremblay': ['in'] },
  },
  {
    id: 'maybe-and-question',
    input: {
      plan: PLAN,
      families: FAMS,
      messages: [
        { familyId: 'fam-lee', senderName: 'Ana', text: 'park sat morning anyone?' },
        { familyId: 'fam-dong', senderName: 'Barton', text: 'maybe, depends on nap' },
        {
          familyId: 'fam-tremblay',
          senderName: 'Julie',
          text: 'is it the playground by the pool or the big hill?',
        },
      ],
    },
    accept: { 'fam-lee': ['in'], 'fam-dong': NO, 'fam-tremblay': NO },
  },
  {
    id: 'one-family-speaks-for-another',
    input: {
      plan: PLAN,
      families: FAMS,
      messages: [
        { familyId: 'fam-lee', senderName: 'Ana', text: 'Saturday at the park, 10am' },
        {
          familyId: 'fam-dong',
          senderName: 'Barton',
          text: 'we are in, and I talked to Julie, the Tremblays are coming too',
        },
      ],
    },
    accept: { 'fam-lee': ['in'], 'fam-dong': ['in'], 'fam-tremblay': ['in', 'unclear'] },
  },
  {
    id: 'someone-elses-yes-is-not-yours',
    input: {
      plan: PLAN,
      families: FAMS,
      messages: [
        { familyId: 'fam-lee', senderName: 'Ana', text: 'Park Saturday?' },
        { familyId: 'fam-dong', senderName: 'Barton', text: 'we will be there' },
        { familyId: 'fam-tremblay', senderName: 'Julie', text: 'nice, have fun!' },
      ],
    },
    accept: { 'fam-lee': ['in'], 'fam-dong': ['in'], 'fam-tremblay': NO },
  },
];

export const NOTE_FIXTURES = [
  {
    id: 'invite-failed-en',
    input: { plan: PLAN, familyLabel: 'Dong', failure: 'invite_failed' },
    watchFor:
      'Names the park plan and Saturday; says the calendar text did not reach them; no error words.',
  },
  {
    id: 'placement-failed',
    input: { plan: PLAN, familyLabel: 'Lee', failure: 'placement_failed' },
    watchFor:
      'Says the plan is not on their calendar yet; promises nothing the input does not say.',
  },
  {
    id: 'cancel-failed',
    input: { plan: PLAN, familyLabel: 'Tremblay', failure: 'cancel_failed' },
    watchFor: 'Says the plan was called off and their calendar may still show it.',
  },
];
