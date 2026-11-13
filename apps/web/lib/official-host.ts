import { parse } from 'tldts';

/**
 * Whether a host a structured public source names as an institution's official website
 * (a city's Wikidata P856, a school board's) can be trusted as that institution's own.
 *
 * Two things are required. The host must be the institution's own registrable domain:
 * not a public suffix, not an IP, and not a name under shared hosting, where anyone can
 * make a page (the public-suffix list's private section: github.io, blogspot.com,
 * wixsite.com, netlify.app...). And a second, independent signal must agree: the source's
 * statement carries a reference, or the top result of a live search for the institution
 * sits on the same registrable domain. One unreferenced value is one edit away from
 * pointing anywhere.
 */

/**
 * Page builders, blogs and social sites where anyone can make a page, which the
 * public-suffix list does not list as shared: a site there names the platform's domain,
 * not the institution's. Matched on the name before the suffix, so every country code a
 * platform runs under (blogspot.ca, weebly.ca) is covered by one entry.
 */
const SHARED_PLATFORM_NAMES: ReadonlySet<string> = new Set([
  '000webhostapp',
  'angelfire',
  'blogger',
  'blogspot',
  'edublogs',
  'facebook',
  'glitch',
  'godaddysites',
  'google',
  'hs-sites',
  'instagram',
  'jimdofree',
  'jimdosite',
  'linkedin',
  'linktr',
  'medium',
  'mystrikingly',
  'neocities',
  'ning',
  'site123',
  'squarespace',
  'strikingly',
  'substack',
  'tripod',
  'tumblr',
  'twitter',
  'typepad',
  'webnode',
  'weebly',
  'wix',
  'wordpress',
  'wpengine',
  'youtube',
]);

/** Shared platforms whose name alone is too short or too common to match on. */
const SHARED_PLATFORM_DOMAINS: readonly string[] = ['x.com', 'business.site'];

/** The institution's own registrable domain for a host, or null when it cannot be one. */
export function ownRegistrableDomain(host: string): string | null {
  const parsed = parse(host, { allowPrivateDomains: true });
  if (parsed.isIp || parsed.isPrivate || parsed.domain === null) return null;
  if (SHARED_PLATFORM_DOMAINS.includes(parsed.domain)) return null;
  return parsed.domainWithoutSuffix !== null &&
    SHARED_PLATFORM_NAMES.has(parsed.domainWithoutSuffix)
    ? null
    : parsed.domain;
}

function urlHost(raw: string): string | null {
  try {
    return new URL(raw).hostname;
  } catch {
    return null;
  }
}

export type OfficialHostVerdict =
  | { trusted: true; domain: string; by: 'reference' | 'search' }
  | { trusted: false; reason: 'shared_host' | 'uncorroborated' };

export function verifyOfficialHost(input: {
  host: string;
  /** The source's statement of this website carries a reference. */
  referenced: boolean;
  /** The top result of a live search for the institution, or null with none. */
  topResultUrl: string | null;
}): OfficialHostVerdict {
  const domain = ownRegistrableDomain(input.host);
  if (domain === null) return { trusted: false, reason: 'shared_host' };
  if (input.referenced) return { trusted: true, domain, by: 'reference' };
  const top = input.topResultUrl === null ? null : urlHost(input.topResultUrl);
  if (top !== null && ownRegistrableDomain(top) === domain) {
    return { trusted: true, domain, by: 'search' };
  }
  return { trusted: false, reason: 'uncorroborated' };
}
