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

type AuthToken = { kind: 'semi' | 'eq' | 'word' | 'quoted'; text: string; spaced: boolean };

/**
 * The lexical tokens of one `Authentication-Results` value, or null when a quoted string
 * or comment never closes, or a comment closes that never opened. Comments are dropped
 * (nested, with quoted-pairs) and a quoted string is one opaque token, so a `;` or `=`
 * the sender put inside a quoted local part or a comment never starts a result. Comment
 * text is scanned as comment text: a `"` in it opens nothing.
 */
function authTokens(value: string): AuthToken[] | null {
  const tokens: AuthToken[] = [];
  let spaced = false;
  let i = 0;
  while (i < value.length) {
    const c = value[i] as string;
    if (/\s/.test(c)) {
      spaced = true;
      i += 1;
    } else if (c === '(') {
      let depth = 0;
      for (; i < value.length; i += 1) {
        const d = value[i];
        if (d === '\\') i += 1;
        else if (d === '(') depth += 1;
        else if (d === ')' && --depth === 0) break;
      }
      if (i >= value.length) return null;
      i += 1;
      spaced = true;
    } else if (c === '"') {
      let text = '';
      for (i += 1; i < value.length && value[i] !== '"'; i += 1) {
        if (value[i] === '\\') i += 1;
        text += value[i] ?? '';
      }
      if (i >= value.length) return null;
      i += 1;
      tokens.push({ kind: 'quoted', text, spaced });
      spaced = false;
    } else if (c === ';' || c === '=') {
      tokens.push({ kind: c === ';' ? 'semi' : 'eq', text: c, spaced });
      spaced = false;
      i += 1;
    } else if (c === ')') {
      return null;
    } else {
      const word = /^[^\s;="()]+/.exec(value.slice(i))?.[0] as string;
      tokens.push({ kind: 'word', text: word, spaced });
      spaced = false;
      i += word.length;
    }
  }
  return tokens;
}

/**
 * One `Authentication-Results` value (RFC 8601): its authserv-id and its results. A
 * result counts only as a `method=result` pair of bare tokens at the head of a resinfo;
 * a property value is the run of tokens after its `=` with no space between them (a
 * quoted local part and its `@domain`). An unclosed quote or comment yields no results.
 */
export function parseAuthenticationResults(value: string): {
  authservId: string;
  results: AuthResult[];
} {
  const tokens = authTokens(value);
  if (tokens === null) return { authservId: '', results: [] };
  const segments: AuthToken[][] = [[]];
  for (const token of tokens) {
    if (token.kind === 'semi') segments.push([]);
    else segments.at(-1)?.push(token);
  }
  const [head = [], ...resinfos] = segments;
  const results: AuthResult[] = [];
  for (const t of resinfos) {
    const [method, eq, result] = t;
    if (method?.kind !== 'word' || eq?.kind !== 'eq' || result?.kind !== 'word') continue;
    const props = new Map<string, string>();
    for (let k = 3; k < t.length; k += 1) {
      const name = t[k] as AuthToken;
      if (name.kind !== 'word' || t[k + 1]?.kind !== 'eq') continue;
      let v = k + 2;
      let pvalue = '';
      for (; v < t.length; v += 1) {
        const part = t[v] as AuthToken;
        if (part.kind === 'eq' || (v > k + 2 && part.spaced)) break;
        pvalue += part.text;
      }
      if (/^[a-z]+\.[a-z0-9-]+$/i.test(name.text) && v > k + 2) {
        props.set(name.text.toLowerCase(), pvalue);
      }
      k = v - 1;
    }
    results.push({
      method: method.text.toLowerCase(),
      result: result.text.toLowerCase(),
      props,
    });
  }
  const id = head[0];
  return { authservId: id?.kind === 'word' ? id.text.toLowerCase() : '', results };
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
