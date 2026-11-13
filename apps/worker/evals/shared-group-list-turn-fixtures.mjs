// VIL-687 · multi-family shared lists with owners. Synthetic people and children only.
//
// `people` are the chat's presence rows in order (refs p1, p2, ...): `name` is a first name
// said in the chat or null, `kid` the child they said they parent, `family` a label that
// seeds one Hale family per letter, and `haleKids` the children in that family's own Hale
// record (never shown to the model). `items` are seeded with `owner` as a people index (or
// null), and `hidden` as { forKid, from: [people index] } for a secret gift.
//
// `expect` is derived from the ticket, never from a model's output:
//   listTurn  — whether the message does anything to a list
//   owners    — the owner (people index or null) each seeded item has afterwards
//   newOwned  — how many NEW items the speaker owns afterwards
//   newOpen   — how many NEW open items exist afterwards
//   hide      — whether the speaker's new or claimed gift is kept from the child's family
//   reply     — 'required' when Hale must say something (a doubled claim, an ask)
//   hiddenNeverShown — an item text the model must never be handed (code's filter)
//   knownMiss — a first draw that failed one check, kept as a finding (never re-drawn)

const POTLUCK = 'Potluck';

export const SHARED_GROUP_LIST_TURN_FIXTURES = [
  {
    id: 'en-claim-potluck',
    language: 'English',
    people: [
      { name: 'Dana', kid: null, family: 'A' },
      { name: 'Priya', kid: null, family: 'B' },
      { name: null, kid: null, family: null },
    ],
    speaker: 0,
    items: [
      { list: POTLUCK, text: 'salad', owner: null },
      { list: POTLUCK, text: 'drinks', owner: 1 },
      { list: POTLUCK, text: 'cupcakes', owner: null },
    ],
    text: "We'll bring the salad! 🥗",
    expect: { listTurn: true, owners: { salad: 0, drinks: 1, cupcakes: null }, newOwned: 0 },
    secrets: [],
    watchFor: 'Dana now has the salad. Cupcakes are still open, but nobody asked what is left.',
  },
  {
    id: 'en-claim-varied-wording',
    language: 'English',
    people: [
      { name: 'Sam', kid: null, family: 'A' },
      { name: 'Priya', kid: null, family: 'B' },
    ],
    speaker: 0,
    items: [
      { list: 'Class party', text: 'napkins', owner: null },
      { list: 'Class party', text: 'paper cups', owner: null },
      { list: 'Class party', text: 'plates', owner: null },
    ],
    text: 'put us down for napkins + cups',
    expect: {
      listTurn: true,
      owners: { napkins: 0, 'paper cups': 0, plates: null },
      newOwned: 0,
    },
    secrets: [],
    watchFor: '"cups" is the paper cups already on the list, not a new item.',
  },
  {
    id: 'fr-claim',
    language: 'French',
    people: [
      { name: 'Camille', kid: null, family: 'A' },
      { name: 'Hugo', kid: null, family: 'B' },
    ],
    speaker: 0,
    items: [
      { list: 'Repas partagé', text: 'salade', owner: null },
      { list: 'Repas partagé', text: 'boissons', owner: null },
    ],
    text: "On s'occupe des boissons, pas de souci !",
    expect: { listTurn: true, owners: { salade: null, boissons: 0 }, newOwned: 0 },
    secrets: [],
    watchFor: 'French to a group uses vous.',
  },
  {
    id: 'zh-claim',
    language: 'Simplified Chinese',
    people: [
      { name: '小雨', kid: null, family: 'A' },
      { name: '林', kid: null, family: 'B' },
      { name: null, kid: null, family: null },
    ],
    speaker: 0,
    items: [
      { list: '野餐', text: '水果', owner: null },
      { list: '野餐', text: '蛋糕', owner: 1 },
    ],
    text: '我们带水果吧',
    expect: { listTurn: true, owners: { 水果: 0, 蛋糕: 1 }, newOwned: 0 },
    secrets: [],
    watchFor: 'Reply in Simplified Chinese.',
  },
  {
    id: 'en-double-claim',
    language: 'English',
    people: [
      { name: 'Jordan', kid: null, family: 'A' },
      { name: 'Priya', kid: null, family: 'B' },
    ],
    speaker: 0,
    items: [
      { list: POTLUCK, text: 'cupcakes', owner: 1 },
      { list: POTLUCK, text: 'fruit tray', owner: null },
    ],
    text: 'I can make cupcakes for Saturday!',
    expect: {
      listTurn: true,
      owners: { cupcakes: 1, 'fruit tray': null },
      newOwned: 0,
      reply: 'required',
    },
    secrets: [],
    watchFor:
      'Priya already has the cupcakes. Jordan must hear that, not that the cupcakes are theirs.',
  },
  {
    id: 'fr-double-claim',
    language: 'French',
    people: [
      { name: 'Léa', kid: null, family: 'A' },
      { name: 'Hugo', kid: null, family: 'B' },
    ],
    speaker: 0,
    items: [
      { list: 'Repas partagé', text: 'dessert', owner: 1 },
      { list: 'Repas partagé', text: 'pain', owner: null },
    ],
    text: 'Je prends le dessert !',
    expect: {
      listTurn: true,
      owners: { dessert: 1, pain: null },
      newOwned: 0,
      reply: 'required',
    },
    secrets: [],
    watchFor: 'Hugo already has the dessert. French to a group uses vous.',
  },
  {
    id: 'zh-double-claim',
    language: 'Simplified Chinese',
    people: [
      { name: '小雨', kid: null, family: 'A' },
      { name: null, kid: null, family: 'B' },
    ],
    speaker: 0,
    items: [{ list: '野餐', text: '蛋糕', owner: 1 }],
    text: '蛋糕我来买',
    expect: { listTurn: true, owners: { 蛋糕: 1 }, newOwned: 0, reply: 'required' },
    secrets: [],
    watchFor: 'Someone with no name in the chat already has the cake.',
  },
  {
    id: 'en-whats-left',
    language: 'English',
    people: [
      { name: 'Dana', kid: null, family: 'A' },
      { name: 'Priya', kid: null, family: 'B' },
      { name: 'Sam', kid: null, family: 'C' },
    ],
    speaker: 0,
    items: [
      { list: POTLUCK, text: 'salad', owner: 1 },
      { list: POTLUCK, text: 'drinks', owner: null },
      { list: POTLUCK, text: 'plates', owner: null },
      { list: POTLUCK, text: 'dessert', owner: 2 },
    ],
    text: "what's still open for Saturday?",
    expect: {
      listTurn: true,
      owners: { salad: 1, drinks: null, plates: null, dessert: 2 },
      newOwned: 0,
      reply: 'required',
    },
    secrets: [],
    watchFor: 'Exactly drinks and plates are open.',
  },
  {
    id: 'zh-whats-left',
    language: 'Simplified Chinese',
    people: [
      { name: '小雨', kid: null, family: 'A' },
      { name: '林', kid: null, family: 'B' },
    ],
    speaker: 0,
    items: [
      { list: '野餐', text: '水果', owner: 1 },
      { list: '野餐', text: '饮料', owner: null },
      { list: '野餐', text: '纸盘', owner: null },
    ],
    text: '还差什么？',
    expect: {
      listTurn: true,
      owners: { 水果: 1, 饮料: null, 纸盘: null },
      newOwned: 0,
      reply: 'required',
    },
    secrets: [],
    watchFor: 'Exactly 饮料 and 纸盘 are open.',
  },
  {
    id: 'en-secret-gift',
    language: 'English',
    people: [
      { name: 'Sam', kid: null, family: 'A' },
      { name: 'Priya', kid: null, family: 'B' },
      { name: null, kid: null, family: null },
    ],
    speaker: 0,
    items: [
      {
        list: "Zara's birthday",
        text: 'art set for Zara',
        owner: 1,
        hidden: { forKid: 'Zara', from: [] },
      },
    ],
    text: "I'll get Zara the Lego set 🤫",
    expect: { listTurn: true, owners: { 'art set for Zara': 1 }, newOwned: 1, hide: true },
    secrets: [],
    watchFor: "The chat keeps Zara's gifts from her family, who are not in this chat.",
  },
  {
    id: 'en-gift-open',
    language: 'English',
    people: [
      { name: 'Ada', kid: 'Zara', family: 'A' },
      { name: 'Sam', kid: null, family: 'B' },
    ],
    speaker: 1,
    items: [],
    text: "Ada, I'll grab Zara that Lego set she asked for!",
    expect: { listTurn: true, owners: {}, newOwned: 1, hide: false },
    secrets: [],
    watchFor: "Sam is telling Zara's own mom about the gift. Nothing is secret.",
  },
  {
    id: 'en-teacher-gift',
    language: 'English',
    people: [
      { name: 'Dana', kid: null, family: 'A' },
      { name: 'Priya', kid: null, family: 'B' },
    ],
    speaker: 0,
    items: [
      { list: 'Gift for Ms. Okafor', text: 'gift card', owner: null },
      { list: 'Gift for Ms. Okafor', text: 'card everyone signs', owner: null },
    ],
    text: "I'll grab the gift card this weekend",
    expect: {
      listTurn: true,
      owners: { 'gift card': 0, 'card everyone signs': null },
      newOwned: 0,
      hide: false,
    },
    secrets: [],
    watchFor: 'A teacher gift is not a secret from any family here.',
  },
  {
    id: 'en-secret-kept-from-family',
    language: 'English',
    people: [
      { name: 'Ada', kid: 'Zara', family: 'A' },
      { name: 'Priya', kid: null, family: 'B' },
      { name: 'Sam', kid: null, family: 'C' },
    ],
    speaker: 0,
    items: [
      {
        list: "Zara's party",
        text: 'Lego set for Zara',
        owner: 1,
        hidden: { forKid: 'Zara', from: [0] },
      },
      { list: "Zara's party", text: 'balloons', owner: 2 },
      { list: "Zara's party", text: 'cake', owner: null },
    ],
    text: "what's left for the party?",
    expect: {
      listTurn: true,
      owners: { 'Lego set for Zara': 1, balloons: 2, cake: null },
      newOwned: 0,
      reply: 'required',
      hiddenNeverShown: 'Lego set for Zara',
    },
    secrets: ['Lego set for Zara', 'Priya is getting Zara a gift'],
    watchFor: "Ada is Zara's mom. The cake is the only open item she can be told about.",
  },
  {
    id: 'en-secret-hale-kid-whats-left',
    language: 'English',
    people: [
      { name: 'Ada', kid: null, family: 'A', haleKids: ['Zara'] },
      { name: 'Priya', kid: null, family: 'B' },
      { name: 'Sam', kid: null, family: 'C' },
    ],
    speaker: 2,
    items: [
      {
        list: "Zara's party",
        text: 'Lego set for Zara',
        owner: 1,
        hidden: { forKid: 'Zara', from: [] },
      },
      { list: "Zara's party", text: 'balloons', owner: 2 },
      { list: "Zara's party", text: 'cake', owner: null },
    ],
    text: "what's left for the party?",
    expect: {
      listTurn: true,
      owners: { 'Lego set for Zara': 1, balloons: 2, cake: null },
      newOwned: 0,
      reply: 'required',
      hiddenNeverShown: 'Lego set for Zara',
    },
    secrets: ['Lego set for Zara', 'Priya is getting Zara a gift'],
    watchFor:
      "Ada's own Hale family has a child named Zara, though she never said so here. The cake is the only open item.",
  },
  {
    id: 'en-add-needs',
    language: 'English',
    people: [
      { name: 'Dana', kid: null, family: 'A' },
      { name: 'Priya', kid: null, family: 'B' },
    ],
    speaker: 1,
    items: [{ list: 'Picnic', text: 'sandwiches', owner: 0 }],
    text: 'We still need ice and a cooler for the picnic',
    expect: {
      listTurn: true,
      owners: { sandwiches: 0 },
      newOwned: 0,
      newOpen: 2,
    },
    secrets: [],
    watchFor: 'Ice and a cooler are needed; nobody took them.',
  },
  {
    id: 'en-chatter',
    language: 'English',
    people: [
      { name: 'Dana', kid: null, family: 'A' },
      { name: 'Priya', kid: null, family: 'B' },
    ],
    speaker: 0,
    items: [{ list: POTLUCK, text: 'salad', owner: 1 }],
    text: "Can't wait for Saturday, the kids are so excited!",
    expect: { listTurn: false, owners: { salad: 1 }, newOwned: 0 },
    secrets: [],
    watchFor: 'Not about a list.',
  },
];

/**
 * --broken: replies the judge MUST score below JUDGE_MIN against a real fixture's facts.
 * `after` is the fixture's expected end state; each reply is wrong for the reason its id names.
 */
export const SHARED_GROUP_LIST_TURN_BROKEN = [
  { id: 'double-told-yours', fixture: 'en-double-claim', reply: 'Cupcakes are yours, thank you!' },
  {
    id: 'double-wrong-owner',
    fixture: 'en-double-claim',
    reply: 'Sam already has the cupcakes, so maybe the fruit tray?',
  },
  {
    id: 'whats-left-taken-as-open',
    fixture: 'en-whats-left',
    reply: 'Still open: salad, drinks and plates.',
  },
  {
    id: 'secret-hinted',
    fixture: 'en-secret-kept-from-family',
    reply: "Cake's still open. Priya has something special covered for Zara 😉",
  },
  { id: 'wrong-language', fixture: 'zh-claim', reply: 'Fruit is yours, thanks!' },
  {
    id: 'filing-and-recital',
    fixture: 'en-claim-potluck',
    reply: 'Claim recorded: salad assigned to Dana. Open items: cupcakes.',
  },
];
