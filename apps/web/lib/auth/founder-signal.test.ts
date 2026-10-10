import { afterEach, describe, expect, it, vi } from 'vitest';
import { founderAddress } from './founder-signal';

describe('founderAddress', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('prefers FOUNDER_ALERT_EMAIL', () => {
    vi.stubEnv('FOUNDER_ALERT_EMAIL', 'founder@villagehale.com');
    vi.stubEnv('WELCOME_BCC', 'bcc@villagehale.com');
    expect(founderAddress()).toBe('founder@villagehale.com');
  });

  it('falls back to WELCOME_BCC when the explicit address is unset', () => {
    vi.stubEnv('FOUNDER_ALERT_EMAIL', '');
    vi.stubEnv('WELCOME_BCC', '  bcc@villagehale.com  ');
    expect(founderAddress()).toBe('bcc@villagehale.com');
  });

  it('is null when neither address is set', () => {
    vi.stubEnv('FOUNDER_ALERT_EMAIL', '');
    vi.stubEnv('WELCOME_BCC', '   ');
    expect(founderAddress()).toBeNull();
  });
});
