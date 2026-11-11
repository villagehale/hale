import { signupProviderHost } from '../consent';
import { registrationAssistedRunEnabled } from './flag';

/**
 * VIL-558 · where Hale carries a plan out end to end. PerfectMind towns come first
 * (Barton's 11-04 decision): Markham and Oakville open Tue Dec 1. A host is added
 * here only once its own registration flow has passed a live check.
 */
export const PLAN_AUTO_HOSTS: readonly string[] = [
  'cityofmarkham.perfectmind.com',
  'townofoakville.perfectmind.com',
];

/**
 * VIL-558 step 6 · ActiveNet (Canada and US), where Hale prepares the registration and the
 * parent submits it. ACTIVE's terms bar automated sign-in, add-to-cart and checkout without
 * ACTIVE's written consent, so Hale never signs in, adds to the cart, submits or pays there:
 * it fills, then hands over the browser. A reCAPTCHA met while filling is left to Browser
 * Use's solver (Barton, for launch), not handed to the parent.
 */
export const PLAN_ASSISTED_HOSTS: readonly string[] = [
  'anc.ca.apm.activecommunities.com',
  'apm.activecommunities.com',
];

/**
 * `auto`: Hale registers and pays at the open. `assisted`: Hale fills at the open and the
 * parent submits and pays. `parent`: no plan; the parent registers.
 */
export type PlanMode = 'auto' | 'assisted' | 'parent';

export function planModeFor(
  hostname: string,
  autoHosts: readonly string[] = PLAN_AUTO_HOSTS,
): PlanMode {
  const host = signupProviderHost(hostname);
  if (autoHosts.includes(host)) return 'auto';
  if (registrationAssistedRunEnabled() && PLAN_ASSISTED_HOSTS.includes(host)) return 'assisted';
  return 'parent';
}

/** How a plan's texts describe it. A town whose switch went off since is told as assisted. */
export function planReplyMode(registrationUrl: string): 'auto' | 'assisted' {
  return planModeFor(new URL(registrationUrl).hostname) === 'auto' ? 'auto' : 'assisted';
}
