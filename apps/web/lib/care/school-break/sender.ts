import SUFFIXES from '~/lib/channel/off-domain/public-suffix/suffixes.json';

/**
 * VIL-685 · WHICH SCHOOL A KID'S EMAIL CAME FROM, read by code off the message's own
 * headers: the only way a school is named here besides the parent's own answer.
 *
 * A From header is whatever the sender typed, so it names nothing on its own. The domain
 * counts only when the receiving server, Gmail, says the message authenticated as that
 * domain: its own `Authentication-Results` (authserv-id `mx.google.com`) carries
 * `dmarc=pass` for exactly the From domain, or `dkim=pass` for a signing domain in the
 * same registrable domain as the From domain (relaxed alignment). Gmail stamps its result
 * above every header the message arrived with, so the first `Authentication-Results`
 * is Gmail's and any lower one, which the sender could have written, is never read.
 *
 * The school is then the From domain's REGISTRABLE domain under the Public Suffix List,
 * private section included: `office@mail.board.example` is `board.example`, while a
 * school on shared hosting (`a-school.github.io`) stays its own and never becomes the
 * host's. A domain that is itself a public suffix or a shared-hosting suffix names no
 * school. The list's exception rules are not in the vendored build (README there), so a
 * domain one of them would free reads as a suffix: it names nothing rather than too much.
 */

export const GMAIL_AUTHSERV_ID = 'mx.google.com';

const EXACT = new Set<string>(SUFFIXES.exact);
const WILD = new Set<string>(SUFFIXES.wild);

const HOST =
  /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

function plainHost(raw: string): string | null {
  const host = raw.trim().toLowerCase().replace(/\.$/, '');
  return HOST.test(host) ? host : null;
}

/**
 * The registrable domain of a host (the public suffix plus one label), or null when the
 * host is itself a public suffix. A host no rule covers falls under the list's default
 * rule: its last label is the suffix.
 */
export function registrableDomain(raw: string): string | null {
  const host = plainHost(raw);
  if (host === null) return null;
  const labels = host.split('.');
  let suffixAt = labels.length - 1;
  for (let i = 0; i < labels.length; i += 1) {
    const candidate = labels.slice(i).join('.');
    const parent = labels.slice(i + 1).join('.');
    if (EXACT.has(candidate) || (parent !== '' && WILD.has(parent))) {
      suffixAt = i;
      break;
    }
  }
  return suffixAt === 0 ? null : labels.slice(suffixAt - 1).join('.');
}

/** The domain of the one mailbox a From header names, or null for anything else. */
export function fromDomainOf(from: string): string | null {
  const bracketed = [...from.matchAll(/<([^<>]*)>/g)];
  const address = (bracketed.at(-1)?.[1] ?? from).trim();
  const parts = address.split('@');
  if (parts.length !== 2 || parts[0] === '' || /[\s,;]/.test(address)) return null;
  return plainHost(parts[1] as string);
}

interface AuthResult {
  method: string;
  result: string;
  props: Map<string, string>;
}

/** One `Authentication-Results` value (RFC 8601): its authserv-id and its results. */
export function parseAuthenticationResults(value: string): {
  authservId: string;
  results: AuthResult[];
} {
  let text = value;
  // Comments go first: they may hold `;` or `=`, and they say nothing the result does.
  for (let before = ''; before !== text; ) {
    before = text;
    text = text.replace(/\([^()]*\)/g, ' ');
  }
  const [head = '', ...segments] = text.split(';');
  const results: AuthResult[] = [];
  for (const segment of segments) {
    const match = /^\s*([a-z0-9-]+)\s*=\s*([a-z0-9-]+)(.*)$/is.exec(segment);
    if (!match) continue;
    const props = new Map<string, string>();
    for (const prop of (match[3] as string).matchAll(
      /([a-z]+\.[a-z0-9-]+)\s*=\s*("[^"]*"|[^\s"]+)/gi,
    )) {
      props.set((prop[1] as string).toLowerCase(), (prop[2] as string).replace(/^"|"$/g, ''));
    }
    results.push({
      method: (match[1] as string).toLowerCase(),
      result: (match[2] as string).toLowerCase(),
      props,
    });
  }
  return { authservId: head.trim().split(/\s+/)[0]?.toLowerCase() ?? '', results };
}

export type SenderReading =
  | { status: 'aligned'; host: string }
  | {
      status: 'unaligned';
      reason: 'no_from' | 'not_gmail_stamped' | 'not_aligned' | 'not_registrable';
    };

/** A message's headers, in the order the message carries them. */
export type MessageHeaders = ReadonlyArray<{ name: string; value: string }>;

function signingDomain(result: AuthResult): string | null {
  const d = result.props.get('header.d');
  if (d !== undefined) return plainHost(d);
  const i = result.props.get('header.i');
  return i === undefined ? null : plainHost(i.slice(i.lastIndexOf('@') + 1));
}

/** The school a message names: its From domain's registrable domain, when Gmail says
 * the message authenticated as that domain. */
export function alignedSenderHost(headers: MessageHeaders): SenderReading {
  const froms = headers.filter((h) => h.name.toLowerCase() === 'from');
  const fromDomain = froms.length === 1 ? fromDomainOf(froms[0]?.value ?? '') : null;
  if (fromDomain === null) return { status: 'unaligned', reason: 'no_from' };
  const stamp = headers.find((h) => h.name.toLowerCase() === 'authentication-results');
  const parsed = stamp ? parseAuthenticationResults(stamp.value) : null;
  if (parsed === null || parsed.authservId !== GMAIL_AUTHSERV_ID) {
    return { status: 'unaligned', reason: 'not_gmail_stamped' };
  }
  const site = registrableDomain(fromDomain);
  if (site === null) return { status: 'unaligned', reason: 'not_registrable' };
  const aligned = parsed.results.some((r) => {
    if (r.result !== 'pass') return false;
    if (r.method === 'dmarc') return plainHost(r.props.get('header.from') ?? '') === fromDomain;
    if (r.method === 'dkim') {
      const signer = signingDomain(r);
      return signer !== null && registrableDomain(signer) === site;
    }
    return false;
  });
  return aligned
    ? { status: 'aligned', host: site }
    : { status: 'unaligned', reason: 'not_aligned' };
}
