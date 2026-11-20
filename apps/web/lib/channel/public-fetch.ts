import { lookup } from 'node:dns/promises';
import { type RequestOptions, request } from 'node:https';
import { isIP } from 'node:net';
import { isPublicAddress } from '~/lib/registration/page';

/**
 * Devin SEC_0001 (#985). A URL from a webhook is checked where the socket gets its
 * address, not before an unpinned fetch: a public-looking name (`10.0.0.5.nip.io`) or a
 * DNS answer that changes between check and connect is refused, because the address
 * vetted is the address connected to. Never follows a redirect; the caller re-checks
 * each hop.
 */
export type ResolveHost = (
  hostname: string,
) => Promise<ReadonlyArray<{ address: string; family: number }>>;

type LookupCallback = (err: Error | null, address: string, family: number) => void;

function namedError(name: string): Error {
  const err = new Error(name);
  err.name = name;
  return err;
}

const resolveAll: ResolveHost = (hostname) => lookup(hostname, { all: true });

export function publicLookup(
  resolve: ResolveHost,
): (hostname: string, options: unknown, callback: LookupCallback) => void {
  return (hostname, _options, callback) => {
    resolve(hostname).then(
      (answers) => {
        if (!answers.length || answers.some(({ address }) => !isPublicAddress(address))) {
          callback(namedError('NonPublicAddressError'), '', 4);
          return;
        }
        const chosen = answers.find(({ family }) => family === 4) ?? answers[0]!;
        callback(null, chosen.address, chosen.family);
      },
      (err: Error) => callback(err, '', 4),
    );
  };
}

const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/** A fetch-shaped GET over a vetted socket. Bodies past `maxBytes` are cut and rejected. */
export function createPublicFetch(opts: { resolve?: ResolveHost; maxBytes: number }) {
  const resolve = opts.resolve ?? resolveAll;
  return (raw: string, init: { signal: AbortSignal }): Promise<Response> =>
    new Promise<Response>((resolveResponse, reject) => {
      const url = new URL(raw);
      if (url.protocol !== 'https:') {
        reject(namedError('NotHttpsError'));
        return;
      }
      const host = url.hostname.replace(/^\[|\]$/g, '');
      if (isIP(host) && !isPublicAddress(host)) {
        reject(namedError('NonPublicAddressError'));
        return;
      }
      const options: RequestOptions & { autoSelectFamily: boolean } = {
        method: 'GET',
        agent: false,
        autoSelectFamily: false,
        signal: init.signal,
        lookup: publicLookup(resolve) as RequestOptions['lookup'],
      };
      const req = request(url, options, (res) => {
        const status = res.statusCode ?? 0;
        const headers = new Headers();
        for (const name of ['content-type', 'content-length', 'location']) {
          const value = res.headers[name];
          if (typeof value === 'string') headers.set(name, value);
        }
        if (NULL_BODY_STATUSES.has(status) || (status >= 300 && status < 400)) {
          res.destroy();
          resolveResponse(new Response(null, { status, headers }));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > opts.maxBytes) {
            res.destroy();
            reject(namedError('TooLargeError'));
          } else chunks.push(chunk);
        });
        res.on('end', () =>
          resolveResponse(new Response(Buffer.concat(chunks), { status, headers })),
        );
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });
}
