/**
 * PLACEHOLDER household data. NOT real and NOT from any API. Coarse area only
 * (postal code drives discovery) — never a precise address (hard rule #1).
 */

export const FAMILY = {
  parents: [
    { id: 'you', name: 'Priya', email: 'priya@example.com', role: 'You' },
    { id: 'coparent', name: 'Sam', email: 'sam@example.com', role: 'Co-parent' },
  ],
  inviteLink: 'villagehale.app/join/AN4YA-2K6',
  children: [
    {
      id: 'anaya',
      name: 'Anaya',
      birthday: '2026-03-15',
      stage: 'Newborn',
      interests: 'Music, water play',
    },
    {
      id: 'theo',
      name: 'Theo',
      birthday: '2024-06-02',
      stage: 'Toddler',
      interests: 'Trucks, books',
    },
  ],
  postalCode: 'M5V 2T6',
  intents: ['Better sleep', 'More outdoor time', 'Meet nearby families'],
} as const;
