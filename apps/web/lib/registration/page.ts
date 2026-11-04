import { lookup } from 'node:dns/promises';
import { type RequestOptions, request } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { REGISTRATION_COURSE_URL_MAX_CHARS } from '@hale/db';
import { MAX_PAGE_BYTES, PAGE_FETCH_TIMEOUT_MS } from './fetch';

const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const)
  blocked.addSubnet(address, prefix, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [address, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
] as const) {
  blocked.addSubnet(address, prefix, 'ipv6');
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  return family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}

/** Byte-equal to the user-agent Node 22's built-in fetch sends, which the sweep fetcher
 * (`createFetchBody`) uses, so a city site sees one Hale client identity. */
export const REGISTRATION_PAGE_USER_AGENT = 'node';
/** Hale's own choice to protect the instance and the city site; not a parent send rule.
 * Per instance, not fleet-wide. */
export const MAX_FETCHES_IN_FLIGHT_PER_HOST = 2;

export type RegistrationUrlRefusal =
  | 'malformed_url'
  | 'credential_link'
  | 'not_https'
  | 'nonstandard_port'
  | 'non_public_host'
  | 'url_too_long'
  /** An ordinary-looking link we still refuse: never call it unsafe to a parent. */
  | 'ambiguous_query_key';
export type RegistrationUrlCheck =
  | { outcome: 'allowed'; url: string }
  | { outcome: 'refused'; reason: RegistrationUrlRefusal };
export type RegistrationPageFetch =
  | { outcome: 'fetched'; body: Buffer }
  /** The validated target; never followed. */
  | { outcome: 'redirected'; location: string }
  | { outcome: 'refused'; reason: RegistrationUrlRefusal | 'non_public_address' | 'too_large' }
  /** Transient and Hale-side: retry later; says nothing about the page. */
  | { outcome: 'busy'; reason: 'host_busy' }
  | { outcome: 'refused'; reason: 'redirect_refused'; target: RegistrationUrlRefusal }
  | { outcome: 'refused'; reason: 'http_status'; status: number }
  | { outcome: 'failed'; reason: 'timeout' | 'network_error' };

// URL keys are URL structure, not parent text. Both sets are written separator-free.
const CREDENTIAL_KEYS = new Set([
  'password',
  'passwd',
  'pwd',
  'accesstoken',
  'authorization',
  'auth',
  'token',
  'jwt',
  'sessionid',
  'jsessionid',
  'phpsessid',
  'apikey',
  'accesskey',
  'awsaccesskeyid',
  'secret',
  'clientsecret',
  'signature',
  'sig',
  'xamzcredential',
  'xamzsignature',
  'xamzsecuritytoken',
  'xgoogcredential',
  'xgoogsignature',
  'otp',
  'magic',
]);
const CREDENTIAL_KEY_SUFFIXES = ['token', 'password'];
const AMBIGUOUS_QUERY_KEYS = new Set(['session', 'code', 'key', 'ticket', 'sid']);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** The base key, then every bracket segment: `user[password]` → `user`, `password`. */
function urlKeySegments(raw: string): string[] {
  return raw
    .toLowerCase()
    .replace(/[-_.]/g, '')
    .split(/[[\]]+/)
    .filter(Boolean);
}

function isCredentialKey(raw: string): boolean {
  return urlKeySegments(raw).some(
    (key) =>
      CREDENTIAL_KEYS.has(key) || CREDENTIAL_KEY_SUFFIXES.some((suffix) => key.endsWith(suffix)),
  );
}

function isAmbiguousKey(raw: string): boolean {
  return AMBIGUOUS_QUERY_KEYS.has(urlKeySegments(raw)[0] ?? '');
}

/** Run by run, so one malformed `%zz` or stray byte cannot leave the rest of the text encoded. */
function decoded(text: string): string {
  return text.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run.replace(/%([0-7][0-9a-f])/gi, (_, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      );
    }
  });
}

/** Keys of `k=v` parts only: a bare `;b` path part has no key. */
function assignedKeys(parts: string[]): string[] {
  return parts
    .filter((part) => part.includes('='))
    .map((part) => decoded(part.slice(0, part.indexOf('='))));
}

/**
 * Every key assigned anywhere in the fragment: the run of key characters right before each
 * `=`, whatever delimits it (`&`, `;`, `/`, a hash route's own `?`). A bare `#auth` anchor
 * assigns nothing, so it has no key.
 */
function fragmentKeys(hash: string): string[] {
  return [...decoded(hash.slice(1)).matchAll(/([^&;?#/=,\s]+)=/g)].map((match) => match[1]!);
}

function carriesCredential(url: URL): boolean {
  return (
    Boolean(url.username || url.password) ||
    [...url.searchParams.keys()].some(isCredentialKey) ||
    fragmentKeys(url.hash).some(isCredentialKey) ||
    // Servlet path parameters (`/reg;jsessionid=…`) never reach searchParams.
    url.pathname
      .split('/')
      .some((segment) => assignedKeys(segment.split(';').slice(1)).some(isCredentialKey))
  );
}

/** The parser already lowercases; `example.org.` and `example.org` are one host. */
function normalisedHost(url: URL): string {
  return url.hostname.replace(/\.+$/, '');
}

function isNonPublicHost(url: URL): boolean {
  const host = normalisedHost(url).replace(/^\[|\]$/g, '');
  return (
    /(^|\.)(localhost|local|internal|test|invalid)$/.test(host) ||
    (!isIP(host) && !host.includes('.')) ||
    (isIP(host) > 0 && !isPublicAddress(host))
  );
}

/** Pure and never throws. `base` resolves a redirect `Location` inside this same check. */
export function registrationPageUrl(raw: string, base?: string): RegistrationUrlCheck {
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return { outcome: 'refused', reason: 'malformed_url' };
  }
  const href = url.toString();
  const refuse = (reason: RegistrationUrlRefusal): RegistrationUrlCheck => ({
    outcome: 'refused',
    reason,
  });
  if (carriesCredential(url)) return refuse('credential_link');
  if (url.protocol !== 'https:') return refuse('not_https');
  if (url.port) return refuse('nonstandard_port');
  if (isNonPublicHost(url)) return refuse('non_public_host');
  if (href.length > REGISTRATION_COURSE_URL_MAX_CHARS) return refuse('url_too_long');
  // Last on purpose: only a link that would otherwise be fetched lands here.
  if ([...url.searchParams.keys()].some(isAmbiguousKey)) {
    return refuse('ambiguous_query_key');
  }
  return { outcome: 'allowed', url: href };
}

const inFlightByHost = new Map<string, number>();

function hostOf(raw: string): string | null {
  try {
    return normalisedHost(new URL(raw));
  } catch {
    return null;
  }
}

/** Outcome names and the host only: never the path, query, fragment or redirect target. */
function logged(result: RegistrationPageFetch, host: string | null): RegistrationPageFetch {
  if (result.outcome === 'fetched') return result;
  const fields: Record<string, unknown> = { outcome: result.outcome, host };
  if ('reason' in result) fields.reason = result.reason;
  if ('status' in result) fields.status = result.status;
  if ('target' in result) fields.target = result.target;
  console.info(fields, 'registration page: not fetched');
  return result;
}

/** Validate inside socket lookup, not before an unpinned fetch (DNS rebinding).
 * No credentials, redirects, cookies or unbounded response buffering. Never rejects:
 * every outcome is a named value. */
export function createRegistrationPageBytesFetch(
  timeoutMs = PAGE_FETCH_TIMEOUT_MS,
): (url: string) => Promise<RegistrationPageFetch> {
  return async (raw) => {
    const check = registrationPageUrl(raw);
    if (check.outcome === 'refused') {
      return logged({ outcome: 'refused', reason: check.reason }, hostOf(raw));
    }
    const url = check.url;
    const host = normalisedHost(new URL(url));
    const inFlight = inFlightByHost.get(host) ?? 0;
    if (inFlight >= MAX_FETCHES_IN_FLIGHT_PER_HOST) {
      return logged({ outcome: 'busy', reason: 'host_busy' }, host);
    }
    inFlightByHost.set(host, inFlight + 1);
    return new Promise<RegistrationPageFetch>((resolve) => {
      let settled = false;
      const settle = (result: RegistrationPageFetch) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const remaining = inFlightByHost.get(host)! - 1;
        if (remaining > 0) inFlightByHost.set(host, remaining);
        else inFlightByHost.delete(host);
        resolve(logged(result, host));
      };
      const options: RequestOptions & { autoSelectFamily: boolean } = {
        method: 'GET',
        agent: false,
        autoSelectFamily: false,
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'User-Agent': REGISTRATION_PAGE_USER_AGENT,
        },
        lookup: (hostname, _options, callback) => {
          lookup(hostname, { all: true }).then(
            (addresses) => {
              if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
                settle({ outcome: 'refused', reason: 'non_public_address' });
                callback(new Error('registration page: non-public DNS answer'), '', 4);
              } else {
                const chosen = addresses.find(({ family }) => family === 4) ?? addresses[0]!;
                callback(null, chosen.address, chosen.family);
              }
            },
            (error: Error) => callback(error, '', 4),
          );
        },
      };
      let req: ReturnType<typeof request> | undefined;
      const timer = setTimeout(() => {
        settle({ outcome: 'failed', reason: 'timeout' });
        req?.destroy();
      }, timeoutMs);
      try {
        req = request(url, options, (response) => {
          const status = response.statusCode ?? 0;
          const location = response.headers.location;
          if (REDIRECT_STATUSES.has(status) && location) {
            response.destroy();
            const target = registrationPageUrl(location, url);
            settle(
              target.outcome === 'allowed'
                ? { outcome: 'redirected', location: target.url }
                : { outcome: 'refused', reason: 'redirect_refused', target: target.reason },
            );
            return;
          }
          if (status !== 200) {
            response.destroy();
            settle({ outcome: 'refused', reason: 'http_status', status });
            return;
          }
          if (Number(response.headers['content-length']) > MAX_PAGE_BYTES) {
            response.destroy();
            settle({ outcome: 'refused', reason: 'too_large' });
            return;
          }
          let size = 0;
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_PAGE_BYTES) {
              settle({ outcome: 'refused', reason: 'too_large' });
              response.destroy();
            } else chunks.push(chunk);
          });
          response.on('end', () => settle({ outcome: 'fetched', body: Buffer.concat(chunks) }));
          response.on('error', () => settle({ outcome: 'failed', reason: 'network_error' }));
        });
      } catch {
        settle({ outcome: 'failed', reason: 'network_error' });
        return;
      }
      req.on('error', () => settle({ outcome: 'failed', reason: 'network_error' }));
      req.end();
    });
  };
}
