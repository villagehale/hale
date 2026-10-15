import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RegistrationSourceState } from '@hale/db';
import { describe, expect, it } from 'vitest';
import { registrationPdfFixture } from './pdf-fixture.test-helper';
import {
  type RegistrationTarget,
  createRegistrationReader,
  readRegistrationWindows,
  registrationDate,
  registrationHasOpened,
} from './read';
import type { CycleIdentity, ExtractedWindow } from './verify-window';

const now = new Date('2026-10-10T12:00:00Z');
const target: RegistrationTarget = {
  sourceUrl: 'https://example.org/course',
  municipality: 'operator',
  programDomain: 'course',
  cycleLabel: 'single course',
  timeZone: null,
};
const text = 'New York course. Registration opens October 20, 2026 at 09:00.';
// Parser/dependency contracts only; real model quality is gated by the registration eval.
const extraction: ExtractedWindow = {
  found: true,
  reason: null,
  cycleOnPage: 'course',
  yearEvidence: '2026',
  preview: null,
  residentOpen: null,
  generalOpen: { date: '2026-10-20', time: '09:00' },
  evidence: text,
  confidence: 0.95,
  timeZone: 'America/New_York',
  timeZoneEvidence: 'New York course.',
};

describe('live registration reader', () => {
  it('keeps binary-fetched HTML on the existing date verification path', async () => {
    const reader = createRegistrationReader({
      fetchBody: async () => Buffer.from(`<html><body>${text}</body></html>`),
      extract: async (_target, pageText) => {
        expect(pageText).toBe(text);
        return extraction;
      },
    });
    expect(await reader(target, now)).toMatchObject({ status: 'verified' });
  });
  it('uses PDF text for the existing extraction and date/year evidence gates', async () => {
    const bytes = registrationPdfFixture([text]);
    let fetches = 0;
    let calls = 0;
    const reader = createRegistrationReader({
      fetchBody: async () => {
        fetches++;
        return bytes;
      },
      extract: async (_target, pageText) => {
        calls++;
        expect(pageText).toContain('[PDF page 1]');
        expect(pageText).toContain(text);
        expect(pageText).not.toContain('%PDF-');
        return extraction;
      },
    });
    expect(await reader(target, now)).toMatchObject({
      status: 'verified',
      dates: [{ date: '2026-10-20', time: '09:00' }],
    });
    await reader(target, now);
    expect([fetches, calls]).toEqual([1, 1]);
    const wrong = createRegistrationReader({
      fetchBody: async () => bytes,
      extract: async () => ({ ...extraction, generalOpen: { date: '2027-10-20', time: '09:00' } }),
    });
    expect(await wrong(target, now)).toMatchObject({
      status: 'unverified',
      reason: 'uncorroborated',
    });
  });
  it('never treats an unlabelled PDF date as eligible just because its city is not a known portal', async () => {
    const reader = createRegistrationReader({
      fetchBody: async () => registrationPdfFixture([text]),
      extract: async () => extraction,
    });
    const reading = await reader({ ...target, municipality: 'uxbridge' }, now);
    expect(reading).toMatchObject({
      status: 'verified',
      dates: [{ kind: 'unclassified_open', date: '2026-10-20', time: '09:00' }],
    });
    expect(registrationDate(reading, false)).toBeNull();
    expect(registrationDate(reading, true)).toBeNull();
  });
  it('does not send unreadable PDF bytes to the model or fall back to old dates', async () => {
    for (const [bytes, reason] of [
      [Buffer.from('%PDF-1.4 broken'), 'pdf_unreadable'],
      ['%PDF-1.4 already decoded as UTF-8', 'pdf_unreadable'],
      [registrationPdfFixture(['']), 'pdf_no_text'],
    ] as const) {
      const reader = createRegistrationReader({
        fetchBody: async () => bytes,
        extract: async () => {
          throw new Error('must not call model');
        },
      });
      const result = await reader(target, now);
      expect(result).toMatchObject({ status: 'unreadable', reason });
      expect(result).not.toHaveProperty('dates');
    }
  });
  it('reads a saved PerfectMind page deterministically without AI, in the portal zone', async () => {
    const reader = createRegistrationReader({
      fetchBody: async () =>
        readFileSync(
          join(__dirname, '../channel/spots/fixtures/open-window-open-markham.html'),
          'utf8',
        ),
      extract: async () => {
        throw new Error('must not call AI');
      },
    });
    expect(
      await reader(
        {
          ...target,
          sourceUrl:
            'https://cityofmarkham.perfectmind.com/Clients/BookMe4LandingPages/CoursesLandingPage?widgetId=bfd08479-60d6-43d9-b586-5b4c8305a003&courseId=961140fe-0866-460f-9973-7c42cbe0a928',
        },
        now,
      ),
    ).toMatchObject({ status: 'verified', reader: 'perfectmind', timeZone: 'America/Toronto' });
  });
  it('uses the same fetched bytes for cycles and caches only within this operation', async () => {
    let fetches = 0;
    let calls = 0;
    const ports = {
      fetchBody: async () => {
        fetches++;
        return text;
      },
      extract: async (input: CycleIdentity) => {
        calls++;
        expect(input).not.toHaveProperty('openAt');
        expect(input.referenceDate).toBe('2026-10-10');
        return extraction;
      },
    };
    const reader = createRegistrationReader(ports);
    await reader(target, now);
    await reader(target, now);
    await reader({ ...target, cycleLabel: 'other known cycle' }, now);
    expect([fetches, calls]).toEqual([1, 2]);
    await createRegistrationReader(ports)(target, now);
    expect([fetches, calls]).toEqual([2, 3]);
  });
  it('accepts a quoted venue zone but never an unquoted model zone', async () => {
    const reader = createRegistrationReader({
      fetchBody: async () => text,
      extract: async () => extraction,
    });
    expect(await reader(target, now)).toMatchObject({
      status: 'verified',
      timeZone: 'America/New_York',
    });
    const bad = createRegistrationReader({
      fetchBody: async () => text,
      extract: async () => ({ ...extraction, timeZoneEvidence: 'London venue' }),
    });
    expect(await bad(target, now)).toMatchObject({
      status: 'unverified',
      reason: 'unknown_time_zone',
      timeZone: null,
    });
  });
  it('refuses unsafe targets before the fetch and does not turn fetch/extraction failure into dates', async () => {
    const reader = createRegistrationReader({
      fetchBody: async () => {
        throw new Error('network');
      },
      extract: async () => extraction,
    });
    expect(await reader(target, now)).toMatchObject({
      status: 'unreadable',
      reason: 'fetch_failed',
    });
    expect(
      await reader({ ...target, sourceUrl: 'https://127.0.0.1/private' }, now),
    ).not.toHaveProperty('dates');
    const bad = createRegistrationReader({
      fetchBody: async () => text,
      extract: async () => {
        throw new Error('provider');
      },
    });
    expect(await bad(target, now)).toMatchObject({
      status: 'unreadable',
      reason: 'extract_failed',
    });
  });
  it('bounds distinct reads without labelling budget exhaustion a missing published date', async () => {
    const reader = createRegistrationReader({
      fetchBody: async () => text,
      extract: async () => extraction,
    });
    for (let n = 0; n < 24; n++) await reader({ ...target, cycleLabel: `cycle ${n}` }, now);
    expect(await reader({ ...target, cycleLabel: 'overflow' }, now)).toMatchObject({
      status: 'unreadable',
      reason: 'read_budget',
    });
  });
  it('discarded DB dates never survive a current projection; resident-only pages require known eligibility', async () => {
    const window = {
      municipality: 'markham',
      programDomain: 'swim',
      cycleLabel: 'Fall',
      district: null,
      sourceUrl: target.sourceUrl,
      openAt: new Date('2026-01-01'),
      residentOpenAt: new Date('2026-01-01'),
      previewAt: null,
    } as RegistrationSourceState;
    const reader = createRegistrationReader({
      fetchBody: async () => text,
      extract: async () => ({
        ...extraction,
        generalOpen: null,
        residentOpen: extraction.generalOpen,
      }),
    });
    expect(await readRegistrationWindows([window], reader, now, 'L4J')).toEqual([]);
    expect((await readRegistrationWindows([window], reader, now, 'L3R'))[0]).toMatchObject({
      openAt: new Date('2026-10-20T13:00:00Z'),
      residentOpenAt: new Date('2026-10-20T13:00:00Z'),
    });
  });
  it('date-only on the current source day is not falsely called already open', async () => {
    const reading = await createRegistrationReader({
      fetchBody: async () => text,
      extract: async () => extraction,
    })(target, now);
    expect(
      registrationHasOpened(
        reading,
        { kind: 'general_open', date: '2026-10-10', time: null, evidence: [] },
        new Date('2026-10-10T23:00:00Z'),
      ),
    ).toBe(false);
  });
  it('retains a portal town’s verified date without promoting unknown eligibility to public access', async () => {
    const reader = createRegistrationReader({
      fetchBody: async () => text,
      extract: async () => extraction,
    });
    const reading = await reader({ ...target, residentTiers: true }, now);
    expect(reading).toMatchObject({
      status: 'verified',
      dates: [{ kind: 'unclassified_open', date: '2026-10-20', time: '09:00' }],
    });
    expect(registrationDate(reading, false)).toBeNull();
    expect(registrationDate(reading, true)).toBeNull();
    const window = {
      ...target,
      municipality: 'markham',
      district: null,
    } as unknown as RegistrationSourceState;
    expect(await readRegistrationWindows([window], reader, now, 'L3R')).toEqual([]);
  });
  it('keeps known-host eligibility checks when intake supplies only a generic URL target', async () => {
    const reader = createRegistrationReader({
      fetchBody: async () => text,
      extract: async () => extraction,
    });
    for (const host of ['www.markham.ca', 'oakville.ca', 'cityofmarkham.perfectmind.com']) {
      expect(
        await reader(
          { ...target, municipality: host, sourceUrl: `https://${host}/registration` },
          now,
        ),
      ).toMatchObject({ status: 'verified', dates: [{ kind: 'unclassified_open' }] });
    }
    expect(
      await reader(
        { ...target, sourceUrl: 'https://markham.ca.attacker.example/registration' },
        now,
      ),
    ).toMatchObject({ status: 'verified' });
  });
});
