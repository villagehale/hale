// rec-morning-topic eval fixtures (VIL-545 leftover). Every text here is a turn the
// model reads when REC_MORNING_MODEL_TOPIC_ENABLED is on — including dinner, which
// the word test would have dropped. The two pickup texts are the Nov 1 Preview proof's
// group and 1:1 turns, which the lane used to answer with the city's registration
// morning because they said "swim".

/** The eval's clock, fixed so each fixture's catalog (and its cache key) never move. */
export const REC_MORNING_TOPIC_NOW = '2026-11-08T14:00:00.000Z';

/** A family whose stored place resolves to Toronto. No postal. */
export const REC_MORNING_TOPIC_WHERE = {
  municipality: 'toronto',
  postal: null,
  timeZone: 'America/Toronto',
};

export const REC_MORNING_TOPIC_FIXTURES = [
  {
    id: 'group-loop-in-swim-pickup',
    path: 'group',
    text: "Hale, can you loop in Sam about Saturday's swim pickup? I can't make it.",
    expect: 'none',
  },
  {
    id: 'direct-loop-in-swim-pickup',
    path: 'direct',
    text: "Can you loop in Sam about Saturday's swim pickup?",
    expect: 'none',
  },
  {
    id: 'group-who-grabs-from-skate',
    path: 'group',
    text: 'can someone grab her from skate at 4? running late at work',
    expect: 'none',
  },
  {
    id: 'direct-swim-cancelled',
    path: 'direct',
    text: 'swim is cancelled this week, the pool is closed for repairs',
    expect: 'none',
  },
  {
    id: 'group-camp-went-well',
    path: 'group',
    text: 'camp was great today, she wants to go back tomorrow',
    expect: 'none',
  },
  {
    id: 'direct-dinner',
    path: 'direct',
    text: 'what time is dinner',
    expect: 'none',
  },
  {
    id: 'direct-when-swim-registration',
    path: 'direct',
    text: 'when does swim registration open?',
    expect: 'toronto_swim',
  },
  {
    id: 'group-rec-login',
    path: 'group',
    text: 'Hale, which site do we sign in on for fall rec programs?',
    expect: 'toronto_rec',
  },
  {
    id: 'direct-wishlist-frozen',
    path: 'direct',
    text: 'the wishlist page looks frozen, should I keep hitting refresh?',
    expect: 'toronto_wishlist',
  },
  {
    id: 'direct-pickup-and-registration',
    path: 'direct',
    text: 'can you loop in Sam about swim pickup? also when does winter swim registration open',
    expect: 'toronto_swim',
  },
  {
    id: 'direct-efun',
    path: 'direct',
    text: 'is efun still a thing?',
    expect: 'toronto_efun',
  },
];
