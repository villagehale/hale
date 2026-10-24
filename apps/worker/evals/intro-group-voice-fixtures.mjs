// The group introduction — the corpus.
//
// Expectations come from the SPEC (packages/agent/skills/intro-group-voice.md). There is
// no fixed copy under this stage: an intro every attempt fails is a pair that waits.
// `forbiddenPatterns` are the shapes only a WRONG intro can take — the composer is handed
// two first names, a stage word and maybe an activity, so a word about a child is a word
// it invented (rule #1).

const INVENTED_CHILD_FACT =
  /\b(daughter|son|boy|girl|months? old|years? old|she|he|her|his|him)\b/i;

export const INTRO_GROUP_VOICE_FIXTURES = [
  {
    id: 'plain-toddler',
    request: {
      parentAFirstName: 'Sam',
      parentBFirstName: 'Priya',
      stageWord: 'toddler',
      anchorTitle: null,
      anchorDay: null,
    },
    watchFor:
      'The plainest case. Both first names, the shared toddler stage, that both said yes, and that Hale is stepping out. No activity is given, so none may be invented.',
    forbiddenPatterns: [INVENTED_CHILD_FACT],
  },
  {
    id: 'anchored-preschool',
    request: {
      parentAFirstName: 'Dana',
      parentBFirstName: 'Tomas',
      stageWord: 'preschooler',
      anchorTitle: 'Family Storytime',
      anchorDay: 'Saturday',
    },
    watchFor:
      'Must name Family Storytime exactly and may say Saturday. The activity is offered as an easy first hello, never as a plan made for them.',
    forbiddenPatterns: [INVENTED_CHILD_FACT],
  },
  {
    id: 'numeric-anchor',
    request: {
      parentAFirstName: 'Lee',
      parentBFirstName: 'Amara',
      stageWord: 'baby',
      anchorTitle: 'Gym 2 Grow drop-in',
      anchorDay: 'Tuesday',
    },
    watchFor:
      'The number belongs to the venue name. Copying it through is correct; any other number (a time, a date, an age) is invention.',
    forbiddenPatterns: [INVENTED_CHILD_FACT],
  },
  {
    id: 'recompose-missing-name',
    request: {
      parentAFirstName: 'Sam',
      parentBFirstName: 'Priya',
      stageWord: 'toddler',
      anchorTitle: null,
      anchorDay: null,
    },
    rejected: [
      {
        intro: 'Hi Sam! Meet your neighbour - you both have toddlers.',
        problems: ['parent_name_missing'],
      },
    ],
    watchFor:
      'It was just told the last attempt dropped a name. This one must name both Sam and Priya and keep the warmth.',
    forbiddenPatterns: [INVENTED_CHILD_FACT],
  },
];
