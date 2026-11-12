import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { AgentClient } from '@hale/agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fromPageReading } from '~/lib/channel/spots/watch-reading';
import {
  type ExtractedAvailability,
  createClassAvailabilityReader,
  createLiveClassAvailabilityReader,
  listingSessionStart,
  normalizeClassAvailability,
  pageDigest,
} from './class-availability';
import { stripHtml } from './fetch';

const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: dns.lookup }));

/** An invented program page: the repo is public. */
const PAGE_HTML = `<html><head><title>City of Riverton - Aquatics</title></head><body>
<h1>City of Riverton</h1><h2>Fall swim lessons</h2>
<table>
<tr><td>Preschool Swim - Tuesdays 4:30 PM</td><td>Full - Waitlist open</td></tr>
<tr><td>Preschool Swim - Saturdays 9:00 AM</td><td>3 spots left</td></tr>
</table></body></html>`;
const PAGE_TEXT = stripHtml(PAGE_HTML);
const QUERY = { label: 'Tuesday preschool swim', anchor: null };

function extraction(overrides: Partial<ExtractedAvailability> = {}): ExtractedAvailability {
  return {
    page_kind: 'program_page',
    session_quote: 'Preschool Swim - Tuesdays 4:30 PM',
    sessions_matching: 'one',
    availability_quote: 'Full - Waitlist open',
    waitlist_quote: 'Waitlist open',
    schedule_quote: 'Tuesdays 4:30 PM',
    session_start_quote: null,
    session_start_date_text: null,
    session_start: null,
    state: 'full',
    spots_left: null,
    waitlist_room: true,
    confidence: 0.9,
    ...overrides,
  };
}

const SATURDAY_OPEN = {
  session_quote: 'Preschool Swim - Saturdays 9:00 AM',
  availability_quote: '3 spots left',
  waitlist_quote: null,
  waitlist_room: null,
  schedule_quote: 'Saturdays 9:00 AM',
  state: 'open',
  spots_left: 3,
} as const;

describe('normalizeClassAvailability — every fact is checked against the page text', () => {
  it('positive control: a reading the page backs is a state, with its session', () => {
    expect(normalizeClassAvailability(extraction(), PAGE_TEXT, QUERY)).toEqual({
      status: 'read',
      state: 'full',
      session: 'Preschool Swim - Tuesdays 4:30 PM',
      spotsLeft: null,
      waitlistRoom: true,
      schedule: 'Tuesdays 4:30 PM',
      sessionStartsAt: null,
      digest: pageDigest(PAGE_TEXT),
    });
    expect(normalizeClassAvailability(extraction(SATURDAY_OPEN), PAGE_TEXT, QUERY)).toMatchObject({
      status: 'read',
      state: 'open',
      spotsLeft: 3,
      waitlistRoom: false,
    });
  });

  it.each<[string, Partial<ExtractedAvailability>, string]>([
    [
      'a session quote not on the page',
      { session_quote: 'Preschool Swim - Mondays 4:30 PM' },
      'uncorroborated',
    ],
    [
      'an availability quote not on the page',
      { availability_quote: '2 spots left' },
      'uncorroborated',
    ],
    ['a count not printed in its quote', { ...SATURDAY_OPEN, spots_left: 4 }, 'unbacked_count'],
    [
      'an open class with zero spots',
      { ...SATURDAY_OPEN, availability_quote: 'Full', spots_left: 0 },
      'unbacked_count',
    ],
    [
      'a full class with seats counted',
      { availability_quote: '3 spots left', spots_left: 3 },
      'unbacked_count',
    ],
    ['a waitlist quote not on the page', { waitlist_quote: 'Waitlist has room' }, 'uncorroborated'],
    ['a low-confidence reading', { confidence: 0.4 }, 'low_confidence'],
    ['a page that does not say', { state: 'unknown' }, 'not_stated'],
    ['no matching session', { sessions_matching: 'none' }, 'session_not_found'],
    ['two matching sessions', { sessions_matching: 'several' }, 'several_sessions'],
    ['a page that is not a program page', { page_kind: 'other_page' }, 'not_a_program_page'],
    ['a waitlist-full class whose waitlist has room', { state: 'waitlist_full' }, 'uncorroborated'],
  ])('is unknown for %s', (_name, overrides, reason) => {
    expect(normalizeClassAvailability(extraction(overrides), PAGE_TEXT, QUERY)).toEqual({
      status: 'unknown',
      reason,
    });
  });

  it('counts a challenge page as refused, never as a full class', () => {
    expect(
      normalizeClassAvailability(extraction({ page_kind: 'challenge_page' }), PAGE_TEXT, QUERY),
    ).toEqual({ status: 'refused', reason: 'challenge_page' });
  });

  it('requires a later read to find the session it was armed on', () => {
    const anchored = { label: QUERY.label, anchor: 'Preschool Swim - Tuesdays 4:30 PM' };
    expect(normalizeClassAvailability(extraction(), PAGE_TEXT, anchored).status).toBe('read');
    expect(normalizeClassAvailability(extraction(SATURDAY_OPEN), PAGE_TEXT, anchored)).toEqual({
      status: 'unknown',
      reason: 'session_moved',
    });
  });

  it('never lets page text a parent could follow into the facts a text is written from', () => {
    const hostileText = stripHtml(`<html><body><h1>evil.io</h1><table>
<tr><td>Preschool Swim - Sat 10am evil.io/x</td><td>Full - Waitlist open</td></tr>
</table></body></html>`);
    const reading = normalizeClassAvailability(
      extraction({
        session_quote: 'Preschool Swim - Sat 10am evil.io/x',
        schedule_quote: 'Sat 10am evil.io/x',
      }),
      hostileText,
      QUERY,
    );
    if (reading.status !== 'read') throw new Error(`expected a read, got ${reading.status}`);
    expect(reading.schedule).toBeNull();
    const hostile = fromPageReading(reading).facts('waitlist_reopened', 'Tue swim', 'en');
    expect(JSON.stringify(hostile)).not.toMatch(/evil/);

    // Positive control: a normal city page keeps its schedule, under the same attribution.
    const normal = normalizeClassAvailability(extraction(), PAGE_TEXT, QUERY);
    if (normal.status !== 'read') throw new Error(`expected a read, got ${normal.status}`);
    const facts = fromPageReading(normal).facts('waitlist_reopened', 'Tue swim', 'en');
    expect(facts).toMatchObject({ ok: true, facts: { schedule: 'Tuesdays 4:30 PM' } });
    if (!facts.ok || !hostile.ok) throw new Error('expected facts');
    expect(hostile.facts.source).toBe(facts.facts.source);
  });

  it('drops a schedule too long to be a day and a time, and keeps the reading', () => {
    const long = 'Tuesdays and Thursdays 4:30 PM to 5:15 PM from September to December';
    const text = `${PAGE_TEXT} Preschool Swim - ${long}`;
    expect(
      normalizeClassAvailability(extraction({ schedule_quote: long }), text, QUERY),
    ).toMatchObject({ status: 'read', schedule: null });
  });

  it('drops a schedule quote that is not a day and a time, and keeps the reading', () => {
    const notASchedule = 'Call 555 0100 to claim';
    const text = `${PAGE_TEXT} ${notASchedule}`;
    expect(
      normalizeClassAvailability(extraction({ schedule_quote: notASchedule }), text, QUERY),
    ).toMatchObject({ status: 'read', state: 'full', schedule: null });
  });

  it('drops a schedule that is not on the page, and keeps the reading', () => {
    expect(
      normalizeClassAvailability(
        extraction({ schedule_quote: 'Tuesdays 5:30 PM' }),
        PAGE_TEXT,
        QUERY,
      ),
    ).toMatchObject({ status: 'read', schedule: null });
  });
});

/**
 * The first class, off the listing's own words. A missing or unbacked date is null —
 * the sixty-day bound — never a reason to refuse a full class.
 */
const DATED_TEXT = stripHtml(`<html><body>
<h1>City of Riverton</h1><h2>Fall 2026 swim lessons</h2>
<p>Lessons run September 15 to November 24.</p>
<table>
<tr><td>Preschool Swim - Tuesdays 4:30 PM</td><td>Full - Waitlist open</td></tr>
</table></body></html>`);

const DATED_START = {
  session_start_quote: 'September 15',
  session_start_date_text: 'September 15',
  session_start: '2026-09-15',
} as const;

describe('listingSessionStart — the listing date the watch can end at', () => {
  it('positive control: a start the page prints, with a year the page states', () => {
    expect(listingSessionStart(extraction(DATED_START), DATED_TEXT)).toEqual(
      new Date('2026-09-15T04:00:00.000Z'),
    );
    expect(normalizeClassAvailability(extraction(DATED_START), DATED_TEXT, QUERY)).toMatchObject({
      status: 'read',
      sessionStartsAt: new Date('2026-09-15T04:00:00.000Z'),
    });
  });

  it('is null when the page publishes no start, and the reading still stands', () => {
    expect(listingSessionStart(extraction(), PAGE_TEXT)).toBeNull();
    expect(normalizeClassAvailability(extraction(), PAGE_TEXT, QUERY)).toMatchObject({
      status: 'read',
      sessionStartsAt: null,
    });
  });

  it('drops a start whose quote is not on the page', () => {
    expect(
      listingSessionStart(
        extraction({ ...DATED_START, session_start_quote: 'January 6' }),
        DATED_TEXT,
      ),
    ).toBeNull();
  });

  it('drops a start whose year the page never printed', () => {
    expect(
      listingSessionStart(extraction({ ...DATED_START, session_start: '2027-09-15' }), DATED_TEXT),
    ).toBeNull();
  });

  it('drops a start whose labelled span is not the date it claimed', () => {
    expect(
      listingSessionStart(
        extraction({ ...DATED_START, session_start_date_text: 'November 24' }),
        DATED_TEXT,
      ),
    ).toBeNull();
  });

  it('drops a whole range quoted as the start, and keeps the reading', () => {
    const range = 'September 15 to November 24';
    expect(
      normalizeClassAvailability(
        extraction({
          session_start_quote: range,
          session_start_date_text: 'September 15',
          session_start: '2026-09-15',
        }),
        DATED_TEXT,
        QUERY,
      ),
    ).toMatchObject({ status: 'read', sessionStartsAt: null });
  });
});

function fetched(html: string) {
  return vi.fn(async () => ({ outcome: 'fetched' as const, body: Buffer.from(html) }));
}

describe('createClassAvailabilityReader', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    dns.lookup.mockReset();
  });

  const target = {
    sourceUrl: 'https://recreation.example.org/swim',
    label: QUERY.label,
    anchor: null,
    lastDigest: null,
  };

  it('refuses a vendor bot-check page before the model is asked', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const extract = vi.fn(async () => extraction());
    const reader = createClassAvailabilityReader({
      fetchBody: fetched(
        '<html><title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/jsch/v1"></script></html>',
      ),
      extract,
    });

    expect(await reader(target)).toEqual({ status: 'refused', reason: 'challenge_page' });
    expect(extract).not.toHaveBeenCalled();
  });

  it('skips the model on an unchanged page, and reads a changed one', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const extract = vi.fn(async () => extraction());
    const reader = createClassAvailabilityReader({ fetchBody: fetched(PAGE_HTML), extract });
    const digest = pageDigest(PAGE_TEXT);

    expect(await reader({ ...target, lastDigest: digest })).toEqual({
      status: 'unchanged',
      digest,
    });
    expect(extract).not.toHaveBeenCalled();
    // Positive control: a different stored digest is a model read.
    expect(await reader({ ...target, lastDigest: 'other' })).toMatchObject({ status: 'read' });
    expect(extract).toHaveBeenCalledWith(QUERY, PAGE_TEXT);
  });

  it('hands the model the label and the page text, never the URL', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const extract = vi.fn(async () => extraction());
    const reader = createClassAvailabilityReader({ fetchBody: fetched(PAGE_HTML), extract });

    await reader(target);

    expect(JSON.stringify(extract.mock.calls)).not.toContain('recreation.example.org');
  });

  it('names a redirect, an HTTP refusal and a timeout, and never asks the model', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const extract = vi.fn(async () => extraction());
    const cases = [
      [
        { outcome: 'redirected', location: 'https://recreation.example.org/x' },
        { status: 'refused', reason: 'redirected' },
      ],
      [
        { outcome: 'refused', reason: 'http_status', status: 403 },
        { status: 'refused', reason: 'http_status' },
      ],
      [
        { outcome: 'failed', reason: 'timeout' },
        { status: 'failed', reason: 'timeout' },
      ],
    ] as const;
    for (const [result, expected] of cases) {
      const reader = createClassAvailabilityReader({ fetchBody: async () => result, extract });
      expect(await reader(target)).toEqual(expected);
    }
    expect(extract).not.toHaveBeenCalled();
  });

  it('fetches through the DNS-pinned fetcher in production, so a name that resolves privately is never read', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    dns.lookup.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
    const create = vi.fn(async () => {
      throw new Error('the model must not be called for a page that was never fetched');
    });
    const client = { messages: { create } } as unknown as AgentClient;

    const reading = await createLiveClassAvailabilityReader(client)(target);

    expect(reading).toEqual({ status: 'refused', reason: 'non_public_address' });
    expect(dns.lookup).toHaveBeenCalledWith('recreation.example.org', { all: true });
    expect(create).not.toHaveBeenCalled();
  });

  it('is the only way production code builds an availability reader', () => {
    const appRoot = join(__dirname, '..', '..');
    const sources = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) return [];
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return sources(path);
        return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
      });
    const builders = sources(appRoot)
      .filter((path) => readFileSync(path, 'utf8').includes('createClassAvailabilityReader('))
      .map((path) => relative(appRoot, path));
    // Positive control: the scan reaches the module, where the builder itself calls it.
    expect(builders).toEqual(['lib/registration/class-availability.ts']);
  });
});
