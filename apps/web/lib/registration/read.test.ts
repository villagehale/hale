import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SPOT_PORTAL_HOSTS } from '~/lib/channel/spots/url';
import { StructuredOutputError } from '~/lib/pipeline/structured';
import { registrationWindowFixture } from '~/lib/testing/registration-source';
import { type RegistrationPageFetch, createRegistrationPageBytesFetch } from './page';
import { MAX_CONCURRENT_PDF_READS, registrationPdfText } from './pdf';
import { registrationPdfFixture } from './pdf-fixture.test-helper';
import {
  type RegistrationReaderPorts,
  createRegistrationReader,
  readRegistrationWindows,
  windowReadTarget,
} from './read';
import { type ExtractedWindow, extractionInput, parseExtraction } from './verify-window';

// The deploy bundle, faked at the file system: pass-through unless a test says the
// PDF worker file is missing from it.
const bundle = vi.hoisted(() => ({ hideWorkerFile: false }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: (path: Parameters<typeof actual.existsSync>[0]) =>
      bundle.hideWorkerFile && String(path).endsWith('pdf-worker.mjs')
        ? false
        : actual.existsSync(path),
  };
});

/**
 * The live reader, driven through its two ports: `fetchBody` (bytes) and `extract` (a
 * hand-built extraction answer — a parse-boundary input, not a mocked model; model
 * quality is the registration-verify eval's job, hard rule #8).
 */

const NOW = new Date('2026-10-10T12:00:00Z');
const PAGE = 'Riverbend Aquatics. Public registration opens October 20, 2026 at 9 a.m.';
const ZONE_SENTENCE = 'Pool hours are Eastern Time.';

function extraction(overrides: Partial<ExtractedWindow> = {}): ExtractedWindow {
  return {
    found: true,
    reason: null,
    cycleOnPage: 'Fall 2026',
    yearEvidence: 'October 20, 2026',
    evidence: 'Public registration opens October 20, 2026 at 9 a.m.',
    preview: null,
    residentOpen: null,
    generalOpen: {
      quote: 'October 20, 2026 at 9 a.m.',
      dateText: 'October 20, 2026',
      timeText: '9 a.m.',
      date: '2026-10-20',
      time: '09:00',
    },
    unclassifiedOpen: null,
    partialDates: [],
    timeZone: 'America/New_York',
    timeZoneEvidence: 'Eastern Time',
    note: null,
    confidence: 0.95,
    ...overrides,
  };
}

const fetched = (body: Uint8Array): RegistrationPageFetch => ({
  outcome: 'fetched',
  body: Buffer.from(body),
});

function ports(
  body: Uint8Array | RegistrationPageFetch,
  extract: RegistrationReaderPorts['extract'] = async () => extraction(),
) {
  const result = body instanceof Uint8Array ? fetched(body) : body;
  const fetchBody = vi.fn(async (_url: string) => result);
  const extractSpy = vi.fn(extract);
  return { fetchBody, extract: extractSpy };
}

const html = (text: string) => Buffer.from(`<html><body><p>${text}</p></body></html>`);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the zone comes from the page or the portal, never from the caller', () => {
  const window = registrationWindowFixture({ cycleLabel: 'Fall 2026' });

  it('reads a page with neither a zone quote nor a portal zone as unverified', async () => {
    const reader = createRegistrationReader(
      ports(html(PAGE), async () => extraction({ timeZone: null, timeZoneEvidence: null })),
    );

    const reading = await reader(windowReadTarget(window), NOW);

    expect(reading).toMatchObject({ status: 'unverified', reason: 'unknown_time_zone' });
    expect(reading).not.toHaveProperty('dates');
    expect(await readRegistrationWindows([window], reader, NOW, null)).toEqual([]);
  });

  it('verifies the same window once the page names its zone (control)', async () => {
    const reader = createRegistrationReader(ports(html(`${PAGE} ${ZONE_SENTENCE}`)));

    const [live] = await readRegistrationWindows([window], reader, NOW, null);

    expect(live?.reading).toMatchObject({ status: 'verified', timeZone: 'America/New_York' });
    expect(live?.openAt).toEqual(new Date('2026-10-20T13:00:00Z'));
  });
});

describe('a PerfectMind course page', () => {
  const RAW = readFileSync(
    join(__dirname, '../channel/spots/fixtures/open-window-open-markham.html'),
  );
  const HOST = 'cityofmarkham.perfectmind.com';
  const COURSE_URL = `https://${HOST}/Clients/BookMe4LandingPages/CoursesLandingPage?widgetId=bfd08479-60d6-43d9-b586-5b4c8305a003&courseId=961140fe-0866-460f-9973-7c42cbe0a928`;
  const target = { ...windowReadTarget(registrationWindowFixture()), sourceUrl: COURSE_URL };

  it("reads deterministically, in the portal's own zone, with every date backed by the bytes", async () => {
    const p = ports(RAW, async () => {
      throw new Error('the course page must not reach the model');
    });

    const reading = await createRegistrationReader(p)(target, NOW);

    expect(reading).toMatchObject({
      status: 'verified',
      reader: 'perfectmind',
      timeZone: SPOT_PORTAL_HOSTS[HOST]?.timeZone,
      dates: [
        { kind: 'resident_open', date: '2026-08-11', time: '06:30' },
        { kind: 'member_open', date: '2026-08-12', time: '06:30' },
        { kind: 'general_open', date: '2026-08-12', time: '06:30' },
      ],
    });
    if (reading.status !== 'verified') throw new Error('expected verified');
    const raw = RAW.toString('utf8');
    for (const date of reading.dates) {
      expect(date.evidence.length).toBeGreaterThan(0);
      for (const quote of date.evidence) expect(raw).toContain(quote);
    }
    expect(p.extract).not.toHaveBeenCalled();
  });

  it('sends the same bytes from a non-portal host to the model (control)', async () => {
    const p = ports(RAW, async () => extraction({ found: false, reason: 'not_published' }));
    await createRegistrationReader(p)({ ...target, sourceUrl: 'https://example.org/x' }, NOW);
    expect(p.extract).toHaveBeenCalledTimes(1);
  });
});

describe('a PDF source, and failed reads that never fall back', () => {
  const stored = registrationWindowFixture({
    cycleLabel: 'Fall 2026',
    openAt: new Date('2026-01-01T00:00:00Z'),
  });

  it('reads the PDF text through pdf.ts and verifies from it', async () => {
    const p = ports(
      registrationPdfFixture([
        'Public registration opens October 20, 2026 at 9 a.m.',
        ZONE_SENTENCE,
      ]),
    );

    const [live] = await readRegistrationWindows([stored], createRegistrationReader(p), NOW, null);

    const [, pageText] = p.extract.mock.calls[0] ?? [];
    expect(pageText).toContain('[PDF page 1]');
    expect(pageText).not.toContain('%PDF-');
    expect(live?.reading.status).toBe('verified');
    expect(live?.openAt).toEqual(new Date('2026-10-20T13:00:00Z'));
  });

  it.each([
    ['an unreadable PDF', Buffer.from('%PDF-1.4 broken'), 'pdf_unreadable'],
    ['a PDF with no text', registrationPdfFixture(['']), 'pdf_no_text'],
    ['a redirect', { outcome: 'redirected', location: 'https://example.net/queue' }, 'redirected'],
    ['a refused status', { outcome: 'refused', reason: 'http_status', status: 404 }, 'http_status'],
    [
      'a server error, which says nothing about the page',
      { outcome: 'refused', reason: 'http_status', status: 503 },
      'http_server_error',
    ],
    ['an oversized page', { outcome: 'refused', reason: 'too_large' }, 'too_large'],
    ['a timeout', { outcome: 'failed', reason: 'timeout' }, 'timeout'],
    ['a network error', { outcome: 'failed', reason: 'network_error' }, 'network_error'],
  ] as const)('names %s and keeps no stored date', async (_name, body, reason) => {
    const p = ports(body, async () => {
      throw new Error('a failed read must not reach the model');
    });
    const reader = createRegistrationReader(p);

    const reading = await reader(windowReadTarget(stored), NOW);

    expect(reading).toMatchObject({ status: 'unreadable', reason });
    expect(reading).not.toHaveProperty('dates');
    expect(await readRegistrationWindows([stored], reader, NOW, null)).toEqual([]);
    expect(p.extract).not.toHaveBeenCalled();
  });
});

describe('a page with no words on it', () => {
  it('is unreadable, and never reaches the model (a bot challenge is not "not published")', async () => {
    // ottawa.ca to the pinned fetcher, 2026-11-12: a 200 with an Incapsula challenge.
    const challenge = Buffer.from(
      '<html>\r\n<head>\r\n<META NAME="robots" CONTENT="noindex,nofollow">\r\n<script src="/_Incapsula_Resource?SWJIYLWA=5074a744">\r\n</script>\r\n<body>\r\n</body></html>\r\n',
    );
    const p = ports(challenge, async () => {
      throw new Error('an empty page must not reach the model');
    });
    const window = registrationWindowFixture({ cycleLabel: 'Winter 2027' });
    const reading = await createRegistrationReader(p)(windowReadTarget(window), NOW);
    expect(reading).toMatchObject({ status: 'unreadable', reason: 'empty_page' });
    expect(p.extract).not.toHaveBeenCalled();
    // Positive control: a page with words on it is read.
    const words = ports(html(PAGE));
    await createRegistrationReader(words)(windowReadTarget(window), NOW);
    expect(words.extract).toHaveBeenCalledTimes(1);
  });
});

describe('busy: Hale is out of capacity right now, which says nothing about the page', () => {
  const window = registrationWindowFixture({ cycleLabel: 'Fall 2026' });
  const pdf = registrationPdfFixture([
    'Public registration opens October 20, 2026 at 9 a.m.',
    ZONE_SENTENCE,
  ]);

  it('names a busy host busy, never unreadable, with no date and no model call', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const p = ports({ outcome: 'busy', reason: 'host_busy' });
    const reader = createRegistrationReader(p);

    const reading = await reader(windowReadTarget(window), NOW);

    expect(reading).toEqual({
      sourceUrl: window.sourceUrl,
      checkedAt: NOW,
      reader: 'ai',
      status: 'busy',
      reason: 'host_busy',
    });
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'busy', reason: 'host_busy' }),
      'registration read',
    );
    expect(await readRegistrationWindows([window], reader, NOW, null)).toEqual([]);
    expect(p.extract).not.toHaveBeenCalled();
  });

  it('names busy PDF readers busy, and reads the same PDF once a reader is free', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    // Every reader slot is taken synchronously, before the reader's own read begins (a
    // slot an earlier test's worker still holds counts too).
    const held = Array.from({ length: MAX_CONCURRENT_PDF_READS }, () => registrationPdfText(pdf));
    const p = ports(pdf);

    const reading = await createRegistrationReader(p)(windowReadTarget(window), NOW);

    expect(reading).toMatchObject({ status: 'busy', reason: 'pdf_readers_busy' });
    expect(reading).not.toHaveProperty('dates');
    expect(p.extract).not.toHaveBeenCalled();
    await Promise.all(held);

    // Positive control: once the held workers exit, a new reader verifies the same bytes.
    await vi.waitFor(async () => {
      const [live] = await readRegistrationWindows(
        [window],
        createRegistrationReader(p),
        NOW,
        null,
      );
      expect(live?.reading.status).toBe('verified');
    });
  });
});

describe('a PDF reader that is missing from the deploy', () => {
  const pdf = registrationPdfFixture(['Public registration opens October 20, 2026 at 9 a.m.']);
  const target = windowReadTarget(registrationWindowFixture());

  it("is named pdf_reader_fault, not a fault in the city's PDF", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    bundle.hideWorkerFile = true;
    try {
      const p = ports(pdf);
      expect(await createRegistrationReader(p)(target, NOW)).toMatchObject({
        status: 'unreadable',
        reason: 'pdf_reader_fault',
      });
      expect(p.extract).not.toHaveBeenCalled();
    } finally {
      bundle.hideWorkerFile = false;
    }
  });

  it('reads the same PDF once the worker is there (control)', async () => {
    const p = ports(pdf);
    await createRegistrationReader(p)(target, NOW);
    expect(p.extract.mock.calls[0]?.[1]).toContain('October 20, 2026');
  });
});

describe('a URL the fetcher refuses', () => {
  const base = windowReadTarget(registrationWindowFixture());

  it.each([
    ['a private address', 'https://127.0.0.1/x', 'non_public_host'],
    ['plain http', 'http://example.org/x', 'not_https'],
    [
      'an ordinary-looking key the fetcher still refuses',
      'https://example.org/x?code=1',
      'ambiguous_query_key',
    ],
  ])('is refused before any fetch, under its own name: %s', async (_name, sourceUrl, reason) => {
    const p = ports(html(PAGE));
    const reading = await createRegistrationReader(p)({ ...base, sourceUrl }, NOW);
    expect(reading).toMatchObject({ status: 'unreadable', reason });
    expect(p.fetchBody).toHaveBeenCalledTimes(0);
  });

  it('fetches a public one (control)', async () => {
    const p = ports(html(PAGE));
    await createRegistrationReader(p)({ ...base, sourceUrl: 'https://example.org/x' }, NOW);
    expect(p.fetchBody).toHaveBeenCalledTimes(1);
  });
});

describe('what a catalog window asks the reader', () => {
  it("names the district in the cycle label, so the model reads that district's dates", () => {
    const window = registrationWindowFixture({ cycleLabel: 'Fall 2026', district: 'east_end' });
    expect(windowReadTarget(window)).toEqual({
      municipality: window.municipality,
      programDomain: window.programDomain,
      cycleLabel: 'Fall 2026 (east end)',
      sourceUrl: window.sourceUrl,
    });
  });

  it('leaves a town-wide cycle label as it is (control)', () => {
    const window = registrationWindowFixture({ cycleLabel: 'Fall 2026', district: null });
    expect(windowReadTarget(window).cycleLabel).toBe('Fall 2026');
  });
});

describe('a live window carries the preview the page states, and no stored one', () => {
  const window = registrationWindowFixture({
    cycleLabel: 'Fall 2026',
    previewAt: new Date('2026-01-01T00:00:00Z'),
  });
  const PREVIEW_PAGE = `Programs preview October 13, 2026 at 9 a.m. ${PAGE} ${ZONE_SENTENCE}`;

  it('maps the verified preview to previewAt', async () => {
    const reader = createRegistrationReader(
      ports(html(PREVIEW_PAGE), async () =>
        extraction({
          yearEvidence: 'October 13, 2026',
          preview: {
            quote: 'October 13, 2026 at 9 a.m.',
            dateText: 'October 13, 2026',
            timeText: '9 a.m.',
            date: '2026-10-13',
            time: '09:00',
          },
        }),
      ),
    );
    const [live] = await readRegistrationWindows([window], reader, NOW, null);
    expect(live?.previewAt).toEqual(new Date('2026-10-13T13:00:00Z'));
    expect(live?.openAt).toEqual(new Date('2026-10-20T13:00:00Z'));
  });

  it('is null when the page states none, whatever the catalog stored (control)', async () => {
    const reader = createRegistrationReader(ports(html(PREVIEW_PAGE)));
    const [live] = await readRegistrationWindows([window], reader, NOW, null);
    expect(live?.openAt).toEqual(new Date('2026-10-20T13:00:00Z'));
    expect(live?.previewAt).toBeNull();
  });
});

describe('a resident-only date applies only to a family resolved to that one town', () => {
  const window = registrationWindowFixture({ municipality: 'markham', cycleLabel: 'Fall 2026' });
  const reader = () =>
    createRegistrationReader(
      ports(html(`Residents register October 20, 2026 at 9 a.m. ${ZONE_SENTENCE}`), async () =>
        extraction({
          evidence: 'Residents register October 20, 2026 at 9 a.m.',
          generalOpen: null,
          residentOpen: {
            quote: 'October 20, 2026 at 9 a.m.',
            dateText: 'October 20, 2026',
            timeText: '9 a.m.',
            date: '2026-10-20',
            time: '09:00',
          },
        }),
      ),
    );

  it('drops the window for an area that spans two towns, and for no area at all', async () => {
    expect(await readRegistrationWindows([window], reader(), NOW, 'L4J')).toEqual([]);
    expect(await readRegistrationWindows([window], reader(), NOW, null)).toEqual([]);
  });

  it("keeps it, from the live reading, for a family in that town's only area (control)", async () => {
    const live = await readRegistrationWindows([window], reader(), NOW, 'L3R');
    expect(live).toHaveLength(1);
    expect(live[0]?.openAt).toEqual(new Date('2026-10-20T13:00:00Z'));
    expect(live[0]?.residentOpenAt).toEqual(new Date('2026-10-20T13:00:00Z'));
  });
});

describe('data minimisation', () => {
  it('hands the model the cycle identity and the page text, and nothing else', async () => {
    const p = ports(html(`${PAGE} ${ZONE_SENTENCE}`));
    const target = windowReadTarget(
      registrationWindowFixture({ cycleLabel: 'Fall 2026', residentOpenAt: new Date() }),
    );

    await createRegistrationReader(p)(target, NOW);

    const [cycle, pageText] = p.extract.mock.calls[0] ?? [];
    if (!cycle || pageText === undefined) throw new Error('expected one extract call');
    expect(Object.keys(cycle).sort()).toEqual(['cycleLabel', 'municipality', 'programDomain']);
    expect(Object.keys(JSON.parse(extractionInput(cycle, pageText))).sort()).toEqual([
      'cycle_label',
      'municipality',
      'page_text',
      'program_domain',
    ]);
  });
});

describe('a failed model read', () => {
  const target = windowReadTarget(registrationWindowFixture());

  it('is named extract_failed when the structured-output seam refuses the reply', async () => {
    const reader = createRegistrationReader(
      ports(html(PAGE), async () => {
        throw new StructuredOutputError(
          'registration_read',
          'truncated',
          'max_tokens',
          null,
          'truncated',
        );
      }),
    );
    expect(await reader(target, NOW)).toMatchObject({
      status: 'unreadable',
      reason: 'extract_failed',
    });
  });

  it.each([
    [
      'the schema refuses the reply (an empty quote)',
      () =>
        parseExtraction({
          cycle_on_page: 'Fall 2026',
          evidence: 'Public registration opens October 20, 2026 at 9 a.m.',
          year_evidence: 'October 20, 2026',
          time_zone_evidence: 'Eastern Time',
          time_zone: 'America/New_York',
          eligibility_evidence: null,
          preview: null,
          resident_open: null,
          general_open: {
            quote: '',
            date_text: '',
            time_text: null,
            date: '2026-10-20',
            time: '09:00',
          },
          unclassified_open: null,
          note: null,
          found: true,
          reason: null,
          confidence: 0.95,
        }),
    ],
    [
      'the API refuses the call',
      () => {
        throw new Anthropic.APIError(529, { type: 'error' }, 'overloaded', undefined);
      },
    ],
  ] as const)('is named extract_failed when %s', async (_name, reply) => {
    const reader = createRegistrationReader(ports(html(PAGE), async () => reply()));
    expect(await reader(target, NOW)).toMatchObject({
      status: 'unreadable',
      reason: 'extract_failed',
    });
  });

  it('is NOT masked when the failure is a deploy bug (control)', async () => {
    const reader = createRegistrationReader(
      ports(html(PAGE), async () => {
        throw new Error('skill missing');
      }),
    );
    await expect(reader(target, NOW)).rejects.toThrow('skill missing');
  });
});

describe('logging', () => {
  it('logs each read once, with ids and outcome names only', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const NEEDLE = 'Lane four is reserved for the Otter group.';
    const p = ports(html(`${PAGE} ${ZONE_SENTENCE} ${NEEDLE}`));
    const reader = createRegistrationReader(p);
    const target = {
      ...windowReadTarget(registrationWindowFixture({ cycleLabel: 'Heron cycle label' })),
      sourceUrl: 'https://example.org/x?term=winter',
    };

    await reader(target, NOW);

    expect(p.extract.mock.calls[0]?.[1]).toContain(NEEDLE);
    expect(info).toHaveBeenCalledTimes(1);
    const [payload] = info.mock.calls[0] ?? [];
    expect(Object.keys(payload).sort()).toEqual(
      ['host', 'municipality', 'outcome', 'programDomain', 'reader', 'reason'].sort(),
    );
    expect(payload).toMatchObject({ host: 'example.org', outcome: 'verified', reason: null });
    const logged = JSON.stringify(info.mock.calls);
    expect(logged).not.toContain(NEEDLE);
    expect(logged).not.toContain('Heron cycle label');
    expect(logged).not.toContain('/x?');

    await reader(target, NOW);
    expect(info).toHaveBeenCalledTimes(1);
  });
});

describe('the fetch port', () => {
  it("is the hardened fetcher's named outcomes, so a plain fetch cannot be wired in", () => {
    createRegistrationReader({
      // @ts-expect-error a plain fetch resolves a Response (and follows redirects)
      fetchBody: (url: string) => fetch(url),
      extract: async () => extraction(),
    });
    // Positive control: the hardened fetcher itself wires in (no request is made here).
    createRegistrationReader({
      fetchBody: createRegistrationPageBytesFetch(),
      extract: async () => extraction(),
    });
  });
});

describe('the cache lives inside one reader', () => {
  it('fetches a shared URL once per reader, extracts per cycle, and a new reader fetches again', async () => {
    const p = ports(html(`${PAGE} ${ZONE_SENTENCE}`));
    const target = windowReadTarget(registrationWindowFixture({ cycleLabel: 'Fall 2026' }));
    const reader = createRegistrationReader(p);

    await reader(target, NOW);
    await reader(target, NOW);
    await reader({ ...target, cycleLabel: 'Winter 2027' }, NOW);
    expect([p.fetchBody.mock.calls.length, p.extract.mock.calls.length]).toEqual([1, 2]);

    await createRegistrationReader(p)(target, NOW);
    expect(p.fetchBody).toHaveBeenCalledTimes(2);
  });
});
