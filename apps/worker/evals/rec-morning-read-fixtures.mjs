// rec-morning-read eval fixtures (VIL-545). Every text here passes the rec-morning word
// test for a city family (read.test.ts pins that), so each one is a turn the model
// really reads. The two pickup texts are the Nov 1 Preview proof's group and 1:1 turns,
// which the lane used to answer with the city's registration morning.

/** The eval's clock, fixed so each fixture's facts (and its cache key) never move. */
export const REC_MORNING_READ_NOW = '2026-11-08T14:00:00.000Z';

/** A family whose stored place resolves to the city the facts are about. No postal. */
export const REC_MORNING_READ_WHERE = {
  municipality: 'toronto',
  postal: null,
  timeZone: 'America/Toronto',
};

/** VIL-684 · a town's own opening, as the family is told it (city/context.ts `line`): the
 * facts a mid-signup program-dates question is read against. */
const OWN_TOWN_LINE =
  'Markham Winter 2027 registration opens Dec 1, 6:30 a.m. for Markham residents; everyone else Dec 2, 6:30 a.m.';

export const REC_MORNING_READ_FIXTURES = [
  {
    id: 'group-loop-in-swim-pickup',
    path: 'group',
    text: "Hale, can you loop in Sam about Saturday's swim pickup? I can't make it.",
    expect: 'other',
  },
  {
    id: 'direct-loop-in-swim-pickup',
    path: 'direct',
    text: "Can you loop in Sam about Saturday's swim pickup?",
    expect: 'other',
  },
  {
    id: 'group-who-grabs-from-skate',
    path: 'group',
    text: 'can someone grab her from skate at 4? running late at work',
    expect: 'other',
  },
  {
    id: 'direct-swim-cancelled',
    path: 'direct',
    text: 'swim is cancelled this week, the pool is closed for repairs',
    expect: 'other',
  },
  {
    id: 'group-camp-went-well',
    path: 'group',
    text: 'camp was great today, she wants to go back tomorrow',
    expect: 'other',
  },
  {
    id: 'direct-when-swim-registration',
    path: 'direct',
    text: 'when does swim registration open?',
    expect: 'answers',
  },
  {
    id: 'group-rec-login',
    path: 'group',
    text: 'Hale, which site do we sign in on for fall rec programs?',
    expect: 'answers',
  },
  {
    id: 'direct-wishlist-frozen',
    path: 'direct',
    text: 'the wishlist page looks frozen, should I keep hitting refresh?',
    expect: 'answers',
  },
  {
    id: 'direct-pickup-and-registration',
    path: 'direct',
    text: 'can you loop in Sam about swim pickup? also when does winter swim registration open',
    expect: 'answers',
  },
  {
    id: 'direct-efun',
    path: 'direct',
    text: 'is efun still a thing?',
    expect: 'answers',
  },
  // VIL-684 · mid-signup, a program-dates question read against the own town's opening.
  // Only a question about that opening is answered from it; any other is searched.
  {
    id: 'intake-own-town-winter-open',
    path: 'intake',
    text: 'when does winter rec registration open?',
    facts: OWN_TOWN_LINE,
    expect: 'answers',
  },
  {
    id: 'intake-own-town-my-town',
    path: 'intake',
    text: 'when do winter programs open for sign up in my town?',
    facts: OWN_TOWN_LINE,
    expect: 'answers',
  },
  {
    id: 'intake-own-town-other-town',
    path: 'intake',
    text: 'my sister is in Ottawa, when does registration open there?',
    facts: OWN_TOWN_LINE,
    expect: 'other',
  },
  {
    id: 'intake-own-town-summer-camp',
    path: 'intake',
    text: 'when does summer camp registration open?',
    facts: OWN_TOWN_LINE,
    expect: 'other',
  },
  {
    id: 'intake-own-town-private-club',
    path: 'intake',
    text: 'when does Markham Skating Club registration open?',
    facts: OWN_TOWN_LINE,
    expect: 'other',
  },
  {
    id: 'intake-own-town-closes',
    path: 'intake',
    text: 'when does winter registration close?',
    facts: OWN_TOWN_LINE,
    expect: 'other',
  },
];
