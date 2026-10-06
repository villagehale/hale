import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseModelMode } from './model-mode';

describe('parseModelMode', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([undefined, '', ' ', '\t\n', 'current', ' current '])('returns current for %j', (raw) => {
    expect(parseModelMode(raw, 'test')).toBe('current');
  });

  it.each(['candidate', ' candidate ', '\tcandidate\n'])('accepts explicit %j', (raw) => {
    expect(parseModelMode(raw, 'test')).toBe('candidate');
  });

  it.each(['invalid', 'shadow', 'CANDIDATE', 'true', 'candidate,current'])(
    'rejects %j and logs the routing context',
    (raw) => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(parseModelMode(raw, 'test')).toBe('current');
      expect(log).toHaveBeenCalledWith({ mode: raw }, 'test: invalid model mode; using current');
    },
  );
});
