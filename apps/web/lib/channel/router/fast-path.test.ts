import { describe, expect, it } from 'vitest';
import { MAX_LISTED_APPROVALS } from './fast-path';

describe('the approval command shape', () => {
  it('still caps how many drafted actions a list can name', () => {
    expect(MAX_LISTED_APPROVALS).toBe(3);
  });
});
