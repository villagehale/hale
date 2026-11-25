import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  POSTHOG_REPLAY_ENABLED_ENV,
  POSTHOG_WEB_ENABLED_ENV,
  posthogReplayEnabled,
  posthogWebEnabled,
} from './flags';

describe('PostHog web/replay flags (marketing site)', () => {
  it('share the portal names and the exact-true parser', () => {
    expect(POSTHOG_WEB_ENABLED_ENV).toBe('NEXT_PUBLIC_POSTHOG_WEB_ENABLED');
    expect(POSTHOG_REPLAY_ENABLED_ENV).toBe('NEXT_PUBLIC_POSTHOG_REPLAY_ENABLED');
    expect(posthogWebEnabled({ [POSTHOG_WEB_ENABLED_ENV]: 'true' })).toBe(true);
    expect(posthogWebEnabled({ [POSTHOG_WEB_ENABLED_ENV]: 'true\n' })).toBe(false);
    expect(posthogReplayEnabled({ [POSTHOG_REPLAY_ENABLED_ENV]: 'TRUE' })).toBe(false);
  });
});

describe('the browser reads these flags', () => {
  // Next.js inlines only a literal process.env.NEXT_PUBLIC_* into browser code; a lookup
  // by a variable name is undefined there. Vitest runs in Node, where both forms read the
  // same object, so only the source can show which form the browser gets.
  it('names each NEXT_PUBLIC variable literally on the default path', () => {
    const source = readFileSync(new URL('./flags.ts', import.meta.url), 'utf8');
    expect(source).toContain('process.env.NEXT_PUBLIC_POSTHOG_WEB_ENABLED');
    expect(source).toContain('process.env.NEXT_PUBLIC_POSTHOG_REPLAY_ENABLED');
    expect(source).not.toMatch(/=\s*process\.env\)/);
  });
});
