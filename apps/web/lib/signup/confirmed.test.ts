import { describe, expect, it } from 'vitest';
import { confirmedOutcome } from './run';

describe('confirmedOutcome: never claim success without a confirmation', () => {
  it('downgrades completed without evidence to unconfirmed', () => {
    expect(confirmedOutcome({ outcome: 'completed' })).toEqual({
      outcome: 'unconfirmed',
      confirmed: false,
    });
  });
  it('keeps completed only with a confirmation page or a connector booking', () => {
    expect(confirmedOutcome({ outcome: 'completed', confirmation: { kind: 'page' } })).toEqual({
      outcome: 'completed',
      confirmed: true,
    });
    expect(
      confirmedOutcome({
        outcome: 'completed',
        confirmation: { kind: 'connector', connector: 'x' },
      }),
    ).toEqual({ outcome: 'completed', confirmed: true });
  });
  it('never marks a stop as confirmed', () => {
    expect(confirmedOutcome({ outcome: 'payment', confirmation: { kind: 'page' } })).toEqual({
      outcome: 'payment',
      confirmed: false,
    });
  });
});
