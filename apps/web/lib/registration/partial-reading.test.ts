import { describe, expect, it } from 'vitest';
import { officialPageReply } from '~/lib/channel/intake/official-page';
import { loadCronSkill } from '~/lib/cron/skill';
import { normalizeExtractedRegistration } from './live-reading';
import { registrationDate } from './read';
import { registrationReminderContext } from './sequence/compose';
import { registrationLinkReplyContext } from './sequence/link-reply';
import { messageDatesMatch } from './sequence/message-dates';
import { decideRegistrationRefresh } from './sequence/refresh';
import { courseShortlist } from './sequence/shortlist';
import { EXTRACTION_JSON_SCHEMA, parseExtraction } from './verify-window';

const sourceUrl = 'https://example.org/registration';
const now = new Date('2026-10-20T12:00:00Z');
const page = 'Registration opens December 7.';
const note = 'The page does not establish the registration year or eligibility.';
const raw = {
  found: true,
  reason: null,
  cycle_on_page: 'Registration',
  year_evidence: null,
  preview: null,
  resident_open: null,
  general_open: null,
  unclassified_open: { date_text: 'December 7', date: null, time: null, note },
  evidence: page,
  note,
  confidence: 0.9,
};
function reading(overrides = {}) {
  return normalizeExtractedRegistration(
    { ok: true, extracted: parseExtraction({ ...raw, ...overrides }), pageText: page },
    { sourceUrl, checkedAt: now, timeZone: 'America/Toronto' },
  );
}

// Synthetic boundary inputs test parsing, provenance and handoff, not model quality.
describe('partial published registration dates', () => {
  it('removes the absolute prohibitions and documents source-context years and partial facts', async () => {
    const { instructions } = await loadCronSkill('verify-registration-window');
    expect(instructions).not.toContain('A month/day alone is never enough.');
    expect(instructions).not.toContain('never infer it.');
    expect(instructions).toContain('same contiguous block');
    expect(instructions).toContain('date_text');
    expect(instructions).toContain('note');
    expect(instructions).not.toContain('when you are not sure, say you did not find it.');
  });
  it('retains raw date text and note without admitting a nullable date to scheduling', () => {
    const extracted = parseExtraction(raw);
    expect(extracted.unclassifiedOpen).toBeNull();
    expect(extracted.partialDates).toEqual([
      { kind: 'unclassified_open', dateText: 'December 7', note },
    ]);
    expect(EXTRACTION_JSON_SCHEMA.$defs.publishedDate.properties.date_text).toBeDefined();
    expect(EXTRACTION_JSON_SCHEMA.properties.note).toBeDefined();
    const current = reading();
    expect(current).toMatchObject({
      status: 'unverified',
      reason: 'incomplete_date',
      note,
      partialDates: [{ kind: 'unclassified_open', dateText: 'December 7', note, evidence: [page] }],
    });
    expect(registrationDate(current, true)).toBeNull();
    expect(registrationDate(current, false)).toBeNull();
    const decision = decideRegistrationRefresh(
      { anchor: null, pending: null, pausedAt: null, reviewApproved: false },
      current,
      false,
      now,
    );
    expect(decision).toMatchObject({ paused: true, anchor: null, publishedTime: false });
  });

  it('keeps the raw text alongside a resolved date and does not require rewriting older records', () => {
    const extracted = parseExtraction({
      ...raw,
      year_evidence: 'December 7, 2026',
      unclassified_open: {
        date_text: 'December 7, 2026',
        date: '2026-12-07',
        time: null,
        note: null,
      },
    });
    expect(extracted.unclassifiedOpen).toEqual({
      date: '2026-12-07',
      time: null,
      dateText: 'December 7, 2026',
      note: null,
    });
    expect(
      parseExtraction({
        ...raw,
        note: undefined,
        unclassified_open: { date: '2026-12-07', time: null },
      }).unclassifiedOpen,
    ).toEqual({ date: '2026-12-07', time: null });
  });

  it('rejects invented raw dates and non-contiguous quotes, even for a partial reading', () => {
    expect(
      reading({ unclassified_open: { date_text: 'December 8', date: null, time: null, note } }),
    ).toMatchObject({ status: 'unverified', reason: 'uncorroborated' });
    expect(reading({ year_evidence: 'Registration ... December 7.' })).toMatchObject({
      status: 'unverified',
      reason: 'uncorroborated',
    });
    expect(reading({ evidence: 'Registration opens December 8.' })).not.toHaveProperty(
      'partialDates',
    );
    expect(reading({ confidence: 0.2 })).not.toHaveProperty('partialDates');
  });

  it('does not discard an independently verified date because another date lacks a year', () => {
    const text = `${page} Non-resident registration opens December 11, 2026.`;
    const current = normalizeExtractedRegistration(
      {
        ok: true,
        pageText: text,
        extracted: parseExtraction({
          ...raw,
          evidence: text,
          year_evidence: 'Non-resident registration opens December 11, 2026.',
          general_open: { date: '2026-12-11', time: null },
        }),
      },
      { sourceUrl, checkedAt: now, timeZone: 'America/Toronto' },
    );
    expect(current).toMatchObject({
      status: 'verified',
      dates: [{ kind: 'general_open', date: '2026-12-11' }],
      partialDates: [{ dateText: 'December 7', note }],
    });
  });

  it('accepts a resolved King date backed by the sibling registration sentence, without granting eligibility', () => {
    const text =
      'Registration opens on December 7. Aquatics program registration for non-residents opens on December 11, 2026.';
    const current = normalizeExtractedRegistration(
      {
        ok: true,
        pageText: text,
        extracted: parseExtraction({
          ...raw,
          cycle_on_page: 'Winter 2027',
          evidence: text,
          year_evidence:
            'Aquatics program registration for non-residents opens on December 11, 2026.',
          general_open: { date: '2026-12-11', time: null },
          unclassified_open: {
            date_text: 'December 7',
            date: '2026-12-07',
            time: null,
            note: 'Eligibility is not specified for December 7.',
          },
        }),
      },
      { sourceUrl, checkedAt: now, timeZone: 'America/Toronto' },
    );
    expect(current).toMatchObject({
      status: 'verified',
      dates: [
        { kind: 'general_open', date: '2026-12-11' },
        { kind: 'unclassified_open', date: '2026-12-07', dateText: 'December 7' },
      ],
    });
    expect(registrationDate(current, false)?.date).toBe('2026-12-11');
  });

  it('passes partial facts and notes to link and reminder writers without a full opening', () => {
    const current = reading();
    const link = registrationLinkReplyContext({
      outcome: 'registration_reminder_proposed',
      language: 'en',
      parentWords: 'When does registration open?',
      sourceUrl,
      reading: current,
    });
    expect(link).toMatchObject({
      opening: null,
      dateRemindersPaused: true,
      partialDates: [{ dateText: 'December 7', note }],
      note,
    });
    const reminder = registrationReminderContext({
      leg: 'heads_up',
      resident: false,
      reading: current,
      change: null,
      copy: {
        shortlist: courseShortlist('test-sequence', sourceUrl, now),
        now,
        timeZone: 'America/Toronto',
        optIn: 'opted_in',
        anchor: now,
        portal: null,
        readinessReady: null,
        prep: null,
      },
    });
    expect(reminder).toMatchObject({
      opening: null,
      partialDates: [{ dateText: 'December 7', note }],
      note,
    });
  });

  it('answers with the printed month/day, uncertainty and source instead of saying nothing was found', () => {
    const body = officialPageReply(reading(), '');
    expect(body).toContain('December 7');
    expect(body).toContain('year');
    expect(body).toContain(note);
    expect(body).toContain(sourceUrl);
    expect(body).not.toMatch(/2026-12-07|couldn't verify the current date|no dates/i);
  });

  it('allows a source-backed unresolved date in copy but still holds a fabricated year or clock', () => {
    const body = 'The page lists December 7; the year is unconfirmed.';
    const parsed = {
      date: null,
      time: null,
      timeZone: null,
      weekday: null,
      confidence: 'low' as const,
      evidence: { date: 'December 7', time: null, timeZone: null, weekday: null },
    };
    const partial = [{ dateText: 'December 7', timeZone: 'America/Toronto' }];
    expect(messageDatesMatch(body, [parsed], null, [], partial)).toBe(true);
    expect(
      messageDatesMatch(
        body,
        [parsed],
        { date: '2026-12-11', time: null, timeZone: 'America/Toronto', timePublished: false },
        [],
        partial,
      ),
    ).toBe(false);
    expect(messageDatesMatch(body, [parsed], null)).toBe(false);
    expect(messageDatesMatch(body, [{ ...parsed, date: '2026-12-07' }], null, [], partial)).toBe(
      false,
    );
    expect(messageDatesMatch(body, [{ ...parsed, time: '09:00' }], null, [], partial)).toBe(false);
    expect(
      messageDatesMatch(
        body,
        [{ ...parsed, evidence: { ...parsed.evidence, date: 'December 8' } }],
        null,
        [],
        partial,
      ),
    ).toBe(false);
  });
});
