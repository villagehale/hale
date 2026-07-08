import { describe, expect, it } from 'vitest';
import { historyStatusTag, humanizeActionType, verdictTag } from './approval-format';

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

describe('historyStatusTag', () => {
  it('maps each resolved status to a distinct outcome chip — declined never reads as done', () => {
    expect(historyStatusTag('executed')).toEqual({ label: 'Done', tone: 'done' });
    expect(historyStatusTag('declined')).toEqual({ label: 'Declined', tone: 'neutral' });
    expect(historyStatusTag('reverted')).toEqual({ label: 'Reverted', tone: 'attention' });
    expect(historyStatusTag('held')).toEqual({ label: 'Held for you', tone: 'coach' });
    expect(historyStatusTag('failed')).toEqual({ label: "Couldn't complete", tone: 'attention' });
    // A declined outcome must never share the "Done" label.
    expect(historyStatusTag('declined').label).not.toBe(historyStatusTag('executed').label);
    // A failed execution must never read as a calm "held for you".
    expect(historyStatusTag('failed').label).not.toBe(historyStatusTag('held').label);
  });
});
