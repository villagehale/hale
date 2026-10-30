import { describe, expect, it } from 'vitest';
import { assertNoInventedFacts, findInventedFacts } from './facts-lint';

/**
 * VIL-229 · the voice-slot fact guard. Facts (times, links) are INJECTED, never
 * generated — this lint catches a voice string that invents one not present in the
 * fact slots it was handed, so composeVoice can degrade to the deterministic copy.
 */
describe('findInventedFacts', () => {
  it('catches a time not present in any slot', () => {
    const text = "your checkup is at 3:30 — see you then";
    const slots = ["Mira's 18-month checkup", '2026-07-24'];
    expect(findInventedFacts(text, slots)).toEqual(['3:30']);
  });

  it('passes when every time and link appears in a slot', () => {
    const text = 'swim is at 4:30, details at https://app.villagehale.com/plan';
    const slots = ['Saturday family swim 4:30', 'https://app.villagehale.com/plan'];
    expect(findInventedFacts(text, slots)).toEqual([]);
  });

  it('catches an invented URL not in any slot', () => {
    const text = 'book it here: https://evil.example.com/signup';
    const slots = ['https://app.villagehale.com/plan'];
    expect(findInventedFacts(text, slots)).toEqual(['https://evil.example.com/signup']);
  });

  it('trims trailing sentence punctuation off a URL before matching its slot', () => {
    const text = 'open your week at https://app.villagehale.com/plan.';
    const slots = ['https://app.villagehale.com/plan'];
    expect(findInventedFacts(text, slots)).toEqual([]);
  });

  it('passes on empty text', () => {
    expect(findInventedFacts('', ['whatever'])).toEqual([]);
  });

  it('passes on prose that carries no time or link', () => {
    expect(findInventedFacts('a calm, quiet week ahead', [])).toEqual([]);
  });
});

describe('assertNoInventedFacts', () => {
  it('throws when a fact is invented', () => {
    expect(() => assertNoInventedFacts('meet at 9:15', ['no times here'])).toThrow(/invented facts/);
  });

  it('does not throw when all facts are grounded', () => {
    expect(() => assertNoInventedFacts('meet at 9:15', ['drop-off 9:15'])).not.toThrow();
  });
});
