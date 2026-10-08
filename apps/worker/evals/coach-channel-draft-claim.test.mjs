import { describe, expect, it } from 'vitest';
import { claimsDraftAlreadyHappened } from './coach-channel-draft-claim.mjs';

describe('claimsDraftAlreadyHappened', () => {
  it('catches a draft reported as already sent', () => {
    expect(claimsDraftAlreadyHappened('That one went through.')).toBe(true);
    expect(claimsDraftAlreadyHappened('It went through, you are set.')).toBe(true);
  });

  it('does not catch reading the week', () => {
    expect(claimsDraftAlreadyHappened('I went through the week and Tiny Gym is Sundays at 9:30.')).toBe(
      false,
    );
  });

  it('does not catch the confirm question', () => {
    expect(claimsDraftAlreadyHappened('Add Tiny Gym Sundays at 9:30?')).toBe(false);
  });
});
