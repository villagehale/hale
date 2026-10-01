import { describe, expect, it } from 'vitest';
import {
  MID_ACTIVITY_ASK_TODO,
  MID_ACTIVITY_REPLY_TODO,
  midActivityCopyMayLeave,
  replyEndsWithOneNextStep,
} from './copy';

describe('mid-activity copy', () => {
  it('keeps both lines as design placeholders that end in one next step', () => {
    for (const line of [MID_ACTIVITY_ASK_TODO, MID_ACTIVITY_REPLY_TODO]) {
      expect(line.startsWith('TODO-Design:')).toBe(true);
      expect(replyEndsWithOneNextStep(line)).toBe(true);
      expect(midActivityCopyMayLeave(line)).toBe(false);
      expect(line).not.toMatch(/\bSTOP\b|unsubscribe|opt[- ]out/i);
    }
  });

  it('refuses a locked line that opts the parent out or has two next steps', () => {
    expect(midActivityCopyMayLeave('How is swim going? Next: one line is enough.')).toBe(true);
    expect(
      midActivityCopyMayLeave('How is swim going? Next: one line. Reply STOP to opt out.'),
    ).toBe(false);
    expect(midActivityCopyMayLeave('How is swim going? Next: one line. Next: another line.')).toBe(
      false,
    );
    expect(midActivityCopyMayLeave('How is swim going?')).toBe(false);
  });
});
