import { describe, expect, it } from 'vitest';

import type { ActivityEvent, ToolCard } from './coach-fold';
import {
  cardsFromActivity,
  driveFileKind,
  formatAgendaRow,
  formatModified,
  notConnectedCopy,
} from './connector-card';

/**
 * The mobile connector-card mapper — the native mirror of the web
 * apps/web/lib/coach/connector-card.ts. Pure shaping only (no render). Expected
 * labels are derived from the spec, not copied from the code's output.
 */

describe('driveFileKind', () => {
  it('maps Workspace + common mimes to short labels, else "File"', () => {
    expect(driveFileKind('application/vnd.google-apps.spreadsheet')).toBe('Sheet');
    expect(driveFileKind('application/pdf')).toBe('PDF');
    expect(driveFileKind('image/jpeg')).toBe('Image');
    expect(driveFileKind('application/zip')).toBe('File');
  });
});

describe('formatModified', () => {
  it('formats an ISO date, empty for invalid', () => {
    expect(formatModified('2026-07-01T09:00:00Z', 'en-CA')).toBe('Jul 1, 2026');
    expect(formatModified('')).toBe('');
    expect(formatModified('nope')).toBe('');
  });
});

describe('formatAgendaRow', () => {
  it('renders a timed range and an all-day event', () => {
    // Noon UTC keeps the local calendar day 'Jul 11' across every plausible CI zone.
    const timed = formatAgendaRow('2026-07-11T12:00:00Z', '2026-07-11T13:30:00Z', 'en-CA');
    expect(timed.day).toBe('Sat, Jul 11');
    expect(timed.time).toMatch(/–/);

    const allDay = formatAgendaRow('2026-07-11', '2026-07-12', 'en-CA');
    expect(allDay.time).toBe('All day');
  });

  it('returns empty fields for an invalid start', () => {
    expect(formatAgendaRow('', '')).toEqual({ day: '', time: '' });
  });
});

describe('notConnectedCopy', () => {
  it('names the service + points to Settings', () => {
    expect(notConnectedCopy('gcal')).toEqual({
      service: 'Google Calendar',
      line: 'Connect Google Calendar in Settings to let Hale look here.',
    });
  });
});

describe('cardsFromActivity', () => {
  it('extracts only the activity entries that carry a card, in order', () => {
    const drive: ToolCard = { kind: 'drive', files: [] };
    const notConnected: ToolCard = { kind: 'not_connected', provider: 'gcal' };
    const activity: ActivityEvent[] = [
      { name: 'get_child_profile', ok: true, preview: 'x' },
      { name: 'drive_search', ok: true, preview: 'y', card: drive },
      { name: 'calendar_lookup', ok: true, preview: 'z', card: notConnected },
    ];
    expect(cardsFromActivity(activity)).toEqual([drive, notConnected]);
  });

  it('returns [] when no entry has a card', () => {
    const activity: ActivityEvent[] = [{ name: 'a', ok: true, preview: 'p' }];
    expect(cardsFromActivity(activity)).toEqual([]);
  });
});
