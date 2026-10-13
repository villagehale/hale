import { lookup } from 'node:dns/promises';
import { type RequestOptions, request } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { REGISTRATION_COURSE_URL_MAX_CHARS } from '@hale/db';
import { type FetchPage, MAX_PAGE_BYTES, PAGE_FETCH_TIMEOUT_MS } from './fetch';

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

export function registrationPageUrl(raw: string): string {
  const url = new URL(raw);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.toString().length > REGISTRATION_COURSE_URL_MAX_CHARS ||
    /(^|\.)(localhost|local|internal|test|invalid)$/.test(host) ||
    [...url.searchParams.keys()].some((key) =>
      /^(?:password|access_token|auth|authorization|token|jwt|session|session_id|api_?key|secret|signature|sig|x-amz-credential|x-amz-signature)$/i.test(
        key,
      ),
    ) ||
    /(?:access_token|id_token|password)=/i.test(url.hash) ||
    (!isIP(host) && !host.includes('.')) ||
    (isIP(host) && !isPublicAddress(host))
  ) {
    throw new Error('registration page: unsafe URL');
  }
  return url.toString();
}

/** Validate inside socket lookup, not before an unpinned fetch (DNS rebinding).
 * No credentials, redirects, cookies or unbounded response buffering. */
export function createRegistrationPageFetch(timeoutMs = PAGE_FETCH_TIMEOUT_MS): FetchPage {
  return (raw) =>
    new Promise((resolve, reject) => {
      const url = registrationPageUrl(raw);
      const options: RequestOptions & { autoSelectFamily: boolean } = {
        method: 'GET',
        agent: false,
        autoSelectFamily: false,
        headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'node' },
        lookup: (hostname, _options, callback) => {
          lookup(hostname, { all: true }).then(
            (addresses) => {
              if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
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
      const req = request(url, options, (response) => {
        if (
          response.statusCode !== 200 ||
          Number(response.headers['content-length']) > MAX_PAGE_BYTES
        ) {
          response.destroy();
          reject(new Error('registration page: status or size refusal'));
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_PAGE_BYTES) response.destroy(new Error('registration page: size refusal'));
          else chunks.push(chunk);
        });
        response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        response.on('error', reject);
      });
      const timer = setTimeout(
        () => req.destroy(new Error('registration page: timeout')),
        timeoutMs,
      );
      req.on('close', () => clearTimeout(timer));
      req.on('error', reject);
      req.end();
    });
}
