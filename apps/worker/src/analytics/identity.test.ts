import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hashTelemetryId, posthogIdSalt } from './identity.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('hashTelemetryId', () => {
  it('is HMAC-SHA256 hex of the raw id with POSTHOG_ID_SALT', () => {
    vi.stubEnv('POSTHOG_ID_SALT', 'test-salt');
    const expected = createHmac('sha256', 'test-salt').update('family-uuid-1', 'utf8').digest('hex');
    expect(hashTelemetryId('family-uuid-1')).toBe(expected);
  });

  it('returns null when the salt is missing — the caller skips the event', () => {
    vi.stubEnv('POSTHOG_ID_SALT', '');
    expect(posthogIdSalt()).toBeNull();
    expect(hashTelemetryId('family-uuid-1')).toBeNull();
  });
});
