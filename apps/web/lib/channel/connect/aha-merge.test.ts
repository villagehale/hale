import { describe, expect, it } from 'vitest';
import { type AhaSnapshot, emptyAha, failedAha, mergeAhaSnapshots } from './aha-read';

/**
 * VIL-721 · the one-link connect reads Gmail and the calendar on their own (each with
 * its own teen rule) and hands the model ONE snapshot. A merged `withheld` would skip
 * the kid filter (aha-kids.ts runs it on every `ok` read), so `withheld` is only ever
 * the read when there is no item left to filter.
 */

const CALENDAR_OK: AhaSnapshot = {
  provider: 'gcal',
  read: 'ok',
  calendar: [
    {
      title: 'Maya swim lesson',
      start: '2026-08-01T14:00:00.000Z',
      end: null,
      allDay: false,
      location: null,
      declined: false,
    },
  ],
  email: [],
  overlaps: [{ earlier: 'Maya swim lesson', later: 'Leo soccer' }],
};

const MAIL_OK: AhaSnapshot = {
  provider: 'gmail',
  read: 'ok',
  calendar: [],
  email: [
    {
      subject: 'Class trip form',
      fromName: 'School office',
      receivedAt: '2026-07-29T15:00:00.000Z',
      snippet: null,
    },
  ],
  overlaps: [],
};

const MAIL_WITHHELD: AhaSnapshot = { ...emptyAha('gmail'), read: 'withheld' };

describe('mergeAhaSnapshots', () => {
  it('is ok when either source read items, and keeps every item and overlap', () => {
    const merged = mergeAhaSnapshots([CALENDAR_OK, MAIL_OK]);
    expect(merged.provider).toBe('google');
    expect(merged.read).toBe('ok');
    expect(merged.calendar).toEqual(CALENDAR_OK.calendar);
    expect(merged.email).toEqual(MAIL_OK.email);
    expect(merged.overlaps).toEqual(CALENDAR_OK.overlaps);
  });

  it('is ok with one source empty', () => {
    expect(mergeAhaSnapshots([CALENDAR_OK, emptyAha('gmail')]).read).toBe('ok');
  });

  it('is empty when both sources read nothing', () => {
    expect(mergeAhaSnapshots([emptyAha('gcal'), emptyAha('gmail')]).read).toBe('empty');
  });

  it('is failed when a source failed and nothing was read', () => {
    expect(mergeAhaSnapshots([failedAha('gcal'), emptyAha('gmail')]).read).toBe('failed');
    expect(mergeAhaSnapshots([]).read).toBe('failed');
  });

  it('is withheld only when the teen rule withheld mail and no item is left', () => {
    expect(mergeAhaSnapshots([emptyAha('gcal'), MAIL_WITHHELD]).read).toBe('withheld');
  });

  it('is ok, not withheld, when the calendar has items, so the kid filter still runs on them', () => {
    expect(mergeAhaSnapshots([CALENDAR_OK, MAIL_WITHHELD]).read).toBe('ok');
  });
});
