import { syncFlags } from '@hale/flags';
import { describe, expect, it, vi } from 'vitest';
import { takeoverLinkEnabled } from './flag';

describe('TAKEOVER_LINK_ENABLED is env-only', () => {
  it('a PostHog sync never creates it, while it still creates an ordinary flag', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('a dry sync makes no request');
    }) as unknown as typeof fetch;
    const { flags } = await syncFlags({ dry: true, env: {}, fetchImpl });
    const keys = flags.map((flag) => flag.key);
    expect(keys).toContain('group-reminder-inflight-cancel');
    expect(keys).not.toContain('takeover-link');
  });

  it('is on only for the exact value true, with the PostHog path on', () => {
    const posthog = { POSTHOG_FLAGS_ENABLED: 'true' };
    expect(takeoverLinkEnabled({ ...posthog, TAKEOVER_LINK_ENABLED: 'true' })).toBe(true);
    expect(takeoverLinkEnabled(posthog)).toBe(false);
    expect(takeoverLinkEnabled({ ...posthog, TAKEOVER_LINK_ENABLED: 'true\n' })).toBe(false);
  });
});
