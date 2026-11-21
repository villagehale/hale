import { describe, expect, it } from 'vitest';
import { moneyCentsWritten } from './money';

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
  ])('reads %s', (text, expected) => {
    expect(moneyCentsWritten(text)).toEqual(expected);
  });

  it('reads no money in a date, a time or a bare number', () => {
    expect(moneyCentsWritten('Saturday March 28 at 9:30, 12 spots left')).toEqual([]);
  });
});
