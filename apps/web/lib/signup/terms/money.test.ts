import { describe, expect, it } from 'vitest';
import { moneyCentsWritten, parentAmountsIn } from './money';

describe('moneyCentsWritten', () => {
  it.each([
    ['$84.88', [8488]],
    ['84.88 dollars', [8488]],
    ['84.88加元', [8488]],
    ['84.88元', [8488]],
    ['84,88 $', [8488]],
    ['$1,234.50', [123450]],
    ['1 234,50 $', [123450]],
    ['1 234,50 $', [123450]],
    ['CA$97.60', [9760]],
    ['US$12', [1200]],
    ['$84.88 CAD', [8488]],
    ['resident $84.88 or $97.60 non-resident', [8488, 9760]],
    ['the 2027 $98 session', [9800]],
    ['pas plus de 80,50 $', [8050]],
    ['up to 100 bucks', [10000]],
    ['max €90', [9000]],
    ['£45.50', [4550]],
  ])('reads %s', (text, expected) => {
    expect(moneyCentsWritten(text)).toEqual(expected);
  });

  it('reads no money in a date, a time or a bare number', () => {
    expect(moneyCentsWritten('Saturday March 28 at 9:30, 12 spots left')).toEqual([]);
  });
});

describe('parentAmountsIn', () => {
  it.each([
    ['level 3 100 dollars max', [10000]],
    ['$50 100%', [5000]],
    ['1 234,50 $', [23450]],
    ['1\u00A0234,50 $', [123450]],
    ['1\u202F234,50 $', [123450]],
    ['$3,100', [310000]],
    ['pas plus de 80,50\u00A0$', [8050]],
    ['up to 100 bucks', [10000]],
  ])('reads the money in %s, and never joins groups on a plain space', (text, marked) => {
    expect(parentAmountsIn(text).marked).toEqual(marked);
  });

  it('keeps each bare number apart, for a limit written with no currency', () => {
    expect(parentAmountsIn('level 3 100 max').bare).toEqual([300, 10000]);
  });
});
