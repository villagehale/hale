import { describe, expect, it } from 'vitest';
import { asksHaleForSomething } from './request';

describe('telling Hale about the day vs asking Hale for something', () => {
  it('refuses to claim a request, with or without a question mark', () => {
    const asks = [
      'add swim to the calendar saturday 10am',
      'Fine - can you find a swim class on Saturdays?',
      'good day. please book the march break camp',
      'remind me about the forms tomorrow',
      'what time is the open house',
      'Sign us up for the Tuesday one',
      'peux tu trouver un cours de natation',
      'Book us into the thursday class',
    ];
    for (const body of asks) expect(asksHaleForSomething(body), body).toBe(true);
  });

  it('leaves an ordinary evening alone', () => {
    const evenings = [
      'Park after daycare and both asleep by 7. Rare win.',
      'Rough one, meltdown at dinner',
      'Swim was a hit, Leo wants to go back',
      'Nothing much, pyjama day',
      'Both of them ate dinner without a fight, call it a win',
      'Bonne journee, on a fait du velo',
    ];
    for (const body of evenings) expect(asksHaleForSomething(body), body).toBe(false);
  });
});
