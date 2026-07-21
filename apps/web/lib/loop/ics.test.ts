import ical, { type VEvent } from 'node-ical';
import { describe, expect, it } from 'vitest';
import { type IcsEvent, generateFamilyIcs } from './ics.js';

const DTSTAMP = new Date('2026-07-21T00:00:00.000Z');

function event(overrides: Partial<IcsEvent> = {}): IcsEvent {
  return {
    id: 'ffffffff-1111-4111-8111-111111111111',
    title: 'Swim meet',
    startsAt: new Date('2026-07-22T14:30:00.000Z'),
    endsAt: new Date('2026-07-22T15:30:00.000Z'),
    location: 'Community pool',
    ...overrides,
  };
}

/** Parse with a real RFC-5545 parser and return the single VEVENT. */
function parseSingleEvent(ics: string): VEvent {
  const parsed = ical.sync.parseICS(ics);
  const events = Object.values(parsed).filter(
    (component): component is VEvent => component?.type === 'VEVENT',
  );
  expect(events).toHaveLength(1);
  return events[0] as VEvent;
}

describe('generateFamilyIcs — RFC 5545 validity', () => {
  it('produces a calendar that a real parser round-trips (UID, SUMMARY, DTSTART)', () => {
    const ev = event();
    const ics = generateFamilyIcs([ev], { now: DTSTAMP });

    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('VERSION:2.0');
    expect(ics).toContain('PRODID:');
    expect(ics).toContain('CALSCALE:GREGORIAN');

    const parsed = parseSingleEvent(ics);
    expect(parsed.uid).toBe(`${ev.id}@hale`);
    expect(parsed.summary).toBe('Swim meet');
    expect(parsed.start.toISOString()).toBe(ev.startsAt.toISOString());
    expect(parsed.end?.toISOString()).toBe(ev.endsAt?.toISOString());
    expect(parsed.location).toBe('Community pool');
  });

  it('emits DTSTART/DTEND/DTSTAMP in the RFC 5545 UTC form (…Z)', () => {
    const ics = generateFamilyIcs([event()], { now: DTSTAMP });
    expect(ics).toContain('DTSTART:20260722T143000Z');
    expect(ics).toContain('DTEND:20260722T153000Z');
    expect(ics).toContain('DTSTAMP:20260721T000000Z');
  });

  it('omits DTEND when the event has no end instant', () => {
    const ics = generateFamilyIcs([event({ endsAt: null })], { now: DTSTAMP });
    expect(ics).not.toContain('DTEND:');
    // The parser still accepts it as a valid point event.
    expect(parseSingleEvent(ics).start.toISOString()).toBe('2026-07-22T14:30:00.000Z');
  });

  it('uses CRLF line endings throughout and CRLF-terminates the calendar', () => {
    const ics = generateFamilyIcs([event()], { now: DTSTAMP });
    expect(ics).toContain('BEGIN:VCALENDAR\r\n');
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    // A bare LF that is not part of a CRLF would break strict clients.
    expect(ics.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('escapes comma, semicolon, and backslash in SUMMARY; the parser round-trips the raw text', () => {
    const raw = 'Swim; goggles, towel \\ mat';
    const ics = generateFamilyIcs([event({ title: raw })], { now: DTSTAMP });

    expect(ics).toContain('SUMMARY:Swim\\; goggles\\, towel \\\\ mat');
    expect(parseSingleEvent(ics).summary).toBe(raw);
  });

  it('folds a content line longer than 75 octets; no physical line exceeds 75 octets and the parser round-trips it', () => {
    const raw = 'A'.repeat(120);
    const ics = generateFamilyIcs([event({ title: raw, location: null })], { now: DTSTAMP });

    // The fold marker (CRLF + single space) appears.
    expect(ics).toContain('\r\n ');
    // Every physical line is within the 75-octet cap.
    for (const line of ics.split('\r\n')) {
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
    }
    // Folding is semantically transparent: the parser reassembles the full value.
    expect(parseSingleEvent(ics).summary).toBe(raw);
  });
});
