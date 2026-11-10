/**
 * Meaning-based fixtures for the signup offer writer (signup-offer.md).
 *
 * The model writes the parent-facing offer from facts Hale actually saw.
 * These fixtures are not imported by a CI runner, not listed in package.json,
 * and not a CI step. Scoring them would be a paid model call.
 * `signup-offer-eval.mjs --estimate` prices that call and does not make it.
 *
 * `mustMean` is what a judge would score. There is no expected sentence.
 */

export const SIGNUP_OFFER_FIXTURES = [
  {
    id: 'email-en-swim',
    facts: {
      source: 'email',
      evidence: 'Fall parent and tot swim opens Tuesday 4:30, forty dollars.',
      registrationUrl: 'https://harbor-rec.example/register',
      sessions: [
        {
          id: 'tue-1630',
          label: 'Tue 4:30',
          startsAt: '2026-11-03T20:30:00.000Z',
          endsAt: '2026-11-03T21:15:00.000Z',
          full: false,
          priceCents: 4000,
        },
      ],
      approvedPriceCents: 4000,
      childFirstName: 'Ada',
      language: 'en',
    },
    mustMean: [
      'offers to try signing up for the swim Hale saw in the email',
      'includes the registration URL exactly once',
      'names the Tuesday 4:30 session',
      'does not say anything is booked or paid',
      'does not tell the parent which word to type',
    ],
  },
  {
    id: 'calendar-fr-atelier',
    facts: {
      source: 'calendar',
      evidence: 'Atelier parent-bébé samedi 10 h, 40 $.',
      registrationUrl: 'https://harbor-rec.example/register',
      sessions: [
        {
          id: 'sat-1000',
          label: 'Sat 10:00',
          startsAt: '2026-11-07T14:00:00.000Z',
          endsAt: '2026-11-07T14:45:00.000Z',
          full: false,
          priceCents: 4000,
        },
      ],
      approvedPriceCents: 4000,
      childFirstName: null,
      language: 'fr',
    },
    mustMean: [
      'writes in French from the calendar evidence',
      'includes the registration URL exactly once',
      'names the Saturday session Hale saw',
      'does not say the place is reserved',
    ],
  },
  {
    id: 'flyer-zh',
    facts: {
      source: 'flyer',
      evidence: '亲子游泳 周二下午四点半 四十加元',
      registrationUrl: 'https://harbor-rec.example/register',
      sessions: [
        {
          id: 'tue-1630',
          label: 'Tue 4:30',
          startsAt: '2026-11-03T20:30:00.000Z',
          endsAt: '2026-11-03T21:15:00.000Z',
          full: false,
          priceCents: 4000,
        },
      ],
      approvedPriceCents: null,
      childFirstName: null,
      language: null,
    },
    mustMean: [
      'writes in the language of the flyer',
      'includes the registration URL exactly once',
      'does not invent a price the parent approved',
    ],
  },
  {
    id: 'chat-en',
    facts: {
      source: 'chat',
      evidence: 'can you try the harbor rec parent and tot on Tuesday 4:30',
      registrationUrl: 'https://harbor-rec.example/register',
      sessions: [
        {
          id: 'tue-1630',
          label: 'Tue 4:30',
          startsAt: '2026-11-03T20:30:00.000Z',
          endsAt: '2026-11-03T21:15:00.000Z',
          full: false,
          priceCents: 4000,
        },
      ],
      approvedPriceCents: 4000,
      childFirstName: 'Ada',
      language: 'en',
    },
    mustMean: [
      'answers the chat with an offer in Hale’s own words',
      'includes the registration URL exactly once',
      'says Hale will stop at checkout',
    ],
  },
];
