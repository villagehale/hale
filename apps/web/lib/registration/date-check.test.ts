import { afterEach, describe, expect, it, vi } from 'vitest';
import { registrationWindowFixture } from '~/lib/testing/registration-source';
import {
  REGISTRATION_DATE_CHECK_ENV,
  createDateChecker,
  registrationDateCheckMode,
} from './date-check';
import type { RegistrationPageFetch } from './page';
import { type RegistrationReaderPorts, createRegistrationReader } from './read';
import type { ExtractedWindow } from './verify-window';

/**
 * The checker is driven through the real reader (createRegistrationReader) with its two
 * ports: page bytes, and a hand-built extraction answer at the parse boundary. Model
 * quality is the registration-verify eval's job (hard rule #8).
 */

const NOW = new Date('2026-10-10T12:00:00Z');
const PAGE =
  'Riverbend Aquatics, Eastern Time. Public registration opens October 20, 2026 at 9 a.m.';
/** 9 a.m. Eastern on 20 Oct 2026. */
const PAGE_OPEN = new Date('2026-10-20T13:00:00.000Z');

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

function checker(
  options: {
    page?: string;
    fetched?: RegistrationPageFetch;
    extract?: RegistrationReaderPorts['extract'];
    mode?: 'shadow' | 'enforce';
  } = {},
) {
  const fetchBody = vi.fn(
    async () =>
      options.fetched ?? {
        outcome: 'fetched' as const,
        body: Buffer.from(`<html><body><p>${options.page ?? PAGE}</p></body></html>`),
      },
  );
  const extract = vi.fn(options.extract ?? (async () => extraction()));
  return {
    fetchBody,
    extract,
    check: createDateChecker(
      () => createRegistrationReader({ fetchBody, extract }),
      options.mode ?? 'enforce',
    ),
  };
}

const window = registrationWindowFixture({
  id: 'w-1',
  sourceUrl: 'https://registration.example.org/fall',
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('registrationDateCheckMode', () => {
  it('is off unless the value is exactly shadow or enforce', () => {
    vi.stubEnv(REGISTRATION_DATE_CHECK_ENV, 'shadow');
    expect(registrationDateCheckMode()).toBe('shadow');
    vi.stubEnv(REGISTRATION_DATE_CHECK_ENV, 'enforce');
    expect(registrationDateCheckMode()).toBe('enforce');
    for (const value of ['enforce\n', 'Enforce', 'true', '']) {
      vi.stubEnv(REGISTRATION_DATE_CHECK_ENV, value);
      expect(registrationDateCheckMode()).toBe('off');
    }
  });
});

describe('the send-time date check', () => {
  it('agrees when the page states the same instant', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { check } = checker();
    await expect(
      check.check({ window, resident: false, stated: PAGE_OPEN, sender: 'heads_up' }, NOW),
    ).resolves.toEqual({ outcome: 'agree', liveAt: PAGE_OPEN });
  });

  it("disagrees when the page moved, and carries the page's own instant", async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { check } = checker();
    const stale = new Date('2026-10-22T13:00:00.000Z');
    await expect(
      check.check({ window, resident: false, stated: stale, sender: 'heads_up' }, NOW),
    ).resolves.toEqual({ outcome: 'disagree', liveAt: PAGE_OPEN });
  });

  it('a page that prints no zone is unread, whatever date it shows', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { check } = checker({
      page: 'Public registration opens October 20, 2026 at 9 a.m.',
      extract: async () => extraction({ timeZone: null, timeZoneEvidence: null }),
    });
    await expect(
      check.check({ window, resident: false, stated: PAGE_OPEN, sender: 'go' }, NOW),
    ).resolves.toEqual({ outcome: 'unread', reason: 'unverified', detail: 'unknown_time_zone' });
  });

  it('a page that could not be fetched is unread, by name', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { check, extract } = checker({ fetched: { outcome: 'failed', reason: 'timeout' } });
    await expect(
      check.check({ window, resident: false, stated: PAGE_OPEN, sender: 'go' }, NOW),
    ).resolves.toEqual({ outcome: 'unread', reason: 'unreadable', detail: 'timeout' });
    expect(extract).not.toHaveBeenCalled();
  });

  it('an unlabelled opening is not a date this family may act on', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const open = extraction().generalOpen;
    const { check } = checker({
      extract: async () => extraction({ generalOpen: null, unclassifiedOpen: open }),
    });
    await expect(
      check.check({ window, resident: false, stated: PAGE_OPEN, sender: 'heads_up' }, NOW),
    ).resolves.toEqual({ outcome: 'unread', reason: 'no_family_date', detail: null });
  });

  it('a resident family is checked against the resident opening', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const page = `${PAGE} Residents register October 18, 2026 at 9 a.m.`;
    const { check } = checker({
      page,
      extract: async () =>
        extraction({
          residentOpen: {
            quote: 'October 18, 2026 at 9 a.m.',
            dateText: 'October 18, 2026',
            timeText: '9 a.m.',
            date: '2026-10-18',
            time: '09:00',
          },
        }),
    });
    const residentOpen = new Date('2026-10-18T13:00:00.000Z');
    await expect(
      check.check({ window, resident: true, stated: residentOpen, sender: 'heads_up' }, NOW),
    ).resolves.toEqual({ outcome: 'agree', liveAt: residentOpen });
    await expect(
      check.check({ window, resident: false, stated: residentOpen, sender: 'heads_up' }, NOW),
    ).resolves.toEqual({ outcome: 'disagree', liveAt: PAGE_OPEN });
  });

  describe('a page that prints the day and no time', () => {
    const dayOnly = 'Riverbend Aquatics, Eastern Time. Public registration opens October 20, 2026.';
    const dayOnlyExtraction = async () =>
      extraction({
        evidence: 'Public registration opens October 20, 2026.',
        generalOpen: {
          quote: 'October 20, 2026',
          dateText: 'October 20, 2026',
          timeText: null,
          date: '2026-10-20',
          time: null,
        },
      });
    /** Midnight Eastern, 20 Oct: the catalog row of a date-only opening. */
    const dayStart = new Date('2026-10-20T04:00:00.000Z');

    it('agrees with a stored date-only opening on that day', async () => {
      vi.spyOn(console, 'info').mockImplementation(() => {});
      const { check } = checker({ page: dayOnly, extract: dayOnlyExtraction });
      await expect(
        check.check({ window, resident: false, stated: dayStart, sender: 'heads_up' }, NOW),
      ).resolves.toEqual({ outcome: 'agree', liveAt: dayStart });
    });

    it('does not corroborate a stored time the page never printed', async () => {
      vi.spyOn(console, 'info').mockImplementation(() => {});
      const { check } = checker({ page: dayOnly, extract: dayOnlyExtraction });
      await expect(
        check.check({ window, resident: false, stated: PAGE_OPEN, sender: 'heads_up' }, NOW),
      ).resolves.toEqual({ outcome: 'unread', reason: 'time_not_on_page', detail: null });
    });

    it('disagrees when the day itself differs', async () => {
      vi.spyOn(console, 'info').mockImplementation(() => {});
      const { check } = checker({ page: dayOnly, extract: dayOnlyExtraction });
      await expect(
        check.check(
          {
            window,
            resident: false,
            stated: new Date('2026-10-21T13:00:00.000Z'),
            sender: 'heads_up',
          },
          NOW,
        ),
      ).resolves.toEqual({ outcome: 'disagree', liveAt: dayStart });
    });
  });

  it('with no model client every check is unread as no_reader, and nothing is fetched', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const create = vi.fn(() => null);
    const check = createDateChecker(create, 'shadow');
    await expect(
      check.check({ window, resident: false, stated: PAGE_OPEN, sender: 'nudge' }, NOW),
    ).resolves.toEqual({ outcome: 'unread', reason: 'no_reader', detail: null });
    await check.check({ window, resident: false, stated: PAGE_OPEN, sender: 'nudge' }, NOW);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('builds one reader per run, so two families on one window cost one read', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { check, fetchBody, extract } = checker();
    await check.check({ window, resident: false, stated: PAGE_OPEN, sender: 'heads_up' }, NOW);
    await check.check({ window, resident: false, stated: PAGE_OPEN, sender: 'battle_plan' }, NOW);
    expect(fetchBody).toHaveBeenCalledTimes(1);
    expect(extract).toHaveBeenCalledTimes(1);
  });

  it('logs the window id and outcome codes, never page text', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { check } = checker({ mode: 'shadow' });
    await check.check(
      {
        window,
        resident: false,
        stated: new Date('2026-10-22T13:00:00.000Z'),
        sender: 'heads_up',
      },
      NOW,
    );
    const line = info.mock.calls.find((call) => call[1] === 'registration date check');
    expect(line?.[0]).toEqual({
      outcome: 'registration_date_check',
      mode: 'shadow',
      windowId: 'w-1',
      sender: 'heads_up',
      check: 'disagree',
      reason: null,
      detail: null,
    });
    // Positive control for the absence below: the page text is in what the reader read.
    expect(PAGE).toContain('Riverbend');
    expect(JSON.stringify(info.mock.calls)).not.toContain('Riverbend');
  });
});
