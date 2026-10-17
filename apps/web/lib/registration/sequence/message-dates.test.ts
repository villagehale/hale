import type { AgentClient } from '@hale/agent';
import { describe, expect, it, vi } from 'vitest';
import { structuredReply } from '~/lib/testing/structured-reply';
import { messageDatesMatch, verifyMessageDates } from './message-dates';

const expected = {
  date: '2026-08-12',
  time: '06:30',
  timeZone: 'America/Toronto',
  timePublished: true,
};
const text = 'mercredi 12 août à 6 h 30, heure de Toronto';
const parsed = {
  ...expected,
  weekday: 3,
  confidence: 'high' as const,
  evidence: { date: '12 août', time: '6 h 30', timeZone: 'heure de Toronto', weekday: 'mercredi' },
};

describe('natural registration date validation (mechanics, not model language quality)', () => {
  it('compares parsed values, not literal English or IANA spelling', () => {
    expect(messageDatesMatch(text, [parsed], expected)).toBe(true);
    expect(messageDatesMatch(text, [{ ...parsed, timeZone: 'America/New_York' }], expected)).toBe(
      true,
    );
  });
  it('accepts normalized facts with Arabic date, clock and zone evidence', () => {
    const message = 'يفتح التسجيل الأربعاء ١٢ أغسطس ٢٠٢٦ الساعة ٦:٣٠ صباحاً بتوقيت تورونتو';
    expect(
      messageDatesMatch(
        message,
        [
          {
            ...parsed,
            evidence: {
              date: '١٢ أغسطس ٢٠٢٦',
              time: '٦:٣٠ صباحاً',
              timeZone: 'بتوقيت تورونتو',
              weekday: 'الأربعاء',
            },
          },
        ],
        expected,
      ),
    ).toBe(true);
  });
  it('does not treat an unquoted, calendar-derived weekday as a weekday written to the parent', () => {
    const message = '12 août à 6 h 30, heure de Toronto';
    expect(
      messageDatesMatch(
        message,
        [{ ...parsed, evidence: { ...parsed.evidence, weekday: null } }],
        expected,
      ),
    ).toBe(true);
    expect(messageDatesMatch(text, [{ ...parsed, weekday: 4 }], expected)).toBe(false);
  });
  it.each([
    { ...parsed, date: '2026-08-13' },
    { ...parsed, time: '07:30' },
    { ...parsed, timeZone: 'Europe/London' },
    { ...parsed, timeZone: null, evidence: { ...parsed.evidence, timeZone: null } },
    { ...parsed, weekday: 4 },
    { ...parsed, confidence: 'low' as const },
    { ...parsed, evidence: { ...parsed.evidence, date: 'not in the message' } },
  ])('holds wrong, missing or unsupported date facts: %j', (actual) => {
    expect(messageDatesMatch(text, [actual], expected)).toBe(false);
  });
  it('preserves date-only precision and refuses an invented hour or an unsupported date', () => {
    const dateOnly = { ...parsed, time: null, evidence: { ...parsed.evidence, time: null } };
    expect(messageDatesMatch(text, [dateOnly], { ...expected, time: null })).toBe(true);
    expect(messageDatesMatch(text, [parsed], { ...expected, time: null })).toBe(false);
    expect(messageDatesMatch(text, [parsed], null)).toBe(false);
    expect(messageDatesMatch('Date unconfirmed.', [], null)).toBe(true);
  });
  it('rejects an extra unbacked opening while allowing a separately published tier', () => {
    const other = {
      ...parsed,
      date: '2026-08-13',
      weekday: 4,
      evidence: { ...parsed.evidence, date: '13 août', weekday: 'jeudi' },
    };
    const both = `${text}; jeudi 13 août à 6 h 30, heure de Toronto`;
    expect(messageDatesMatch(both, [parsed, other], expected)).toBe(false);
    expect(
      messageDatesMatch(both, [parsed, other], expected, [{ ...expected, date: '2026-08-13' }]),
    ).toBe(true);
  });
  it('does not hand expected dates or timezone to the independent parser', async () => {
    const message = 'Ouverture à la date publiée.';
    const create = vi.fn(async (req) =>
      structuredReply(req, 'registration_message_dates', { openings: [] }),
    );
    expect(
      await verifyMessageDates(message, new Date('2026-07-01T12:00Z'), expected, [], {
        messages: { create },
      } as unknown as AgentClient),
    ).toBe(false);
    const wire = JSON.parse(create.mock.calls[0]![0].messages[0].content);
    expect(wire).toEqual({ message, now: '2026-07-01T12:00:00.000Z' });
    expect(JSON.stringify(wire)).not.toContain(expected.date);
    expect(JSON.stringify(wire)).not.toContain(expected.timeZone);
  });
});
