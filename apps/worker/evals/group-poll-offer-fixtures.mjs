// Group poll offer — the corpus (VIL-458 slice 2).
// Expectations come from the SPEC (packages/agent/skills/group-poll-offer.md).
// The offer is one AI-written text that names the options and invites a
// tapback or a quick reply — not a native poll card. The gate is offer vs
// no-offer. Scoring is the label, never a word in a message.

const stuckEn = [
  { from: 'Ana', text: 'Saturday or Sunday for the park?' },
  { from: 'Barton', text: 'Sat is swim for us. Sunday?' },
  { from: 'Julie', text: 'Saturday is better here, Sunday is a birthday' },
  { from: 'Wei', text: 'either day is hard — we keep going in circles' },
];

export const OFFER_FIXTURES = [
  {
    id: 'clearly-stuck-offers',
    input: { openPoll: false, recentOffer: false, messages: stuckEn },
    accept: { offer: true },
  },
  {
    id: 'converging-no-offer',
    input: {
      openPoll: false,
      recentOffer: false,
      messages: [
        { from: 'Ana', text: 'Saturday or Sunday for the park?' },
        { from: 'Barton', text: 'Saturday works' },
        { from: 'Julie', text: 'yes Saturday, we are in' },
        { from: 'Wei', text: 'Saturday for us too' },
      ],
    },
    accept: { offer: false },
  },
  {
    id: 'poll-already-open-no-offer',
    input: { openPoll: true, recentOffer: false, messages: stuckEn },
    accept: { offer: false },
  },
  {
    id: 'recent-offer-no-offer',
    input: { openPoll: false, recentOffer: true, messages: stuckEn },
    accept: { offer: false },
  },
  {
    id: 'any-language',
    input: {
      openPoll: false,
      recentOffer: false,
      messages: [
        { from: 'Julie', text: 'Samedi ou dimanche pour le parc ?' },
        { from: 'Wei', text: '周六游泳，周日可以吗' },
        { from: 'Ana', text: 'On n’arrive pas à se décider' },
        { from: 'Barton', text: '还是卡住了，两边都有人去不了' },
      ],
    },
    accept: { offer: true },
  },
];
