/**
 * Browser Use's residential proxy is off by default: Hale's runs go direct
 * (`proxyCountryCode: null`), which avoids residential bandwidth charges. A
 * provider whose site blocks datacenter traffic is switched back on here by
 * its registrable host, with the proxy country to use. Empty today.
 */
export const BROWSER_USE_RESIDENTIAL_PROXY_HOSTS: Readonly<Record<string, string>> = {};

/** The proxy country for this provider, or null to run without a proxy. */
export function browserUseProxyFor(
  providerHost: string,
  hosts: Readonly<Record<string, string>> = BROWSER_USE_RESIDENTIAL_PROXY_HOSTS,
): string | null {
  const key = providerHost
    .trim()
    .toLowerCase()
    .replace(/^www\./, '');
  const country = hosts[key];
  return country && /^[a-z]{2}$/.test(country) ? country : null;
}
