import { describe, expect, it } from 'vitest';
import { connectionState } from './connection-state';

/**
 * A connection reads as connected while Hale still holds a credential for it: any
 * row that is not revoked. An `error` row still holds one, so from a privacy angle
 * it is connected.
 */

describe('connectionState', () => {
  it('reads an active row as connected', () => {
    expect(connectionState([{ provider: 'gcal', status: 'active' }], 'gcal')).toBe('connected');
  });

  it('reads an error row as connected, because Hale still holds the credential', () => {
    expect(connectionState([{ provider: 'gmail', status: 'error' }], 'gmail')).toBe('connected');
  });

  it('reads a revoked row as not connected', () => {
    expect(connectionState([{ provider: 'gcal', status: 'revoked' }], 'gcal')).toBe(
      'not_connected',
    );
  });

  it('reads no row as not connected', () => {
    expect(connectionState([], 'gdrive')).toBe('not_connected');
  });

  it('never lets one provider stand in for another', () => {
    const rows = [{ provider: 'gmail', status: 'active' }];
    expect(connectionState(rows, 'gcal')).toBe('not_connected');
    expect(connectionState(rows, 'gmail')).toBe('connected');
  });
});
