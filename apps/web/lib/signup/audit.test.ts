import { describe, expect, it } from 'vitest';
import { redactSignupAudit } from './audit';

describe('redactSignupAudit', () => {
  it('keeps the step and drops names, emails, and phone numbers', () => {
    const redacted = redactSignupAudit({
      step: 'fill',
      offerId: 'offer-1',
      activityKey: 'swim-parent-tot',
      sessionId: 'tue-1630',
      reason: 'payment',
      fieldsFilled: ['child_first_name', 'parent_email'],
      email: 'ada@example.test',
      childFirstName: 'Ada',
      parentPhone: '+14165550123',
      postalCode: 'M5V 2T6',
      note: 'wrote ada@example.test and +14165550199',
    });
    const text = JSON.stringify(redacted);
    expect(text).not.toContain('Ada');
    expect(text).not.toContain('ada@');
    expect(text).not.toContain('416');
    expect(text).not.toContain('M5V');
    expect(redacted).toMatchObject({
      step: 'fill',
      offerId: 'offer-1',
      activityKey: 'swim-parent-tot',
      sessionId: 'tue-1630',
      reason: 'payment',
      fieldsFilled: ['child_first_name', 'parent_email'],
      note: '[redacted]',
    });
  });
});
