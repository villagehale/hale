// Is this group message Hale's turn? — the corpus (VIL-440).
//
// Expectations come from the SPEC (packages/agent/skills/group-turn-read.md). Each
// fixture is one group message with the sender's first name and only THIS group's last
// lines, the same group-only context groupTurnReadContext builds (VIL-439 scope).
// `accept` is the set of readings that route correctly: `addressed` and
// `question_for_hale` both route to the coach, so a fixture where either is right lists
// both. Scoring is the label the model returns, never a word in the message.

const HALE = ['Hale'];

export const GROUP_TURN_READ_FIXTURES = [
  {
    id: 'en-named-question',
    input: {
      text: 'hale what time is swim on saturday',
      senderName: 'Dana',
      haleNames: HALE,
      recent: [],
    },
    accept: ['addressed'],
  },
  {
    id: 'en-misspelled-name',
    input: {
      text: 'Hail can you remind us about picture day',
      senderName: 'Jordan',
      haleNames: HALE,
      recent: [],
    },
    accept: ['addressed'],
  },
  {
    id: 'en-parents-logistics',
    input: {
      text: 'can you grab milk on the way home?',
      senderName: 'Dana',
      haleNames: HALE,
      recent: [{ from: 'member', text: 'leaving work in 10' }],
    },
    accept: ['chatter'],
  },
  {
    id: 'en-duty',
    input: {
      text: "I'll take the kids to soccer tomorrow",
      senderName: 'Jordan',
      haleNames: HALE,
      recent: [{ from: 'member', text: 'who has soccer tomorrow?' }],
    },
    accept: ['duty'],
  },
  {
    id: 'en-continues-hale-thread',
    input: {
      text: 'and the one after that?',
      senderName: 'Dana',
      haleNames: HALE,
      recent: [
        { from: 'member', text: 'hale when is the next library storytime' },
        { from: 'hale', text: 'The next storytime is Tuesday at 10am at the Elm Street branch.' },
      ],
    },
    accept: ['addressed', 'question_for_hale'],
  },
  {
    id: 'en-unnamed-group-question',
    input: {
      text: 'what did we decide for the field trip form?',
      senderName: 'Priya',
      haleNames: HALE,
      recent: [{ from: 'hale', text: 'The field trip form is due Friday.' }],
    },
    accept: ['question_for_hale', 'addressed'],
  },
  {
    id: 'zh-named-question',
    input: {
      text: 'Hale，这周六游泳课几点？',
      senderName: '婷',
      haleNames: HALE,
      recent: [],
    },
    accept: ['addressed'],
  },
  {
    id: 'zh-parents-chatter',
    input: {
      text: '你今晚几点回来？',
      senderName: '伟',
      haleNames: HALE,
      recent: [{ from: 'member', text: '我还在开会' }],
    },
    accept: ['chatter'],
  },
  {
    id: 'ja-duty',
    input: {
      text: '明日のお迎えは私が行くね',
      senderName: '由美',
      haleNames: HALE,
      recent: [{ from: 'member', text: '明日のお迎え誰が行ける？' }],
    },
    accept: ['duty'],
  },
  {
    id: 'ar-named-request',
    input: {
      text: 'هيل، ذكّرنا بموعد الطبيب يوم الخميس من فضلك',
      senderName: 'ليلى',
      haleNames: HALE,
      recent: [],
    },
    accept: ['addressed'],
  },
];
