/**
 * Who the signup runner may fill a form for (VIL-375).
 *
 * The allowlist is empty of real providers. The only registered adapter is the
 * local mock, so tests can drive a loopback form. Municipal registration, and
 * ActiveNet, Xplor, and PerfectMind, are not adapters and must not be added:
 * their terms prohibit bots, and their waiting rooms are not something Hale
 * clicks through. Any other host is an assisted handoff — the parent gets the
 * deep link and a prefilled pack and completes the click themselves.
 */

export interface SignupProviderAdapter {
  readonly id: string;
  matches(url: URL): boolean;
}

function loopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

/** The sandbox form served on this machine. Not a municipal or vendor adapter. */
export const LOCAL_MOCK_PROVIDER: SignupProviderAdapter = {
  id: 'local-mock',
  matches(url: URL): boolean {
    return url.protocol === 'http:' && loopbackHost(url.hostname);
  },
};

/**
 * Registered form-fill adapters. Today this is only {@link LOCAL_MOCK_PROVIDER}.
 * A private operator, or a provider with an API, a partnership, or explicit
 * permission, is added here by a later change. Nothing else is.
 */
export const SIGNUP_PROVIDER_ALLOWLIST: readonly SignupProviderAdapter[] = [LOCAL_MOCK_PROVIDER];

export function signupProviderFor(
  href: string,
  allowlist: readonly SignupProviderAdapter[] = SIGNUP_PROVIDER_ALLOWLIST,
): SignupProviderAdapter | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  return allowlist.find((adapter) => adapter.matches(url)) ?? null;
}
