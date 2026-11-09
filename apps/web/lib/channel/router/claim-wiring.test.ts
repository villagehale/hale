import type { Database } from '@hale/db';
import { describe, expect, it } from 'vitest';
import { defaultClaimEnforcer } from '~/lib/channel/reconcile/claim-enforce';
import { defaultClaimShadow } from '~/lib/channel/reconcile/claim-shadow';
import { channelRouterDeps } from './wiring';

/** VIL-581 · the production router binds the process-wide claim shadow and enforcer, so
 * the flag (not a test seam) decides what reads, and the shadow's in-flight bound is
 * shared by every turn. */
describe('router wiring · claim reader', () => {
  it('binds the default shadow and the default enforcer', () => {
    const deps = channelRouterDeps({} as Database);
    expect(deps.claimShadow).toBe(defaultClaimShadow());
    expect(deps.claimEnforcer).toBe(defaultClaimEnforcer());
  });
});
