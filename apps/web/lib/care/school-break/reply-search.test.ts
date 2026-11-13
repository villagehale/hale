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
    first_day_text: 'dec 21',
    last_day: '2027-01-01',
    last_day_text: 'jan 1',
    back_day: null,
    back_day_text: null,
    name: 'winter break',
    confidence: 'high',
  };

  it('files both days when the parent gave them, quoted from their own words', () => {
    expect(toSchoolBreakReplyReading(read, TEXT, '2026-27')).toMatchObject({
      status: 'read',
      firstDay: '2026-12-21',
      lastDay: '2027-01-01',
      quote: 'dec 21 to jan 1',
    });
  });

  it('files the name only when the parent wrote it: none is made up', () => {
    // The model named it, the parent did not.
    expect(toSchoolBreakReplyReading(read, TEXT, '2026-27')).toMatchObject({ name: null });
    const named = 'winter break is dec 21 to jan 1 for us';
    expect(toSchoolBreakReplyReading(read, named, '2026-27')).toMatchObject({
      status: 'read',
      name: 'winter break',
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
        {
          quote: null,
          first_day: null,
          first_day_text: null,
          last_day: null,
          last_day_text: null,
          back_day: null,
          back_day_text: null,
          name: null,
          confidence: 'low',
        },
        "she's at Maple Grove",
        '2026-27',
      ),
    ).toEqual({ status: 'nothing_stated' });
  });

  it('files the day before the day they are back, when that is the day the parent gave', () => {
    const back = 'dec 19, and they go back jan 5';
    const reading = {
      ...read,
      quote: back,
      first_day: '2026-12-19',
      first_day_text: 'dec 19',
      last_day: null,
      last_day_text: null,
      back_day: '2027-01-05',
      back_day_text: 'jan 5',
    };
    expect(toSchoolBreakReplyReading(reading, back, '2026-27')).toEqual({
      status: 'read',
      firstDay: '2026-12-19',
      lastDay: '2027-01-04',
      name: null,
      quote: back,
    });
    // The day back is held to the same grammar: its words must state exactly that day.
    expect(
      toSchoolBreakReplyReading({ ...reading, back_day: '2027-01-04' }, back, '2026-27'),
    ).toEqual({ status: 'nothing_stated' });
    // Two answers for the end of the break is no answer.
    expect(
      toSchoolBreakReplyReading(
        { ...reading, last_day: '2027-01-01', last_day_text: 'jan 5' },
        back,
        '2026-27',
      ),
    ).toEqual({ status: 'nothing_stated' });
  });

  it("files nothing when the days are not stated in the parent's own words", () => {
    const vague = 'not sure, around christmas i think';
    expect(
      toSchoolBreakReplyReading(
        {
          ...read,
          quote: 'around christmas',
          first_day_text: 'around christmas',
          last_day_text: 'around christmas',
          first_day: '2026-12-21',
          last_day: '2027-01-01',
        },
        vague,
        '2026-27',
      ),
    ).toEqual({ status: 'nothing_stated' });
    // A day span that states another day than the one filed.
    expect(
      toSchoolBreakReplyReading({ ...read, first_day: '2026-12-18' }, TEXT, '2026-27'),
    ).toEqual({ status: 'nothing_stated' });
    // A day span the quote does not carry.
    expect(toSchoolBreakReplyReading({ ...read, last_day_text: 'jan 4' }, TEXT, '2026-27')).toEqual(
      { status: 'nothing_stated' },
    );
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
