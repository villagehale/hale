import { describe, expect, it } from 'vitest';
import { zonedMidnight } from '~/lib/memory/period';
import {
  classifyCalendarMirrorItem,
  knownEventCovers,
  normalizeMirrorTitle,
} from './calendar-mirror';

const NOW = new Date('2026-10-03T16:00:00.000Z');
const TZ = 'America/Toronto';
const LATER = '2026-10-04T15:00:00.000Z';

function item(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ev-swim',
    status: 'confirmed',
    summary: 'Swim',
    start: { dateTime: LATER },
    end: { dateTime: '2026-10-04T16:00:00.000Z' },
    ...overrides,
  };
}

describe('classifyCalendarMirrorItem', () => {
  it('hands the description to the notes reader in memory, and reads no facts itself (VIL-468)', () => {
    const classified = classifyCalendarMirrorItem(
      item({ description: '  Coach notes here.\nParking: Lot B  ' }),
      NOW,
      TZ,
    );
    expect(classified).toMatchObject({
      kind: 'eligible',
      candidate: { description: 'Coach notes here.\nParking: Lot B' },
    });
    expect(classified.kind === 'eligible' && 'notes' in classified.candidate).toBe(false);
    const plain = classifyCalendarMirrorItem(item(), NOW, TZ);
    expect(plain.kind === 'eligible' && 'description' in plain.candidate).toBe(false);
  });

  it.each([
    ['no one else on it', {}, 'own'],
    ['only the parent on it', { attendees: [{ self: true, responseStatus: 'accepted' }] }, 'own'],
    [
      'the parent organized it',
      {
        organizer: { self: true },
        attendees: [{ self: true }, { email: 'a@example.test', responseStatus: 'needsAction' }],
      },
      'organizer',
    ],
    [
      "the parent accepted someone else's invite",
      {
        organizer: { email: 'a@example.test' },
        attendees: [{ self: true, responseStatus: 'accepted' }, { email: 'a@example.test' }],
      },
      'accepted',
    ],
    [
      "someone else's invite, unanswered",
      {
        organizer: { email: 'a@example.test' },
        attendees: [{ self: true, responseStatus: 'needsAction' }, { email: 'a@example.test' }],
      },
      'invited',
    ],
    [
      "someone else's invite, tentative",
      {
        organizer: { email: 'a@example.test' },
        attendees: [{ self: true, responseStatus: 'tentative' }, { email: 'a@example.test' }],
      },
      'invited',
    ],
    [
      'other people on it and no answer from the parent at all',
      { organizer: { email: 'a@example.test' }, attendees: [{ email: 'a@example.test' }] },
      'invited',
    ],
  ])('reads where the parent stands when %s (VIL-633)', (_name, overrides, standing) => {
    expect(classifyCalendarMirrorItem(item(overrides), NOW, TZ)).toMatchObject({
      kind: 'eligible',
      candidate: { standing },
    });
  });

  it('keeps a timed event the parent has not declined', () => {
    const classified = classifyCalendarMirrorItem(item(), NOW, TZ);
    expect(classified).toMatchObject({
      kind: 'eligible',
      candidate: {
        eventId: 'ev-swim',
        title: 'Swim',
        startsAt: new Date(LATER),
        location: null,
      },
    });
  });

  it('skips a decline, a cancellation, a past start, and a missing id', () => {
    expect(
      classifyCalendarMirrorItem(
        item({
          attendees: [{ self: true, responseStatus: 'declined' }],
        }),
        NOW,
        TZ,
      ),
    ).toMatchObject({ kind: 'skip', reason: 'declined' });
    expect(classifyCalendarMirrorItem(item({ status: 'cancelled' }), NOW, TZ)).toMatchObject({
      kind: 'skip',
      reason: 'cancelled',
    });
    expect(
      classifyCalendarMirrorItem(
        item({ start: { dateTime: '2026-10-01T15:00:00.000Z' } }),
        NOW,
        TZ,
      ),
    ).toMatchObject({ kind: 'skip', reason: 'past' });
    expect(classifyCalendarMirrorItem(item({ id: '' }), NOW, TZ)).toMatchObject({
      kind: 'skip',
      reason: 'no_id',
    });
  });

  it('skips busy blocks and keeps an all-day occasion', () => {
    expect(classifyCalendarMirrorItem(item({ eventType: 'outOfOffice' }), NOW, TZ)).toMatchObject({
      kind: 'skip',
      reason: 'busy_block',
    });
    expect(classifyCalendarMirrorItem(item({ eventType: 'focusTime' }), NOW, TZ)).toMatchObject({
      kind: 'skip',
      reason: 'busy_block',
    });
    expect(
      classifyCalendarMirrorItem(
        item({
          summary: 'Busy',
          start: { date: '2026-10-05' },
          end: { date: '2026-10-06' },
        }),
        NOW,
        TZ,
      ),
    ).toMatchObject({ kind: 'skip', reason: 'busy_block' });
    expect(
      classifyCalendarMirrorItem(
        item({
          summary: '',
          start: { date: '2026-10-05' },
          end: { date: '2026-10-06' },
        }),
        NOW,
        TZ,
      ),
    ).toMatchObject({ kind: 'skip', reason: 'busy_block' });

    const day = classifyCalendarMirrorItem(
      item({
        id: 'ev-pa',
        summary: 'PA day',
        start: { date: '2026-10-05' },
        end: { date: '2026-10-06' },
      }),
      NOW,
      TZ,
    );
    expect(day).toMatchObject({
      kind: 'eligible',
      candidate: {
        eventId: 'ev-pa',
        title: 'PA day',
        startsAt: zonedMidnight('2026-10-05', TZ),
      },
    });
  });

  it('stores a generic title when the summary contains an address, and drops that location', () => {
    const classified = classifyCalendarMirrorItem(
      item({ summary: 'Meet sam@school.com', location: 'room@hall' }),
      NOW,
      TZ,
    );
    expect(classified).toMatchObject({
      kind: 'eligible',
      candidate: { title: 'Something on your calendar', location: null },
    });
    if (classified.kind === 'eligible') {
      expect(classified.candidate.title.includes('@')).toBe(false);
    }
  });
});

describe('knownEventCovers', () => {
  const candidate = {
    eventId: 'ev-swim',
    title: 'Swim.',
    startsAt: new Date(LATER),
    endsAt: null,
    location: null,
    standing: 'own' as const,
  };

  it('matches a Hale row with the same title and a start within a minute', () => {
    expect(normalizeMirrorTitle('Swim.')).toBe('swim');
    expect(
      knownEventCovers(candidate, {
        title: '  swim ',
        startsAt: new Date(new Date(LATER).getTime() + 30_000),
      }),
    ).toBe(true);
    expect(
      knownEventCovers(candidate, {
        title: 'Swim',
        startsAt: new Date(new Date(LATER).getTime() + 120_000),
      }),
    ).toBe(false);
    expect(knownEventCovers(candidate, { title: 'Piano', startsAt: new Date(LATER) })).toBe(false);
  });
});
