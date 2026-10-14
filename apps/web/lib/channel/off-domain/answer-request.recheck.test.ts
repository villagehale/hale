import { describe, expect, it } from 'vitest';
import { preSendReadApplies } from './answer-request';

describe('the pre-send read', () => {
  it('reads every draft, and a searched one only with notes', () => {
    expect(preSendReadApplies('not_needed', '')).toBe(true);
    expect(preSendReadApplies('missing_detail', '')).toBe(true);
    expect(preSendReadApplies('searched', '')).toBe(false);
    expect(preSendReadApplies('searched', 'n')).toBe(true);
  });
});
