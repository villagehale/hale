import { describe, expect, it } from 'vitest';
import { isSourceConnected, toConnectedSourceMap } from './connected.js';

describe('toConnectedSourceMap', () => {
  it('keys each provider to its status', () => {
    const map = toConnectedSourceMap([
      { provider: 'gmail', status: 'active' },
      { provider: 'stripe', status: 'connecting' },
    ]);
    expect(map).toEqual({ gmail: 'active', stripe: 'connecting' });
  });

  it('omits providers with no row (absent → not-yet-connected)', () => {
    const map = toConnectedSourceMap([{ provider: 'gmail', status: 'active' }]);
    expect(map.gcal).toBeUndefined();
  });

  it('lets an active leg win over a non-active one for the same provider', () => {
    // A per-parent expired Gmail leg plus a live one → the source reads connected.
    const map = toConnectedSourceMap([
      { provider: 'gmail', status: 'expired' },
      { provider: 'gmail', status: 'active' },
    ]);
    expect(map.gmail).toBe('active');
  });

  it('is empty for a family with no integrations', () => {
    expect(toConnectedSourceMap([])).toEqual({});
  });
});

describe('isSourceConnected', () => {
  const map = toConnectedSourceMap([
    { provider: 'gmail', status: 'active' },
    { provider: 'stripe', status: 'error' },
  ]);

  it('is true only when the row is active', () => {
    expect(isSourceConnected(map, 'gmail')).toBe(true);
  });

  it('is false for a present-but-not-active row', () => {
    expect(isSourceConnected(map, 'stripe')).toBe(false);
  });

  it('is false for a provider with no row', () => {
    expect(isSourceConnected(map, 'gcal')).toBe(false);
  });

  it('is false for a catalogued source with no provider (null)', () => {
    expect(isSourceConnected(map, null)).toBe(false);
  });
});
