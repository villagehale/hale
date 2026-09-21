import type { WeekPlanItem } from '@hale/db';
import { describe, expect, it } from 'vitest';
import { smsEncoding, smsSegments } from '~/lib/channel/sms-segments';
import { caregiverPlanRenderer, caregiverReminderRenderer } from './index';
import { renderCaregiverPlanSms } from './plan-sms';
import { renderCaregiverReminderSms } from './reminder-sms';

/**
 * The two bodies a caregiver actually reads. Pure — no DB, no clock of its own.
 *
 * The scope filter runs upstream, so these tests do NOT re-prove privacy; they prove the
 * copy is the shorter twin it claims to be (no approval ask, no /plan link, no quiet-week
 * invitation into a conversation the caregiver was promised they would be kept out of)
 * and that it stays inside the segment budget on the real shapes.
 */

function item(over: Partial<WeekPlanItem> = {}): WeekPlanItem {
  return {
    kind: 'routine',
    title: 'Gymnastics',
    childIds: ['c1'],
    startsAt: '2026-01-20T16:15',
    endsAt: null,
    location: null,
    sourceRef: null,
    needs: 'none',
    privacySensitive: false,
    ...over,
  };
}

describe('the caregiver week', () => {
  it('names the children and gives the day, the time, and the address', () => {
    const rendered = renderCaregiverPlanSms({
      weekStart: '2026-01-19',
      items: [
        item({ location: 'Stouffville Leisure Centre' }),
        item({ title: 'Preschool drop-off', childIds: ['c2'], startsAt: '2026-01-22T09:00' }),
      ],
      children: [
        { id: 'c1', name: 'Mia' },
        { id: 'c2', name: 'Leo' },
      ],
    });
    expect(rendered).toEqual({
      kind: 'sms',
      text:
        'This week for Mia and Leo - Tue 4:15 Gymnastics at Stouffville Leisure Centre - Thu 9:00 Preschool drop-off',
    });
  });

  it('says none of the four things the parents\' week says', () => {
    const text = (
      renderCaregiverPlanSms({
        weekStart: '2026-01-19',
        items: [item({ needs: 'calendar_add', startsAt: '2026-01-20T16:15' })],
        children: [{ id: 'c1', name: 'Mia' }],
      }) as { text: string }
    ).text;
    // A caregiver cannot approve a draft, has no account to open /plan with, and was
    // never offered the IDEAS conversation.
    expect(text).not.toMatch(/reply yes/i);
    expect(text).not.toMatch(/IDEAS/);
    expect(text).not.toMatch(/Full week/i);
    expect(text).not.toMatch(/https?:\/\//);
  });

  it('drops the day and time from a day-coarse item rather than inventing them', () => {
    const text = (
      renderCaregiverPlanSms({
        weekStart: '2026-01-19',
        items: [item({ title: 'Library visit', startsAt: null })],
        children: [{ id: 'c1', name: 'Mia' }],
      }) as { text: string }
    ).text;
    expect(text).toBe('This week for Mia - Library visit');
  });

  it('says "this week" with no name when nothing in scope concerns a child', () => {
    const text = (
      renderCaregiverPlanSms({
        weekStart: '2026-01-19',
        items: [item({ title: 'Family dinner', childIds: [] })],
        children: [],
      }) as { text: string }
    ).text;
    expect(text).toBe('This week - Tue 4:15 Family dinner');
  });

  it('holds three segments on a long week, keeping the nearest days and counting the rest', () => {
    const items = Array.from({ length: 14 }, (_, i) =>
      item({
        title: `Activity number ${i} with a long real registration title`,
        startsAt: `2026-01-${20 + (i % 5)}T1${i % 9}:00`,
        location: 'Stouffville Leisure Centre, 2 Park Drive',
      }),
    );
    const text = (
      renderCaregiverPlanSms({ weekStart: '2026-01-19', items, children: [{ id: 'c1', name: 'Mia' }] }) as {
        text: string;
      }
    ).text;
    expect(smsSegments(text)).toBeLessThanOrEqual(3);
    expect(smsEncoding(text)).toBe('gsm7');
    expect(text).toMatch(/\+\d+ more$/);
  });
});

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
      text: 'In an hour - Swim class at 4:15, Stouffville Public School',
    });
  });

  it('leads with "tomorrow" on the evening-before batch and lists both events', () => {
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
    expect(text).toBe('Tomorrow - Swim class at 4:15, Soccer at 6:00, Memorial Park');
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

describe('the renderers refuse a leg a caregiver cannot receive', () => {
  const message = {
    templateKey: 'weekly_plan:caregiver',
    familyId: 'f1',
    parentUserId: 'u1',
    category: 'weekly_plan' as const,
    urgency: 'normal' as const,
    payload: { weekStart: '2026-01-19', items: [item()], children: [{ id: 'c1', name: 'Mia' }] },
  };

  it('throws on an email leg rather than rendering a shell for an address that does not exist', () => {
    expect(() => caregiverPlanRenderer.render(message, 'email', 'first_name')).toThrow(/sms only/);
    expect(() =>
      caregiverReminderRenderer.render(
        { ...message, payload: { offset: '-PT1H', timeZone: 'UTC', events: [] } },
        'email',
        'first_name',
      ),
    ).toThrow(/sms only/);
  });

  it('renders the sms leg', () => {
    expect(caregiverPlanRenderer.render(message, 'sms', 'generic').kind).toBe('sms');
  });
});

describe('the broadcast header', () => {
  it('is gone from both caregiver texts (docs/voice.md rule 2)', () => {
    // `Hale: ` is a broadcast header, and a caregiver who accepted an invite is in a
    // thread with Hale and knows who is texting. It survives in exactly one place —
    // party/guest-copy.ts, where the recipient has no way to know.
    const week = (
      renderCaregiverPlanSms({
        weekStart: '2026-01-19',
        items: [item({ title: 'Library visit', startsAt: null })],
        children: [{ id: 'c1', name: 'Mia' }],
      }) as { text: string }
    ).text;
    const reminder = (
      renderCaregiverReminderSms({
        offset: '-PT1H',
        timeZone: 'America/Toronto',
        events: [
          { eventRef: 'e1', title: 'Swim class', startsAt: '2026-07-25T20:15:00Z', location: null },
        ],
      }) as { text: string }
    ).text;
    for (const text of [week, reminder]) {
      expect(text, text).not.toMatch(/^Hale:/);
      expect(text, text).not.toContain('Hale:');
      // Sentence case, not the lowercase that only read right after a label.
      expect(text[0], text).toBe(text[0]?.toUpperCase());
    }
  });
});
