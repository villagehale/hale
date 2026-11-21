import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  THREAD_ONBOARDING_V2_ENABLED_ENV,
  threadOnboardingV2Enabled,
} from './thread-onboarding-v2';

/**
 * VIL-721 · THREAD_ONBOARDING_V2_ENABLED is on for the exact string `true` and nothing
 * else. Read through @hale/flags at call time, so every case stubs process.env itself.
 */
describe('THREAD_ONBOARDING_V2_ENABLED (VIL-721)', () => {
  beforeEach(() => {
    // The env path under test. The PostHog path is its own flag and stays off here.
    vi.stubEnv('POSTHOG_FLAGS_ENABLED', undefined);
    // The walk rides the friend walk; its own case below turns that off.
    vi.stubEnv('COLD_START_LADDER_ENABLED', 'true');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reads THREAD_ONBOARDING_V2_ENABLED', () => {
    expect(THREAD_ONBOARDING_V2_ENABLED_ENV).toBe('THREAD_ONBOARDING_V2_ENABLED');
  });

  it('is off when unset', () => {
    vi.stubEnv(THREAD_ONBOARDING_V2_ENABLED_ENV, undefined);
    expect(threadOnboardingV2Enabled()).toBe(false);
  });

  it.each(['false', 'TRUE', 'true\n', ' true', '1', ''])('is off for %j', (raw) => {
    vi.stubEnv(THREAD_ONBOARDING_V2_ENABLED_ENV, raw);
    expect(threadOnboardingV2Enabled()).toBe(false);
  });

  it('is on for exactly true', () => {
    vi.stubEnv(THREAD_ONBOARDING_V2_ENABLED_ENV, 'true');
    expect(threadOnboardingV2Enabled()).toBe(true);
  });

  it('stays off while the friend walk it rides is off', () => {
    vi.stubEnv(THREAD_ONBOARDING_V2_ENABLED_ENV, 'true');
    vi.stubEnv('COLD_START_LADDER_ENABLED', undefined);
    expect(threadOnboardingV2Enabled()).toBe(false);
  });

  it('is read on every call, not once at import', () => {
    vi.stubEnv(THREAD_ONBOARDING_V2_ENABLED_ENV, 'true');
    expect(threadOnboardingV2Enabled()).toBe(true);
    vi.stubEnv(THREAD_ONBOARDING_V2_ENABLED_ENV, 'false');
    expect(threadOnboardingV2Enabled()).toBe(false);
  });
});
