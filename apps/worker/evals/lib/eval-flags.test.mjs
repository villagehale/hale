import { describe, expect, it } from 'vitest';
import { parseEvalArgs, parseEvalFlags } from './eval-flags.mjs';

const IDS = ['a-case', 'b-case', 'c-case'];

describe('parseEvalArgs --only', () => {
  it('returns only=null when absent', () => {
    expect(parseEvalArgs(['--dry'], IDS)).toEqual({ mode: 'dry', only: null });
  });
  it('accepts one id with any one mode', () => {
    for (const m of ['--dry', '--broken', '--cached-only', '--live']) {
      expect(parseEvalArgs([m, '--only=b-case'], IDS)).toEqual({
        mode: m.slice(2),
        only: ['b-case'],
      });
    }
  });
  it('accepts a comma list in either order and dedupes', () => {
    expect(parseEvalArgs(['--only=a-case,c-case,a-case', '--live'], IDS).only).toEqual([
      'a-case',
      'c-case',
    ]);
  });
  it('still needs exactly one mode', () => {
    expect(() => parseEvalArgs(['--only=a-case'], IDS)).toThrow(/exactly one mode/);
    expect(() => parseEvalArgs(['--dry', '--live', '--only=a-case'], IDS)).toThrow(
      /exactly one mode/,
    );
  });
  it('rejects unknown ids, empty ids, bare or doubled --only', () => {
    expect(() => parseEvalArgs(['--live', '--only=nope'], IDS)).toThrow(/unknown id/);
    expect(() => parseEvalArgs(['--live', '--only='], IDS)).toThrow(/non-empty/);
    expect(() => parseEvalArgs(['--live', '--only=a-case,'], IDS)).toThrow(/non-empty/);
    expect(() => parseEvalArgs(['--live', '--only'], IDS)).toThrow(/--only=/);
    expect(() => parseEvalArgs(['--live', '--only=a-case', '--only=b-case'], IDS)).toThrow(
      /at most once/,
    );
  });
  it('still rejects other unknown flags', () => {
    expect(() => parseEvalArgs(['--live', '--max-usd=1'], IDS)).toThrow(/unknown flag/);
    expect(() => parseEvalFlags(['--live', '--only=a-case'])).toThrow(/unknown flag/);
  });
});
