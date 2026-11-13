import { describe, expect, it } from 'vitest';
import { onOfficialHost, officialHostOf } from './host';
import { type SchoolBreakExtraction, checkBreakReading, createBreakPageReader } from './read';

/**
 * The code half of the board-page read: whether a model's reading stands on the page.
 * The model half is the school-break eval's (hard rule #8); here every extraction is
 * written out by hand, and each refusal has its positive control beside it.
 */

const PAGE = `Example District School Board
2026-2027 School Year Calendar
First day of school: September 2, 2026
PA Day: Friday, November 13, 2026
Winter Break: December 21, 2026 to January 1, 2027
Classes resume: January 4, 2027`;

const RANGE = 'Winter Break: December 21, 2026 to January 1, 2027';

function extraction(over: Partial<SchoolBreakExtraction> = {}): SchoolBreakExtraction {
  return {
    board_on_page: 'Example District School Board',
    name: 'Winter Break',
    year_evidence: '2026-2027 School Year Calendar',
    first_day: { quote: RANGE, date_text: 'December 21, 2026', date: '2026-12-21' },
    last_day: { quote: RANGE, date_text: 'January 1, 2027', date: '2027-01-01' },
    found: true,
    ...over,
  };
}

describe('checkBreakReading', () => {
  it('keeps a break whose days, years and name are all on the page', () => {
    expect(checkBreakReading(extraction(), PAGE, '2026-27')).toEqual({
      name: 'Winter Break',
      firstDay: { date: '2026-12-21', quote: RANGE },
      lastDay: { date: '2027-01-01', quote: RANGE },
    });
  });

  it('reads a page that names no winter break as not published', () => {
    expect(
      checkBreakReading(
        extraction({ found: false, first_day: null, last_day: null, name: null }),
        PAGE,
        '2026-27',
      ),
    ).toBe('not_published');
  });

  it('refuses a quote the page does not carry', () => {
    const invented = 'Winter Break: December 18, 2026 to January 1, 2027';
    expect(
      checkBreakReading(
        extraction({
          first_day: { quote: invented, date_text: 'December 18, 2026', date: '2026-12-18' },
        }),
        PAGE,
        '2026-27',
      ),
    ).toEqual({ refused: 'quote_off_page' });
  });

  it('refuses a day its own quote does not state', () => {
    expect(
      checkBreakReading(
        extraction({
          first_day: { quote: RANGE, date_text: 'December 21, 2026', date: '2026-12-22' },
        }),
        PAGE,
        '2026-27',
      ),
    ).toEqual({ refused: 'day_mismatch' });
  });

  it('refuses a year the page never prints', () => {
    const yearless = 'Winter Break Dec 21 - Jan 1';
    const page = `Example board calendar\n${yearless}`;
    const reading = extraction({
      year_evidence: null,
      first_day: { quote: yearless, date_text: 'Dec 21', date: '2026-12-21' },
      last_day: { quote: yearless, date_text: 'Jan 1', date: '2027-01-01' },
    });
    expect(checkBreakReading(reading, page, '2026-27')).toEqual({ refused: 'year_unstated' });
    // Positive control: the same yearless days with the school year printed stand.
    const dated = `Example board calendar 2026-2027\n${yearless}`;
    expect(
      checkBreakReading({ ...reading, year_evidence: 'calendar 2026-2027' }, dated, '2026-27'),
    ).toMatchObject({ firstDay: { date: '2026-12-21' } });
  });

  it('refuses a PA day dressed as the winter break', () => {
    const pa = 'PA Day: Friday, November 13, 2026';
    expect(
      checkBreakReading(
        extraction({
          name: 'PA Day',
          first_day: { quote: pa, date_text: 'November 13, 2026', date: '2026-11-13' },
          last_day: { quote: pa, date_text: 'November 13, 2026', date: '2026-11-13' },
        }),
        PAGE,
        '2026-27',
      ),
    ).toEqual({ refused: 'not_winter' });
  });

  it("refuses last year's break read for this school year", () => {
    const old = 'Winter Break: December 22, 2025 to January 2, 2026';
    expect(
      checkBreakReading(
        extraction({
          first_day: { quote: old, date_text: 'December 22, 2025', date: '2025-12-22' },
          last_day: { quote: old, date_text: 'January 2, 2026', date: '2026-01-02' },
        }),
        `${PAGE}\n${old}`,
        '2026-27',
      ),
    ).toEqual({ refused: 'not_winter' });
  });

  it('drops a footnote mark printed after the name', () => {
    const marked = 'Winter Break* December 21, 2026 - January 1, 2027 (incl.)';
    expect(
      checkBreakReading(
        extraction({
          name: 'Winter Break*',
          first_day: { quote: marked, date_text: 'December 21, 2026', date: '2026-12-21' },
          last_day: { quote: marked, date_text: 'January 1, 2027', date: '2027-01-01' },
        }),
        `${PAGE}\n${marked}`,
        '2026-27',
      ),
    ).toMatchObject({ name: 'Winter Break' });
  });

  it('refuses a name the page does not print', () => {
    expect(checkBreakReading(extraction({ name: 'Holiday Break' }), PAGE, '2026-27')).toEqual({
      refused: 'name_unusable',
    });
  });
});

describe('the official host', () => {
  it('is the school sender domain, and a page on it or a subdomain of it', () => {
    const host = officialHostOf('Board.Example');
    expect(host).toBe('board.example');
    expect(onOfficialHost('https://board.example/calendar', 'board.example')).toBe(true);
    expect(onOfficialHost('https://www.board.example/calendar', 'board.example')).toBe(true);
  });

  it('is never a look-alike, a suffix, plain http, or a bare TLD', () => {
    expect(onOfficialHost('https://evilboard.example/calendar', 'board.example')).toBe(false);
    expect(onOfficialHost('https://board.example.attacker.test/x', 'board.example')).toBe(false);
    expect(onOfficialHost('http://www.board.example/calendar', 'board.example')).toBe(false);
    expect(onOfficialHost('https://user:pw@board.example/x', 'board.example')).toBe(false);
    expect(officialHostOf('ca')).toBeNull();
    expect(officialHostOf('board.example/calendar')).toBeNull();
  });
});

describe('createBreakPageReader', () => {
  const extractNever = async (): Promise<SchoolBreakExtraction> => {
    throw new Error('the model must not be asked about this page');
  };

  it('never fetches a page off the board host', async () => {
    const fetched: string[] = [];
    const read = createBreakPageReader({
      fetchBody: async (url) => {
        fetched.push(url);
        return { outcome: 'fetched', body: Buffer.from(PAGE) };
      },
      extract: extractNever,
    });
    expect(
      await read({
        url: 'https://holidays.example/ontario-school-breaks',
        officialHost: 'board.example',
        schoolYear: '2026-27',
      }),
    ).toEqual({
      status: 'not_official',
      sourceUrl: 'https://holidays.example/ontario-school-breaks',
    });
    expect(fetched).toEqual([]);
  });

  it('reads a page on the board host and keeps what the page backs', async () => {
    const fetched: string[] = [];
    const read = createBreakPageReader({
      fetchBody: async (url) => {
        fetched.push(url);
        return { outcome: 'fetched', body: Buffer.from(`<html><body>${PAGE}</body></html>`) };
      },
      extract: async () => extraction(),
    });
    const reading = await read({
      url: 'https://www.board.example/calendar',
      officialHost: 'board.example',
      schoolYear: '2026-27',
    });
    expect(fetched).toEqual(['https://www.board.example/calendar']);
    expect(reading).toMatchObject({
      status: 'verified',
      sourceUrl: 'https://www.board.example/calendar',
      firstDay: { date: '2026-12-21' },
      lastDay: { date: '2027-01-01' },
    });
  });

  it('names a busy fetch as busy, never as a page that says nothing', async () => {
    const read = createBreakPageReader({
      fetchBody: async () => ({ outcome: 'busy', reason: 'host_busy' }),
      extract: extractNever,
    });
    expect(
      await read({
        url: 'https://www.board.example/calendar',
        officialHost: 'board.example',
        schoolYear: '2026-27',
      }),
    ).toMatchObject({ status: 'busy', reason: 'host_busy' });
  });
});
