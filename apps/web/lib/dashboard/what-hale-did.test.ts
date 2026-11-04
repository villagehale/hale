import { describe, expect, it } from 'vitest';
import type { HistoryView } from './history';
import { toWhatHaleDidItem } from './what-hale-did';

/**
 * One executed action as a "What Hale did" row. A placement always lands on Hale's own
 * family calendar, and on Google only when the executor recorded the Google write; the
 * dormant Google-only seam lands on Google alone; an email lands on no calendar.
 */

function view(over: Partial<HistoryView>): HistoryView {
  return {
    id: 'act-1',
    actionType: 'calendar_add',
    summary: 'verified by the reviewer — ready for your approval',
    preview: 'Add to your calendar — Swim lesson, Jun 21, 10:00',
    payload: { title: 'Swim lesson' },
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

describe('toWhatHaleDidItem', () => {
  it('reads a placement Google skipped as on Hale’s calendar only', () => {
    const item = toWhatHaleDidItem(view({}), {
      kind: 'calendar_placed',
      google: { status: 'skipped', reason: 'not_connected' },
    });
    expect(item).toEqual({
      id: 'act-1',
      kind: 'calendar',
      what: 'Add to your calendar — Swim lesson, Jun 21, 10:00',
      when: 'Jun 20, 09:00',
      calendars: ['hale_calendar'],
      teenRedacted: false,
    });
  });

  it('adds Google Calendar when the executor recorded the Google write', () => {
    const item = toWhatHaleDidItem(view({}), {
      kind: 'calendar_placed',
      google: { status: 'written', googleEventId: 'g-1' },
    });
    expect(item.calendars).toEqual(['hale_calendar', 'google_calendar']);
  });

  // A retried placement finds the Google event id Hale stored on its first write and
  // skips as already_present: the event is on Google, so the receipt still says so.
  it('keeps Google Calendar when a retry found Hale’s earlier Google write', () => {
    const item = toWhatHaleDidItem(view({}), {
      kind: 'calendar_placed',
      google: { status: 'skipped', reason: 'already_present' },
    });
    expect(item.calendars).toEqual(['hale_calendar', 'google_calendar']);
  });

  it('reads a placement with no executor detail as on Hale’s calendar only', () => {
    expect(toWhatHaleDidItem(view({ actionType: 'calendar_move' }), null).calendars).toEqual([
      'hale_calendar',
    ]);
  });

  it('puts an email on no calendar', () => {
    const item = toWhatHaleDidItem(
      view({ actionType: 'send_email', preview: 'Email coach@example.test — Practice moved' }),
      { kind: 'email_sent', google: { status: 'written' } },
    );
    expect(item.kind).toBe('email');
    expect(item.calendars).toEqual([]);
  });

  it('puts the Google-only event seam on Google Calendar alone', () => {
    expect(toWhatHaleDidItem(view({ actionType: 'create_calendar_event' }), null)).toMatchObject({
      kind: 'calendar',
      calendars: ['google_calendar'],
    });
  });
});
