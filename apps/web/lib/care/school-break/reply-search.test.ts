import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { lastAskDay, schoolYearOf, winterBreakBounds } from './cycle';
import { toSchoolBreakReplyReading } from './reply';
import { calendarSearchOutcome } from './search';

describe('the school year', () => {
  it('runs September to August', () => {
    expect(schoolYearOf('2026-09-01')).toBe('2026-27');
    expect(schoolYearOf('2026-11-12')).toBe('2026-27');
    expect(schoolYearOf('2027-08-31')).toBe('2026-27');
    expect(schoolYearOf('2026-08-31')).toBe('2025-26');
    expect(winterBreakBounds('2026-27')).toEqual({ earliest: '2026-12-01', latest: '2027-01-31' });
    expect(lastAskDay('2026-27')).toBe('2026-12-15');
  });
});

describe("the parent's reply, checked by code", () => {
  const TEXT = 'I think its dec 21 to jan 1 this year';
  const read = {
    quote: 'dec 21 to jan 1',
    first_day: '2026-12-21',
    last_day: '2027-01-01',
    name: 'winter break',
    confidence: 'high',
  };

  it('files both days when the parent gave them, quoted from their own words', () => {
    expect(toSchoolBreakReplyReading(read, TEXT, '2026-27')).toEqual({
      status: 'read',
      firstDay: '2026-12-21',
      lastDay: '2027-01-01',
      name: 'winter break',
      quote: 'dec 21 to jan 1',
    });
  });

  it('files nothing on less than high confidence, a quote they did not write, or another break', () => {
    expect(toSchoolBreakReplyReading({ ...read, confidence: 'medium' }, TEXT, '2026-27')).toEqual({
      status: 'nothing_stated',
    });
    expect(
      toSchoolBreakReplyReading({ ...read, quote: 'dec 18 to jan 4' }, TEXT, '2026-27'),
    ).toEqual({ status: 'nothing_stated' });
    expect(
      toSchoolBreakReplyReading(
        { ...read, first_day: '2027-03-15', last_day: '2027-03-19' },
        TEXT,
        '2026-27',
      ),
    ).toEqual({ status: 'nothing_stated' });
    expect(
      toSchoolBreakReplyReading(
        { quote: null, first_day: null, last_day: null, name: null, confidence: 'low' },
        "she's at Maple Grove",
        '2026-27',
      ),
    ).toEqual({ status: 'nothing_stated' });
  });
});

function result(url: string): Anthropic.ContentBlock {
  return {
    type: 'web_search_tool_result',
    tool_use_id: 'srvtoolu_1',
    content: [
      { type: 'web_search_result', url, title: 't', encrypted_content: 'e', page_age: null },
    ],
  } as unknown as Anthropic.ContentBlock;
}

function answer(json: unknown): Anthropic.ContentBlock {
  return { type: 'text', text: JSON.stringify(json), citations: null } as Anthropic.ContentBlock;
}

describe('the calendar search, read with no model', () => {
  const PAGE = 'https://www.board.example/calendar';

  it('keeps a page the search returned on the board host', () => {
    expect(
      calendarSearchOutcome(
        [result(PAGE), answer({ board: 'Example DSB', pages: [PAGE] })],
        'board.example',
      ),
    ).toEqual({ outcome: 'pages', boardName: 'Example DSB', urls: [PAGE] });
  });

  it('drops a page no result carried, and a page off the host', () => {
    expect(
      calendarSearchOutcome(
        [
          result(PAGE),
          result('https://holidays.example/breaks'),
          answer({
            board: 'Example DSB',
            pages: ['https://www.board.example/invented', 'https://holidays.example/breaks'],
          }),
        ],
        'board.example',
      ),
    ).toEqual({ outcome: 'none', reason: 'no_calendar_page' });
  });

  it('names a search that returned nothing, and an answer naming no board', () => {
    expect(calendarSearchOutcome([answer({ board: null, pages: [] })], 'board.example')).toEqual({
      outcome: 'none',
      reason: 'no_results',
    });
    expect(
      calendarSearchOutcome([result(PAGE), answer({ board: null, pages: [] })], 'board.example'),
    ).toEqual({ outcome: 'none', reason: 'no_calendar_page' });
  });
});
