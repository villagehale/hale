import { describe, expect, it } from 'vitest';
import { INTENT_FIXTURES } from './intake-fixtures.mjs';
import { SMS_CALENDAR_REVIEWER_FIXTURES } from './sms-calendar-reviewer-fixtures.mjs';

describe('SMS candidate eval fixtures', () => {
  it('has 50 unique reply-intent samples with a substantial false-assent battery', () => {
    expect(INTENT_FIXTURES).toHaveLength(50);
    expect(new Set(INTENT_FIXTURES.map((fixture) => fixture.id)).size).toBe(50);
    expect(new Set(INTENT_FIXTURES.map((fixture) => fixture.reply)).size).toBe(50);
    expect(INTENT_FIXTURES.filter((fixture) => fixture.falsePositive)).toHaveLength(20);

    const counts = Object.groupBy(INTENT_FIXTURES, (fixture) => fixture.expect);
    expect(counts.assent).toHaveLength(16);
    expect(counts.decline).toHaveLength(17);
    expect(counts.ambiguous).toHaveLength(17);
  });

  it('has 50 production-shaped SMS calendar reviewer samples', () => {
    expect(SMS_CALENDAR_REVIEWER_FIXTURES).toHaveLength(50);
    expect(new Set(SMS_CALENDAR_REVIEWER_FIXTURES.map((fixture) => fixture.id)).size).toBe(50);
    expect(
      new Set(SMS_CALENDAR_REVIEWER_FIXTURES.map((fixture) => JSON.stringify(fixture.draft))).size,
    ).toBe(50);

    const byAction = Object.groupBy(
      SMS_CALENDAR_REVIEWER_FIXTURES,
      (fixture) => fixture.draft.actionType,
    );
    expect(byAction.calendar_add).toHaveLength(18);
    expect(byAction.calendar_move).toHaveLength(16);
    expect(byAction.calendar_cancel).toHaveLength(16);

    for (const fixture of SMS_CALENDAR_REVIEWER_FIXTURES) {
      expect(fixture.draft.recipientVisibility).toBe('internal_only');
      expect(fixture.draft.payload.title).not.toBe('');
      expect(Date.parse(fixture.draft.payload.startsAt)).not.toBeNaN();
      expect(Date.parse(fixture.draft.payload.endsAt)).toBe(
        Date.parse(fixture.draft.payload.startsAt) + 60 * 60 * 1000,
      );
      if (fixture.draft.actionType !== 'calendar_add') {
        expect(fixture.draft.payload.reversalHandle).toMatch(/^[0-9a-f-]{36}$/);
      }

      const failures = Object.values(fixture.checkPolicy).filter((ok) => !ok);
      expect(failures).toHaveLength(fixture.expect === 'approve' ? 0 : 1);
    }
  });
});
