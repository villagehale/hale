import { describe, expect, it } from 'vitest';
import { CALENDAR_CONSENT_CONFIDENCE, settleCalendarConsent } from './calendar-consent';

describe('settleCalendarConsent', () => {
  const reply = 'Yes, put the kids’ stuff on my calendar';

  it('keeps a yes that echoes the reply and clears the floor', () => {
    expect(
      settleCalendarConsent(
        { label: 'yes', verbatim: reply, confidence: CALENDAR_CONSENT_CONFIDENCE },
        reply,
      ),
    ).toBe('yes');
  });

  it('drops a yes that paraphrases or is unsure', () => {
    expect(settleCalendarConsent({ label: 'yes', verbatim: 'yes', confidence: 0.9 }, reply)).toBe(
      'other',
    );
    expect(settleCalendarConsent({ label: 'yes', verbatim: reply, confidence: 0.69 }, reply)).toBe(
      'other',
    );
  });

  it('keeps a settled no or other', () => {
    expect(settleCalendarConsent({ label: 'no', verbatim: reply, confidence: 0.2 }, reply)).toBe(
      'no',
    );
    expect(
      settleCalendarConsent({ label: 'other', verbatim: 'not the reply', confidence: 0.9 }, reply),
    ).toBe('other');
  });
});
