import { describe, expect, it } from 'vitest';
import { namesAnyIn } from './memory-context';

/**
 * VIL-618. The teen-name check reads every string in a value, never its JSON text: JSON
 * writes a newline as `\n`, so the escape's letter touches the name and hides it from a
 * whole-word match.
 */

const TEEN = ['Tamsin'];

describe('namesAnyIn', () => {
  it('hits a name after a newline inside an object value (positive control)', () => {
    expect(namesAnyIn({ w: 'Ava\nTamsin' }, TEEN)).toBe(true);
  });

  it.each<[string, unknown]>([
    ['a bare string', 'Tamsin has debate'],
    ['after a newline', 'quick one\nTamsin got detention'],
    ['after a tab', 'note:\tTamsin'],
    ['after a carriage return', 'ok\r\nTamsin'],
    ['inside nested arrays', [['x', ['so Tamsin said']]]],
    ['inside an object value', { a: { b: 'met Tamsin today' } }],
    ['as an object key', { Tamsin: 'debate' }],
    ['in an array inside an object after a newline', { list: ['one', 'two\nTamsin'] }],
    ['in another case and with accents', { w: 'TÁMSIN' }],
  ])('names the teen %s', (_label, value) => {
    expect(namesAnyIn(value, TEEN)).toBe(true);
  });

  it.each<[string, unknown]>([
    ['a value with no teen name', { w: 'Ava\nlibrary on Sundays' }],
    ['a name inside a longer word', 'Tamsinfield road'],
    ['numbers, booleans and null', [1, true, null, { n: 2 }]],
  ])('passes %s', (_label, value) => {
    expect(namesAnyIn(value, TEEN)).toBe(false);
  });

  it('names no one when the family has no teen', () => {
    expect(namesAnyIn({ w: 'Tamsin' }, [])).toBe(false);
  });
});
