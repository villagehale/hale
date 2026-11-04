import { describe, expect, it } from 'vitest';
import type { HistoryView } from './history';
import { TEEN_REDACTED_PLACEHOLDER } from './mappers';
import { type FamilyClock, toWhatHaleDidItem } from './what-hale-did';

/**
 * One executed action as a "What Hale did" row: a past-tense receipt naming where it
 * landed, and one time line in the family's own zone and locale. A placement always
 * lands on Hale's own family calendar, and on Google only when the executor recorded
 * the Google write; the dormant Google-only seam lands on Google alone; an email lands
 * on no calendar.
 *
 * Every expected time below is worked by hand from the instant and the zone (June is
 * PDT, UTC−7) and from the locale's own clock: en-CA and en-US read 12-hour, en-GB
 * 24-hour. The clock is passed in, so a same-year date carries no year.
 */

const NOW = new Date('2026-07-01T12:00:00Z');
const VANCOUVER_CA: FamilyClock = { timeZone: 'America/Vancouver', locale: 'en-CA' };
const EXECUTED = new Date('2026-06-20T16:00:00Z');

function view(over: Partial<HistoryView>): HistoryView {
  return {
    id: 'act-1',
    actionType: 'calendar_add',
    summary: 'verified by the reviewer',
    preview: 'Add to your calendar — Swim lesson, Jun 21, 10:00',
    payload: { title: 'Swim lesson', startsAt: '2026-06-21T17:00:00Z' },
    childId: null,
    childLabel: null,
    verdict: 'approved',
    draftedAt: 'Jun 20, 08:00',
    teenRedacted: false,
    teenUnlockable: false,
    status: 'executed',
    resolvedAt: 'Jun 20, 09:00',
    undoable: false,
    ...over,
  };
}

const item = (
  over: Partial<HistoryView>,
  executorResult: Record<string, unknown> | null = null,
  clock: FamilyClock = VANCOUVER_CA,
) => toWhatHaleDidItem(view(over), EXECUTED, executorResult, true, clock, NOW);

describe('toWhatHaleDidItem', () => {
  it('reads a placement Google skipped as a receipt on Hale’s calendar only', () => {
    expect(
      item({}, { kind: 'calendar_placed', google: { status: 'skipped', reason: 'not_connected' } }),
    ).toEqual({
      id: 'act-1',
      kind: 'calendar',
      what: 'Added Swim lesson to Family calendar',
      // 17:00Z is 10:00 PDT on Sunday Jun 21; 16:00Z is 09:00 PDT on Jun 20.
      when: 'Sun, Jun 21, 10:00 a.m. · done Jun 20, 9:00 a.m.',
      calendars: ['hale_calendar'],
      teenRedacted: false,
    });
  });

  it('names Google Calendar when the executor recorded the Google write', () => {
    const placed = item({}, { kind: 'calendar_placed', google: { status: 'written' } });
    expect(placed.calendars).toEqual(['hale_calendar', 'google_calendar']);
    expect(placed.what).toBe('Added Swim lesson to Family calendar and Google Calendar');
  });

  // A retried placement finds the Google event id Hale stored on its first write and
  // skips as already_present: the event is on Google, so the receipt still says so.
  it('keeps Google Calendar when a retry found Hale’s earlier Google write', () => {
    expect(
      item(
        {},
        { kind: 'calendar_placed', google: { status: 'skipped', reason: 'already_present' } },
      ).calendars,
    ).toEqual(['hale_calendar', 'google_calendar']);
  });

  it('reads a move and a cancel in the past tense, on Hale’s calendar', () => {
    expect(item({ actionType: 'calendar_move' })).toMatchObject({
      what: 'Moved Swim lesson on Family calendar',
      calendars: ['hale_calendar'],
    });
    expect(item({ actionType: 'calendar_cancel' }).what).toBe(
      'Removed Swim lesson from Family calendar',
    );
  });

  it('reads a sent email by its recipient and subject, with its sent time', () => {
    const sent = item(
      {
        actionType: 'send_email',
        preview: 'Email office@example.test — Thursday pickup',
        payload: { to: 'office@example.test', subject: 'Thursday pickup' },
      },
      { kind: 'email_sent', google: { status: 'written' } },
    );
    expect(sent).toMatchObject({
      kind: 'email',
      what: 'Emailed office@example.test about Thursday pickup',
      when: 'Sent Jun 20, 9:00 a.m.',
      calendars: [],
    });
  });

  it('reads a reply as replied, and an email stripped of its fields as sent', () => {
    expect(
      item({
        actionType: 'reply_to_email',
        payload: { to: 'coach@example.test', subject: 'Practice moved' },
      }).what,
    ).toBe('Replied to coach@example.test about Practice moved');
    expect(item({ actionType: 'send_email', payload: {} }).what).toBe('Sent an email');
  });

  // An email leaves from one adult's own Gmail. Anyone else sees that Hale sent one,
  // and when, never to whom or about what. The sender's own reads above are the control.
  it('reads another adult’s email as the bare receipt with its sent time', () => {
    const fromOther = (actionType: string) =>
      toWhatHaleDidItem(
        view({
          actionType,
          preview: 'Email office@example.test — Thursday pickup',
          payload: { to: 'office@example.test', subject: 'Thursday pickup' },
        }),
        EXECUTED,
        { kind: 'email_sent' },
        false,
        VANCOUVER_CA,
        NOW,
      );
    expect(fromOther('send_email')).toMatchObject({
      what: 'Sent an email',
      when: 'Sent Jun 20, 9:00 a.m.',
    });
    expect(fromOther('reply_to_email').what).toBe('Replied to an email');
    expect(JSON.stringify(fromOther('send_email'))).not.toMatch(/office@|Thursday pickup/);
  });

  // Calendar changes land on the family calendar, which every parent shares.
  it('keeps a calendar receipt whole whoever views it', () => {
    expect(toWhatHaleDidItem(view({}), EXECUTED, null, false, VANCOUVER_CA, NOW).what).toBe(
      'Added Swim lesson to Family calendar',
    );
  });

  it('puts the Google-only event seam on Google Calendar alone', () => {
    expect(item({ actionType: 'create_calendar_event' })).toMatchObject({
      kind: 'calendar',
      what: 'Added Swim lesson to Google Calendar',
      calendars: ['google_calendar'],
    });
  });

  it('shows only the done time when the placement carries no start', () => {
    expect(item({ payload: { title: 'Swim lesson' } }).when).toBe('Done Jun 20, 9:00 a.m.');
  });

  // The teen row keeps the placeholder, and its event's own time is withheld with the
  // rest of its payload; only when Hale acted shows.
  it('keeps a 13+ child’s row to the placeholder and the done time', () => {
    const redacted = item({
      preview: TEEN_REDACTED_PLACEHOLDER,
      payload: null,
      teenRedacted: true,
    });
    expect(redacted.what).toBe(TEEN_REDACTED_PLACEHOLDER);
    expect(redacted.when).toBe('Done Jun 20, 9:00 a.m.');
    expect(redacted.teenRedacted).toBe(true);
  });

  it('reads the clock in the family’s own locale: 12-hour en-US, 24-hour en-GB', () => {
    expect(item({}, null, { timeZone: 'America/Vancouver', locale: 'en-US' }).when).toBe(
      'Sun, Jun 21, 10:00 AM · done Jun 20, 9:00 AM',
    );
    // An afternoon instant, so the 24-hour clock shows: 22:15Z is 15:15 PDT.
    expect(
      toWhatHaleDidItem(
        view({}),
        new Date('2026-06-20T22:15:00Z'),
        null,
        true,
        { timeZone: 'America/Vancouver', locale: 'en-GB' },
        NOW,
      ).when,
    ).toBe('Sun 21 Jun, 10:00 · done 20 Jun, 15:15');
  });

  it('carries the year on a receipt from another year', () => {
    expect(
      toWhatHaleDidItem(
        view({ actionType: 'send_email', payload: { to: 'office@example.test' } }),
        new Date('2025-12-01T17:00:00Z'),
        null,
        true,
        VANCOUVER_CA,
        NOW,
      ).when,
    ).toBe('Sent Dec 1, 2025, 9:00 a.m.');
  });
});
