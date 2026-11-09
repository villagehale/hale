import { signupProviderHost } from '../consent';

/**
 * VIL-558 · where Hale carries a plan out end to end. PerfectMind towns come first
 * (Barton's 11-04 decision): Markham and Oakville open Tue Dec 1. A host is added
 * here only once its own registration flow has passed a live check. Every other
 * host is assisted: Hale prepares everything and the parent submits. That includes
 * all ActiveNet towns, which run reCAPTCHA on sign-in and add-to-cart, and Hale
 * never solves or gets around a CAPTCHA.
 */
export const PLAN_AUTO_HOSTS: readonly string[] = [
  'cityofmarkham.perfectmind.com',
  'townofoakville.perfectmind.com',
];

export type PlanMode = 'auto' | 'assisted';

export function planModeFor(
  hostname: string,
  autoHosts: readonly string[] = PLAN_AUTO_HOSTS,
): PlanMode {
  return autoHosts.includes(signupProviderHost(hostname)) ? 'auto' : 'assisted';
}
