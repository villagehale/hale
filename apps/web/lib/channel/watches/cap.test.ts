import { describe, expect, it } from 'vitest';
import { liveWatchCapRefusal } from './cap';

describe('liveWatchCapRefusal', () => {
  it('is silent when there is no cap (flag off)', () => {
    expect(liveWatchCapRefusal(100, null)).toBeNull();
  });

  it('is silent while the household is under the cap', () => {
    expect(liveWatchCapRefusal(7, 8)).toBeNull();
    expect(liveWatchCapRefusal(0, 8)).toBeNull();
  });

  it('names the live count and the cap for the model when the cap is hit', () => {
    expect(liveWatchCapRefusal(8, 8)).toBe(
      'This household is already watching 8 classes, which is their cap of 8.',
    );
    expect(liveWatchCapRefusal(20, 20)).toContain('20');
  });

  it('is silent when the household already watches this class', () => {
    expect(liveWatchCapRefusal(8, 8, true)).toBeNull();
  });

  it('does not name a plan or an upgrade', () => {
    const sentence = liveWatchCapRefusal(8, 8) ?? '';
    expect(sentence).not.toMatch(/\b(plus|max|upgrade)\b/i);
    expect(sentence).not.toMatch(/\$/);
  });
});
