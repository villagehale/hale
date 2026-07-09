import { describe, expect, it } from 'vitest';
import { driveFileKind, formatAgendaRow, formatModified, notConnectedCopy } from './connector-card';

/**
 * Pure card-display shaping — mime → label, ISO → friendly date/time, all-day vs
 * timed agenda rows, the not-connected copy. Values are derived from the spec (the
 * expected labels), not copied from the code's output.
 */

describe('driveFileKind', () => {
  it('maps Google Workspace + common mimes to short labels', () => {
    expect(driveFileKind('application/vnd.google-apps.document')).toBe('Doc');
    expect(driveFileKind('application/vnd.google-apps.spreadsheet')).toBe('Sheet');
    expect(driveFileKind('application/vnd.google-apps.folder')).toBe('Folder');
    expect(driveFileKind('application/pdf')).toBe('PDF');
    expect(driveFileKind('image/png')).toBe('Image');
    expect(driveFileKind('video/mp4')).toBe('Video');
  });

  it('falls back to "File" for an unmapped mime rather than dumping the raw type', () => {
    expect(driveFileKind('application/x-weird-thing')).toBe('File');
  });
});

describe('formatModified', () => {
  it('formats an ISO timestamp as a friendly date', () => {
    expect(formatModified('2026-07-01T09:00:00Z', 'en-CA')).toBe('Jul 1, 2026');
  });

  it('returns empty string for a missing or invalid value (no "Invalid Date")', () => {
    expect(formatModified('')).toBe('');
    expect(formatModified('not-a-date')).toBe('');
  });
});

describe('formatAgendaRow', () => {
  it('renders a timed event as a day + start–end range', () => {
    // Noon UTC so the local calendar day is 'Jul 11' across every plausible CI zone
    // (UTC-11 … UTC+12), keeping the exact-day assertion timezone-robust.
    const row = formatAgendaRow('2026-07-11T12:00:00Z', '2026-07-11T13:30:00Z', 'en-CA');
    expect(row.day).toBe('Sat, Jul 11');
    // A range with an en-dash separator; both endpoints present.
    expect(row.time).toMatch(/–/);
    expect(row.time.split('–')).toHaveLength(2);
  });

  it('renders an all-day event (date-only, no time component) as "All day"', () => {
    const row = formatAgendaRow('2026-07-11', '2026-07-12', 'en-CA');
    expect(row.day).toBe('Sat, Jul 11');
    expect(row.time).toBe('All day');
  });

  it('renders a start-only timed event with no range when the end is absent', () => {
    const row = formatAgendaRow('2026-07-11T09:00:00Z', '', 'en-CA');
    expect(row.time).not.toMatch(/–/);
    expect(row.time.length).toBeGreaterThan(0);
  });

  it('returns empty fields for an invalid start (the row still renders its title)', () => {
    expect(formatAgendaRow('', '')).toEqual({ day: '', time: '' });
    expect(formatAgendaRow('nonsense', '2026-07-11T10:00:00Z')).toEqual({ day: '', time: '' });
  });
});

describe('notConnectedCopy', () => {
  it('names the service and points to Settings', () => {
    expect(notConnectedCopy('gdrive')).toEqual({
      service: 'Google Drive',
      line: 'Connect Google Drive in Settings to let Hale look here.',
    });
    expect(notConnectedCopy('gcal').service).toBe('Google Calendar');
  });
});
