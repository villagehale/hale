/**
 * PLACEHOLDER newborn-family data for design/build. NOT real and NOT from any
 * API — every screen here is wired to mock values until the data layer lands.
 */

export const PLACEHOLDER = {
  rightNow: {
    label: 'Next feed',
    time: '~2:30pm',
    detail: 'Anaya last fed at 11:40am · 2h 50m ago',
  },
  children: [
    { name: 'Anaya', ageLabel: '3 mo', next: '4-month checkup in 3 days' },
    { name: 'Theo', ageLabel: '2 yr', next: 'Molars milestone window now' },
  ],
  village: {
    title: 'Riverdale Family Drop-in',
    meta: '0.8 km · open until 5pm',
    blurb: 'Free indoor play space, recommended by 4 nearby families.',
  },
} as const;
