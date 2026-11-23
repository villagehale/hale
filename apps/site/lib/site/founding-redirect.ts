/**
 * villagehale.com/founding → /pricing.
 *
 * The company X post still links here. A second page can drift, so the path is
 * a permanent redirect (Next's `permanent: true` is a 308). English is
 * unprefixed; French is /fr; Chinese is /zh. The request query string is kept
 * because the destination has none of its own.
 */

export interface FoundingRedirect {
  source: string;
  destination: string;
  permanent: true;
}

export function foundingToPricingRedirects(): FoundingRedirect[] {
  const prefixes = ['', '/fr', '/zh'] as const;
  const rules: FoundingRedirect[] = [];
  for (const prefix of prefixes) {
    rules.push(
      { source: `${prefix}/founding`, destination: `${prefix}/pricing`, permanent: true },
      { source: `${prefix}/founding/`, destination: `${prefix}/pricing`, permanent: true },
    );
  }
  return rules;
}
