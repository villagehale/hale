import { z } from 'zod';

/**
 * VIL-685 · THE BOARD'S OWN SITE, PROVEN BY A STRUCTURED PUBLIC SOURCE.
 *
 * A school email names a domain, and a domain alone proves nothing: a coach writes from
 * gmail.com, a newsletter goes out through a vendor, a club has its own site. So a sender
 * domain becomes an official host only when Wikidata says it is the official website
 * (P856) of an educational institution (P31/P279* Q2385804): a school board, a school
 * district, a school. The host Hale then reads calendars on is that website's host, so a
 * shared host (google.com, a mail vendor) is never an institution and never a host. No
 * hand-kept list of boards or domains, and the same kind of proof the own-city lookup
 * uses (VIL-684).
 *
 * What crosses to the source is a domain an email came from: never an address, a name, a
 * family or a message.
 */

/** Wikidata's "educational institution": schools, school boards and districts sit under it. */
export const EDUCATIONAL_INSTITUTION_QID = 'Q2385804';
export const WIKIDATA_SPARQL_URL = 'https://query.wikidata.org/sparql';
/** An infra bound on one source request; a slow answer leaves the domain unproven. */
export const BOARD_SITE_TIMEOUT_MS = 10_000;
/** Wikimedia rate-limits a burst from a generically named client (HTTP 429). */
export const MIN_REQUEST_GAP_MS = 1_000;
/** The suffixes of one sender domain asked about: `mail.edu.board.ca` down to `board.ca`. */
const MAX_SUFFIXES = 4;

const HOST =
  /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export type BoardSite =
  | { status: 'found'; host: string; source: string }
  | { status: 'not_found' }
  /** The source did not answer. Says nothing about the domain. */
  | { status: 'retry'; reason: string };

/** The structured source, as a port: one SPARQL query, its parsed JSON answer. Throws
 * when the source did not answer. */
export interface BoardSiteSource {
  sparql(query: string): Promise<unknown>;
}

/** The domain of an email address, lower-case, or null when it is not a plain host. */
export function senderDomainOf(address: string): string | null {
  const at = address.lastIndexOf('@');
  if (at === -1) return null;
  const domain = address
    .slice(at + 1)
    .replace(/>.*$/s, '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
  return HOST.test(domain) ? domain : null;
}

/** The domain and its parents, down to two labels. A bare suffix is never asked about. */
export function domainSuffixes(domain: string): string[] {
  const labels = domain.split('.');
  const out: string[] = [];
  for (let i = 0; i + 2 <= labels.length && out.length < MAX_SUFFIXES; i += 1) {
    out.push(labels.slice(i).join('.'));
  }
  return out;
}

/** A site's host as compared: lower-case, no trailing dot, no leading `www.`. */
function siteHost(url: URL): string {
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  return host.startsWith('www.') ? host.slice('www.'.length) : host;
}

/**
 * The query: entities whose official website is exactly the root of one of these hosts,
 * and which are educational institutions. Hosts are checked to be plain hosts first, so
 * nothing from an email reaches the query text unchecked.
 */
export function boardSiteQuery(hosts: readonly string[]): string {
  const sites = hosts
    .filter((host) => HOST.test(host))
    .flatMap((host) =>
      ['https://', 'http://'].flatMap((scheme) =>
        ['', 'www.'].flatMap((www) => [`<${scheme}${www}${host}/>`, `<${scheme}${www}${host}>`]),
      ),
    );
  return [
    'SELECT DISTINCT ?item ?site WHERE {',
    `  VALUES ?site { ${sites.join(' ')} }`,
    '  ?item wdt:P856 ?site .',
    `  FILTER EXISTS { ?item wdt:P31/wdt:P279* wd:${EDUCATIONAL_INSTITUTION_QID} }`,
    '}',
  ].join('\n');
}

const sparqlSchema = z.object({
  results: z.object({
    bindings: z.array(
      z.object({ item: z.object({ value: z.string() }), site: z.object({ value: z.string() }) }),
    ),
  }),
});

/**
 * The official host a sender domain proves, read by code from the source's answer. The
 * widest proven suffix wins: a board's site holds its schools' subdomains, so reading on
 * it misses nothing a school's own subdomain would have. A tie between two institutions on
 * one host is settled by entity id so the answer is stable.
 */
export function boardSiteOf(domain: string, answer: unknown): BoardSite {
  const suffixes = domainSuffixes(domain);
  const rows = sparqlSchema.parse(answer).results.bindings.flatMap((row) => {
    let url: URL;
    try {
      url = new URL(row.site.value);
    } catch {
      return [];
    }
    const host = siteHost(url);
    const rank = suffixes.indexOf(host);
    const qid = row.item.value.split('/').pop() ?? '';
    return rank === -1 || !/^Q\d+$/.test(qid) ? [] : [{ host, rank, qid }];
  });
  const best = rows.sort((a, b) => b.rank - a.rank || a.qid.localeCompare(b.qid))[0];
  return best
    ? { status: 'found', host: best.host, source: `wikidata:${best.qid}` }
    : { status: 'not_found' };
}

function failureName(err: unknown): string {
  return err instanceof Error ? err.constructor.name : 'unknown';
}

export async function proveBoardSite(source: BoardSiteSource, domain: string): Promise<BoardSite> {
  const suffixes = domainSuffixes(domain);
  if (suffixes.length === 0) return { status: 'not_found' };
  try {
    return boardSiteOf(domain, await source.sparql(boardSiteQuery(suffixes)));
  } catch (err) {
    if (err instanceof z.ZodError) return { status: 'retry', reason: 'source_unparsed' };
    return { status: 'retry', reason: `source_failed:${failureName(err)}` };
  }
}

export class BoardSiteHttpError extends Error {
  constructor(readonly status: number) {
    super(`board site source answered HTTP ${status}`);
    this.name = 'BoardSiteHttpError';
  }
}

/** The production source: Wikidata's public SPARQL endpoint, paced and bounded in time.
 * The client names itself generically; nothing about a family goes with it. */
export function wikidataBoardSiteSource(fetchImpl: typeof fetch = fetch): BoardSiteSource {
  let last = 0;
  return {
    async sparql(query) {
      const wait = last + MIN_REQUEST_GAP_MS - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      last = Date.now();
      const res = await fetchImpl(`${WIKIDATA_SPARQL_URL}?${new URLSearchParams({ query })}`, {
        headers: {
          Accept: 'application/sparql-results+json',
          'User-Agent': 'school-calendar-lookup/1.0',
        },
        signal: AbortSignal.timeout(BOARD_SITE_TIMEOUT_MS),
      });
      if (!res.ok) throw new BoardSiteHttpError(res.status);
      return res.json();
    },
  };
}
