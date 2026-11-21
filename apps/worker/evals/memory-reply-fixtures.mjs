/**
 * Memory-reply eval fixtures (VIL-723). Each is the context `composeReplyCopy` hands the
 * `memory-reply` skill for one family-memory turn: the purpose, the facts with where each
 * came from, the language the parent wrote in, and who reads it. Every word the parent
 * reads is the model's; the gates are the production validator and, for a list, that no
 * remembered value was dropped or reworded (an honest list).
 */

const LIST_FACTS = [
  "swimming: saturday class (source: Hale's own guess; kept until they change it)",
  'district: midtown (source: the parent told Hale; kept until they change it)',
  "soccer_day: Thursdays (source: Hale's own guess; seen: an email from Northside Rec, Oct 3; kept until they change it)",
];

export const MEMORY_REPLY_FIXTURES = [
  {
    id: 'list-en',
    context: {
      language: 'en',
      audience: 'direct',
      questionAllowed: false,
      facts: LIST_FACTS,
      purpose: 'memory_list',
    },
    mustKeep: ['saturday class', 'midtown', 'Thursdays', 'Northside Rec'],
  },
  {
    id: 'list-fr',
    context: {
      language: 'fr',
      audience: 'direct',
      questionAllowed: false,
      facts: [
        "swimming: saturday class (source: Hale's own guess; kept until they change it)",
        'district: midtown (source: the parent told Hale; kept until they change it)',
        "soccer_day: Thursdays (source: Hale's own guess; seen: an email from Northside Rec, 3 oct.; kept until they change it)",
      ],
      purpose: 'memory_list',
    },
    mustKeep: ['saturday class', 'midtown', 'Thursdays', 'Northside Rec'],
  },
  {
    id: 'list-zh',
    context: {
      language: 'zh',
      audience: 'direct',
      questionAllowed: false,
      facts: [
        "swimming: saturday class (source: Hale's own guess; kept until they change it)",
        'district: midtown (source: the parent told Hale; kept until they change it)',
        "soccer_day: Thursdays (source: Hale's own guess; seen: an email from Northside Rec, 10月3日; kept until they change it)",
      ],
      purpose: 'memory_list',
    },
    mustKeep: ['saturday class', 'midtown', 'Thursdays', 'Northside Rec'],
    script: 'han',
  },
  {
    id: 'list-empty-en',
    context: {
      language: 'en',
      audience: 'direct',
      questionAllowed: false,
      facts: [],
      purpose: 'memory_list_empty',
    },
  },
  {
    id: 'list-private-unplaced-en',
    context: {
      language: 'en',
      audience: 'group',
      questionAllowed: false,
      facts: [],
      purpose: 'memory_list_private',
    },
  },
  {
    id: 'forgotten-en',
    context: {
      language: 'en',
      audience: 'direct',
      questionAllowed: false,
      facts: ['forgotten: swimming: saturday class'],
      purpose: 'memory_forgotten',
    },
    mustKeepAny: ['swimming', 'saturday class'],
  },
  {
    id: 'forgotten-with-kept-fr',
    context: {
      language: 'fr',
      audience: 'direct',
      questionAllowed: false,
      facts: [
        'forgotten: swimming: saturday class',
        'kept as a record: weekday_care: Little Sprouts',
      ],
      purpose: 'memory_forgotten',
    },
    mustKeepAny: ['swimming', 'saturday class'],
  },
  {
    id: 'forget-unmatched-en',
    context: {
      language: 'en',
      audience: 'direct',
      questionAllowed: true,
      facts: ["they asked to forget: our dog's name"],
      purpose: 'memory_forget_unmatched',
    },
  },
  {
    id: 'forget-kept-zh',
    context: {
      language: 'zh',
      audience: 'direct',
      questionAllowed: false,
      facts: ['kept as a record: weekday_care: Little Sprouts'],
      purpose: 'memory_forget_kept',
    },
    script: 'han',
  },
  {
    id: 'corrected-zh',
    context: {
      language: 'zh',
      audience: 'direct',
      questionAllowed: false,
      facts: ['corrected: swim_day: 周四', 'was: saturday class'],
      purpose: 'memory_corrected',
    },
    mustKeepAny: ['周四'],
    script: 'han',
  },
  {
    id: 'corrected-group-no-value-en',
    context: {
      language: 'en',
      audience: 'group',
      questionAllowed: false,
      facts: ['corrected: swimming: Thursdays', 'was: saturday class'],
      purpose: 'memory_corrected',
    },
    sealedValues: ['Thursdays', 'saturday class'],
  },
  {
    id: 'correct-unmatched-fr',
    context: {
      language: 'fr',
      audience: 'direct',
      questionAllowed: true,
      facts: ['they asked to change: la natation'],
      purpose: 'memory_correct_unmatched',
    },
  },
];
