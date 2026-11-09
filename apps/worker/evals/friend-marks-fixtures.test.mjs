import { describe, expect, it } from 'vitest';
import { FRIEND_MARKS_FIXTURES, friendMarksMisses } from './friend-marks-fixtures.mjs';

const join = FRIEND_MARKS_FIXTURES.find((fixture) => fixture.id === 'coparent-yes-join');
const zh = FRIEND_MARKS_FIXTURES.find((fixture) => fixture.id === 'email-question-zh');
const fr = FRIEND_MARKS_FIXTURES.find((fixture) => fixture.id === 'email-question-fr');

describe('friendMarksMisses', () => {
  it('passes a co-parent yes that points below', () => {
    expect(
      friendMarksMisses(join, { asks: false, parentQuestion: false, joinPointer: 'below' }),
    ).toEqual([]);
  });

  it('fails when the pointer the send depends on is omitted', () => {
    expect(friendMarksMisses(join, { asks: false, parentQuestion: false })).toEqual([
      'joinPointer:omitted',
      'joinPointer:null',
    ]);
  });

  it('fails a pointer that is not below, and a value outside the enum', () => {
    expect(
      friendMarksMisses(join, { asks: false, parentQuestion: false, joinPointer: 'missing' }),
    ).toEqual(['joinPointer:"missing"']);
    expect(
      friendMarksMisses(join, { asks: false, parentQuestion: false, joinPointer: 'under' }),
    ).toEqual(['joinPointer:omitted', 'joinPointer:"under"']);
  });

  it('fails a question read as agreement, and an omitted asks', () => {
    expect(
      friendMarksMisses(zh, { asks: true, parentQuestion: true, connectorsOffered: ['gmail'] }),
    ).toEqual([]);
    expect(friendMarksMisses(zh, { parentQuestion: false, connectorsOffered: ['gmail'] })).toEqual([
      'asks:omitted',
      'parentQuestion:false',
    ]);
  });

  it('fails a question turned into a yes the code would keep', () => {
    const marks = { asks: true, connectorsOffered: ['gmail'] };
    expect(friendMarksMisses(fr, { ...marks, parentQuestion: false, connectGmail: null })).toEqual(
      [],
    );
    expect(friendMarksMisses(fr, { ...marks, parentQuestion: true, connectGmail: true })).toEqual(
      [],
    );
    expect(friendMarksMisses(fr, { ...marks, parentQuestion: false, connectGmail: true })).toEqual([
      'connectGmail:yes_kept',
    ]);
  });

  it('fails a calendar ask that offers Gmail under the calendar link', () => {
    const marks = { asks: true, parentQuestion: false };
    const calendar = FRIEND_MARKS_FIXTURES.find((fixture) => fixture.id === 'calendar-yes');
    expect(friendMarksMisses(calendar, { ...marks, connectorsOffered: ['calendar'] })).toEqual([]);
    expect(
      friendMarksMisses(calendar, { ...marks, connectorsOffered: ['calendar', 'gmail'] }),
    ).toEqual(['connectorsOffered:["calendar","gmail"]']);
  });
});
