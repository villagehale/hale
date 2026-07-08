import { describe, expect, it } from 'vitest';
import { humanizeActionType, verdictTag } from './approval-format';

describe('humanizeActionType', () => {
  it('de-snakes a raw action_type into a readable title (no DB enum surfaces)', () => {
    expect(humanizeActionType('place_supply_order')).toBe('Place supply order');
    expect(humanizeActionType('draft_email')).toBe('Draft email');
  });
});

describe('verdictTag', () => {
  it('maps known verdicts to their tag + tone', () => {
    expect(verdictTag('approved')).toEqual({ label: 'Reviewer approved', tone: 'done' });
    expect(verdictTag('rejected')).toEqual({ label: 'Reviewer flagged', tone: 'attention' });
    expect(verdictTag('pending')).toEqual({ label: 'Reviewing', tone: 'coach' });
  });

  it('falls back to a de-snaked neutral tag for an unknown verdict', () => {
    expect(verdictTag('needs_human')).toEqual({ label: 'needs human', tone: 'neutral' });
  });
});
