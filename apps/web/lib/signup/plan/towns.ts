import { signupProviderHost } from '../consent';

/**
 * VIL-558 · any public https provider host uses the generic Browser Use path
 * (Barton, 11/11/2026). Host allowlists and per-platform adapters are gone.
 * PerfectMind / ActiveNet knowledge may be passed to the agent as an optional
 * hint, never as a requirement.
 *
 * These lists are empty on purpose: they used to gate Markham, Oakville and
 * ActiveNet. Callers that still pass `autoHosts` are ignored.
 */
export const PLAN_AUTO_HOSTS: readonly string[] = [];

/** @deprecated Assisted host gating is gone. The assisted engine remains for a later speed-tuned path. */
export const PLAN_ASSISTED_HOSTS: readonly string[] = [];

/**
 * `auto`: Hale's generic Browser Use agent carries the plan. `assisted`: fill
 * and hand the live browser to the parent (never selected by host). `parent`:
 * no host, so no plan.
 */
export type PlanMode = 'auto' | 'assisted' | 'parent';

export function planModeFor(
  hostname: string,
  _autoHosts: readonly string[] = PLAN_AUTO_HOSTS,
): PlanMode {
  return signupProviderHost(hostname).trim() ? 'auto' : 'parent';
}

/** How a plan's texts describe it. Every valid host is the generic auto path. */
export function planReplyMode(registrationUrl: string): 'auto' | 'assisted' {
  return planModeFor(new URL(registrationUrl).hostname) === 'auto' ? 'auto' : 'assisted';
}

/**
 * Registrable domains that host many providers' registration sites (ActiveNet, Amilia,
 * Jackrabbit, PerfectMind, Uplifter). On one of these the domain names the platform, not
 * the provider; a subdomain names the provider, when one does.
 */
export const SHARED_SIGNUP_PLATFORMS: readonly string[] = [
  'activecommunities',
  'amilia',
  'jackrabbitclass',
  'perfectmind',
  'uplifterinc',
];

/** Optional hint only — never a gate. The generic agent may read this. */
export function providerHint(hostname: string): string | null {
  const host = signupProviderHost(hostname);
  if (host.endsWith('.perfectmind.com')) return 'perfectmind';
  if (host === 'anc.ca.apm.activecommunities.com' || host === 'apm.activecommunities.com') {
    return 'activenet';
  }
  if (host.includes('jackrabbit')) return 'jackrabbit';
  if (host.includes('uplifter')) return 'uplifter';
  return null;
}
