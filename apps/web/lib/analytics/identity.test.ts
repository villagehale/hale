import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hashTelemetryId, posthogIdSalt } from './identity';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('hashTelemetryId', () => {
  it('is HMAC-SHA256 hex of the raw id with POSTHOG_ID_SALT', () => {
    vi.stubEnv('POSTHOG_ID_SALT', 'test-salt');
    const expected = createHmac('sha256', 'test-salt').update('family-uuid-1', 'utf8').digest('hex');
    expect(hashTelemetryId('family-uuid-1')).toBe(
      '47d4bd0e8f16f9fae4b33bdf8af9ff328db2b2b9f24408e6f2320c8a7f250f53',
    );
    expect(hashTelemetryId('family-uuid-1')).toBe(expected);
  });

  it('returns null when the salt is missing — the caller skips the event', () => {
    vi.stubEnv('POSTHOG_ID_SALT', '');
    expect(posthogIdSalt()).toBeNull();
    expect(hashTelemetryId('family-uuid-1')).toBeNull();
  });

  it('does not equal an unsalted SHA-256 of the same id', () => {
    vi.stubEnv('POSTHOG_ID_SALT', 'test-salt');
    const hashed = hashTelemetryId('family-uuid-1');
    expect(hashed).not.toBeNull();
    expect(hashed).not.toContain('family');
  });
});
