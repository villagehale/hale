import ical, { type VEvent } from 'node-ical';
import { describe, expect, it } from 'vitest';
import {
  type IcsEvent,
  type IcsInviteEvent,
  generateEventCancel,
  generateEventInvite,
  generateEventPublish,
  generateFamilyIcs,
} from './ics.js';

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

// ── Per-event invites (VIL-249 · M13) ────────────────────────────────────────

const EVENT_ID = 'aaaaaaaa-2222-4222-8222-222222222222';
const INVITE_OPTIONS = {
  organizerEmail: 'aloha@villagehale.com',
  organizerName: 'Hale',
  attendeeEmail: 'parent@example.com',
  now: DTSTAMP,
} as const;

function invite(overrides: Partial<IcsInviteEvent> = {}): IcsInviteEvent {
  return {
    id: EVENT_ID,
    summary: 'Swim meet',
    startsAt: new Date('2026-07-22T14:30:00.000Z'),
    endsAt: new Date('2026-07-22T15:30:00.000Z'),
    location: 'Community pool',
    description: null,
    sequence: 0,
    ...overrides,
  };
}

describe('generateEventInvite — RFC 5545/5546 REQUEST', () => {
  it('carries METHOD:REQUEST, ORGANIZER, ATTENDEE and STATUS:CONFIRMED', () => {
    const ics = generateEventInvite(invite(), INVITE_OPTIONS);

    expect(ics).toContain('METHOD:REQUEST');
    expect(ics).toContain('ORGANIZER;CN=Hale:mailto:aloha@villagehale.com');
    expect(ics).toContain('mailto:parent@example.com');
    expect(ics).toContain('STATUS:CONFIRMED');
    expect(ics).not.toContain('STATUS:CANCELLED');

    const parsed = parseSingleEvent(ics);
    expect(parsed.summary).toBe('Swim meet');
    expect(parsed.location).toBe('Community pool');
  });

  it('uses the SAME stable UID as the subscription feed, so an invite supersedes rather than duplicates', () => {
    const feedUid = parseSingleEvent(
      generateFamilyIcs([event({ id: EVENT_ID })], { now: DTSTAMP }),
    ).uid;

    expect(parseSingleEvent(generateEventInvite(invite(), INVITE_OPTIONS)).uid).toBe(feedUid);
  });

  it('keeps the UID identical across regenerations that differ in time, revision and content', () => {
    const first = parseSingleEvent(generateEventInvite(invite(), INVITE_OPTIONS)).uid;
    const second = parseSingleEvent(
      generateEventInvite(
        invite({ sequence: 7, summary: 'Swim meet — moved', startsAt: new Date('2026-08-01T18:00:00.000Z') }),
        { ...INVITE_OPTIONS, now: new Date('2026-07-30T09:00:00.000Z') },
      ),
    ).uid;

    expect(second).toBe(first);
  });

  it('emits the supplied SEQUENCE, so a later revision supersedes the earlier one', () => {
    expect(generateEventInvite(invite({ sequence: 0 }), INVITE_OPTIONS)).toContain('SEQUENCE:0');
    expect(generateEventInvite(invite({ sequence: 3 }), INVITE_OPTIONS)).toContain('SEQUENCE:3');
  });

  it('renders DTSTART/DTEND as absolute UTC instants, correct on both sides of a DST boundary', () => {
    // America/Toronto switches to EDT on 2026-03-08. 09:00 local is 14:00Z under EST
    // (UTC-5) the week before, and 13:00Z under EDT on the transition day itself.
    const beforeDst = generateEventInvite(
      invite({ startsAt: new Date('2026-03-01T14:00:00.000Z'), endsAt: null }),
      INVITE_OPTIONS,
    );
    const afterDst = generateEventInvite(
      invite({ startsAt: new Date('2026-03-08T13:00:00.000Z'), endsAt: null }),
      INVITE_OPTIONS,
    );

    expect(beforeDst).toContain('DTSTART:20260301T140000Z');
    expect(afterDst).toContain('DTSTART:20260308T130000Z');

    const torontoHour = (ics: string) =>
      new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Toronto',
        hour: 'numeric',
        hour12: false,
      }).format(parseSingleEvent(ics).start);
    // Both land on the same 9am family-local wall clock — the point of the UTC form.
    expect(torontoHour(beforeDst)).toBe('09');
    expect(torontoHour(afterDst)).toBe('09');
  });

  it('omits DTEND and LOCATION and DESCRIPTION when the event carries none', () => {
    const ics = generateEventInvite(
      invite({ endsAt: null, location: null, description: null }),
      INVITE_OPTIONS,
    );

    expect(ics).not.toContain('DTEND:');
    expect(ics).not.toContain('LOCATION:');
    expect(ics).not.toContain('DESCRIPTION:');
  });

  it('escapes comma, semicolon, backslash and newline in every TEXT value', () => {
    const ics = generateEventInvite(
      invite({
        summary: 'Swim; goggles, towel \\ mat',
        location: 'Pool, west door; gate 2',
        description: 'Bring:\ntowel, goggles',
      }),
      INVITE_OPTIONS,
    );

    expect(ics).toContain('SUMMARY:Swim\\; goggles\\, towel \\\\ mat');
    expect(ics).toContain('LOCATION:Pool\\, west door\\; gate 2');
    expect(ics).toContain('DESCRIPTION:Bring:\\ntowel\\, goggles');

    const parsed = parseSingleEvent(ics);
    expect(parsed.summary).toBe('Swim; goggles, towel \\ mat');
    expect(parsed.description).toBe('Bring:\ntowel, goggles');
  });

  it('uses CRLF endings and folds every physical line to 75 octets', () => {
    const ics = generateEventInvite(invite({ summary: 'B'.repeat(140) }), INVITE_OPTIONS);

    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics.replace(/\r\n/g, '')).not.toContain('\n');
    for (const line of ics.split('\r\n')) {
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
    }
    expect(parseSingleEvent(ics).summary).toBe('B'.repeat(140));
  });
});

describe('generateEventPublish — the downloadable file a link serves', () => {
  it('carries METHOD:PUBLISH and the same UID, with no ATTENDEE (RFC 5546 §3.2.1)', () => {
    const ics = generateEventPublish(invite({ sequence: 4 }), {
      organizerEmail: 'aloha@villagehale.com',
      organizerName: 'Hale',
      now: DTSTAMP,
    });

    expect(ics).toContain('METHOD:PUBLISH');
    expect(ics).not.toContain('ATTENDEE');
    expect(ics).toContain('ORGANIZER;CN=Hale:mailto:aloha@villagehale.com');
    expect(ics).toContain('SEQUENCE:4');
    expect(parseSingleEvent(ics).uid).toBe(
      parseSingleEvent(generateEventInvite(invite(), INVITE_OPTIONS)).uid,
    );
  });
});

describe('generateEventCancel — RFC 5546 CANCEL', () => {
  it('carries the same UID as the invite with a higher SEQUENCE, METHOD:CANCEL and STATUS:CANCELLED', () => {
    const requested = generateEventInvite(invite({ sequence: 2 }), INVITE_OPTIONS);
    const cancelled = generateEventCancel(invite({ sequence: 3 }), INVITE_OPTIONS);

    expect(parseSingleEvent(cancelled).uid).toBe(parseSingleEvent(requested).uid);
    expect(requested).toContain('SEQUENCE:2');
    expect(cancelled).toContain('SEQUENCE:3');
    expect(cancelled).toContain('METHOD:CANCEL');
    expect(cancelled).toContain('STATUS:CANCELLED');
    expect(cancelled).not.toContain('METHOD:REQUEST');
    expect(cancelled).not.toContain('STATUS:CONFIRMED');
  });
});
