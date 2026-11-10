import { describe, expect, it } from 'vitest';
import { dateMovedBody, dateMovedRefusals } from './date-moved-compose';

const LINK = 'https://rec.example.org/springfield';

describe('VIL-423 · the change note: the writer is handed no link, and code appends the page', () => {
  it.each(['  ', `It moved to Friday: ${LINK}`, 'It moved, see bit.ly/x'])(
    'refuses an empty draft or any link shape: %s',
    (text) => {
      expect(dateMovedRefusals(text)).not.toEqual([]);
    },
  );

  it('passes a plain draft with clock times and abbreviations', () => {
    expect(
      dateMovedRefusals('Springfield swim moved from Sun. Sept 20 to Fri. Sept 18 at 10:00 a.m.'),
    ).toEqual([]);
  });

  it('puts the page once, on its own line, after the text', () => {
    expect(dateMovedBody('  It moved to Friday.  ', LINK)).toBe(`It moved to Friday.\n${LINK}`);
  });
});
