/**
 * PLACEHOLDER concierge content. NOT real and NOT from any API. The reply and
 * source are canned to demonstrate the chat + structured-source blend; framework
 * names (Karp / AAP / Health Canada) are illustrative, not medical guidance.
 */

export const STARTER_CHIPS = [
  'Why is Anaya fighting her afternoon nap?',
  'When do we start solids?',
  'Is Theo’s vocabulary on track?',
  'How do I handle the 4-month sleep regression?',
];

export const PLACEHOLDER_REPLY =
  'Around 3-4 months many babies hit a sleep regression as their sleep cycles mature. ' +
  'For Anaya’s afternoon nap, watch for tired cues about 75-90 minutes after she wakes, ' +
  'and keep the wind-down short and consistent. A predictable order — dim room, swaddle or ' +
  'sleep sack, a few minutes of calm — signals that sleep is coming. If she resists past one ' +
  'cycle, a brief reset before trying again often works better than pushing through.';

export type SourceCard = {
  framework: string;
  title: string;
  summary: string;
};

export const PLACEHOLDER_SOURCE: SourceCard = {
  framework: 'Karp · Happiest Baby',
  title: 'Wake windows & the 4-month shift',
  summary: 'Shorter, consistent wind-downs and earlier tired cues at 3-4 months.',
};
