import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONNECTOR_CARD_UNSENT_RELEASE_ENABLED_ENV,
  connectorCardUnsentReleaseEnabled,
} from './connector-card-unsent-flag';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('CONNECTOR_CARD_UNSENT_RELEASE_ENABLED', () => {
  it('is on only for the exact string true', () => {
    vi.stubEnv(CONNECTOR_CARD_UNSENT_RELEASE_ENABLED_ENV, 'true');
    expect(connectorCardUnsentReleaseEnabled()).toBe(true);
  });

  it.each(['', 'true\n', 'TRUE', 'True', 'on', '1', 'yes', ' false', 'true '])(
    'stays off for %j',
    (value) => {
      vi.stubEnv(CONNECTOR_CARD_UNSENT_RELEASE_ENABLED_ENV, value);
      expect(connectorCardUnsentReleaseEnabled()).toBe(false);
    },
  );

  it('stays off when the variable is unset', () => {
    vi.stubEnv(CONNECTOR_CARD_UNSENT_RELEASE_ENABLED_ENV, undefined);
    expect(connectorCardUnsentReleaseEnabled()).toBe(false);
    expect(connectorCardUnsentReleaseEnabled({})).toBe(false);
  });
});
