import { describe, expect, it } from 'vitest';
import { smsEncoding, smsSegments } from '~/lib/channel/sms-segments';
import { caregiverReminderRenderer } from './index';
import { renderCaregiverReminderSms } from './reminder-sms';

/**
 * The body a caregiver actually reads. Pure — no DB, no clock of its own.
 *
 * The scope filter runs upstream, so these tests do NOT re-prove privacy; they prove the
 * copy is the shorter twin it claims to be (no approval ask, no /plan link, no quiet-week
 * invitation into a conversation the caregiver was promised they would be kept out of)
 * and that it stays inside the segment budget on the real shapes.
 */

describe('the caregiver reminder', () => {
  it('gives the time and where to be, and nothing about the child beyond the event', () => {
    expect(
      renderCaregiverReminderSms({
        offset: '-PT1H',
        timeZone: 'America/Toronto',
        events: [
          {
            eventRef: 'e1',
            title: 'Swim class',
            startsAt: '2026-07-25T20:15:00Z',
            location: 'Stouffville Public School',
          },
        ],
      }),
    ).toEqual({
      kind: 'sms',
      text: 'Sat, Jul 25 - Swim class at 4:15, Stouffville Public School',
    });
  });

  it("leads with the events' own day on the evening-before batch and lists both events", () => {
    const text = (
      renderCaregiverReminderSms({
        offset: '-P1D',
        timeZone: 'America/Toronto',
        events: [
          { eventRef: 'e1', title: 'Swim class', startsAt: '2026-07-25T20:15:00Z', location: null },
          { eventRef: 'e2', title: 'Soccer', startsAt: '2026-07-25T22:00:00Z', location: 'Memorial Park' },
        ],
      }) as { text: string }
    ).text;
    expect(text).toBe('Sat, Jul 25 - Swim class at 4:15, Soccer at 6:00, Memorial Park');
    expect(text).not.toMatch(/https?:\/\//);
  });

  it('holds two segments on a batch of many', () => {
    const events = Array.from({ length: 9 }, (_, i) => ({
      eventRef: `e${i}`,
      title: `Registration morning for the winter session ${i}`,
      startsAt: '2026-07-25T20:15:00Z',
      location: 'Stouffville Leisure Centre, 2 Park Drive',
    }));
    const text = (
      renderCaregiverReminderSms({ offset: '-P1D', timeZone: 'America/Toronto', events }) as {
        text: string;
      }
    ).text;
    expect(smsSegments(text)).toBeLessThanOrEqual(2);
    expect(smsEncoding(text)).toBe('gsm7');
  });
});

describe('the renderer refuses a leg a caregiver cannot receive', () => {
  const message = {
    templateKey: 'reminder:caregiver',
    familyId: 'f1',
    parentUserId: 'u1',
    category: 'reminder' as const,
    urgency: 'normal' as const,
    payload: {
      offset: '-PT1H',
      timeZone: 'UTC',
      events: [{ eventRef: 'e1', title: 'Swim class', startsAt: '2026-07-25T20:15:00Z', location: null }],
    },
  };

  it('throws on an email leg rather than rendering a shell for an address that does not exist', () => {
    expect(() => caregiverReminderRenderer.render(message, 'email', 'first_name')).toThrow(/sms only/);
  });

  it('renders the sms leg', () => {
    expect(caregiverReminderRenderer.render(message, 'sms', 'generic').kind).toBe('sms');
  });
});

describe('the broadcast header', () => {
  it('is gone from the caregiver text (docs/voice.md rule 2)', () => {
    // `Hale: ` is a broadcast header, and a caregiver who accepted an invite is in a
    // thread with Hale and knows who is texting. It survives in exactly one place —
    // party/guest-copy.ts, where the recipient has no way to know.
    const reminder = (
      renderCaregiverReminderSms({
        offset: '-PT1H',
        timeZone: 'America/Toronto',
        events: [
          { eventRef: 'e1', title: 'Swim class', startsAt: '2026-07-25T20:15:00Z', location: null },
        ],
      }) as { text: string }
    ).text;
    expect(reminder).not.toContain('Hale:');
    // Sentence case, not the lowercase that only read right after a label.
    expect(reminder[0]).toBe(reminder[0]?.toUpperCase());
  });
});
