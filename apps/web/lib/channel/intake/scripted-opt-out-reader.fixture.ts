import type { OptOutReader, OptOutReading } from './opt-out-reader';

/**
 * #868 · the test stand-in for the opt-out reader, installed for every test by
 * vitest.setup.ts. Production has no word list: the model reads stop and start in any
 * wording. Tests need a deterministic reader, so this one knows the handful of words the
 * suites send. It is a fixture, never imported by production code.
 */
export const SCRIPTED_STOP_CONFIRMATION = 'Done, you will not hear from me again.';
export const SCRIPTED_START_CONFIRMATION = 'Welcome back, I am here again.';

const STOPS = new Set([
  'stop',
  'unsubscribe',
  'end',
  'quit',
  'cancel',
  'stopall',
  'optout',
  'opt-out',
  'revoke',
  'arret',
  'arrete',
  'arretez',
]);
const STARTS = new Set(['start', 'debut', 'unstop']);

function token(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, '')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '');
}

export function scriptedOptOutRead(text: string): OptOutReading {
  const word = token(text);
  if (STOPS.has(word) || /\b(?:stop texting|leave me alone)\b/i.test(text)) {
    return { intent: 'stop', confirmation: SCRIPTED_STOP_CONFIRMATION };
  }
  if (STARTS.has(word)) return { intent: 'start', confirmation: SCRIPTED_START_CONFIRMATION };
  return { intent: 'none', confirmation: '' };
}

export const scriptedOptOutReader: OptOutReader = {
  read: async (input) => scriptedOptOutRead(input.text),
};
