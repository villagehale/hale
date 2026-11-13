import { type Database, schema } from '@hale/db';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { ownRegistrableDomain } from '~/lib/official-host';
import { type OwnCity, cityKey } from './place';

/**
 * VIL-684 · the municipality's own official website, so "read off that city's official
 * page" is a code check and not the search model's word.
 *
 * The site comes from a structured public source: Wikidata's "official website" property
 * (P856) on the entity whose English name is the city's table name (found by the action
 * API's name search), whose country is the family's country and which sits (P131, up the
 * chain) under that province or state (checked by one SPARQL query over those entities). A
 * page is read for the city only when its host is that site's host or a subdomain of it.
 * No hand-kept list of cities or domains: a city the source does not know, or where two
 * places share the name with different sites, has no official site, and the parent hears
 * Hale does not know yet.
 *
 * ONE VALUE IS NOT ENOUGH (lib/official-host.ts). A site on shared hosting or a public
 * suffix is never a city's. An unreferenced value is trusted only once the live search
 * for the city agrees (lookup.ts), and a host that changes is logged and checked again
 * within a day instead of being trusted for a month.
 *
 * What crosses to the source is a public place name (rule #1), never anything about a
 * family.
 */

export type OfficialSite =
  | {
      status: 'found';
      host: string;
      website: string;
      source: string;
      /** The source's statement of this website carries a reference: one of the two
       * signals that may corroborate it (lib/official-host.ts). */
      referenced: boolean;
    }
  /** `shared_host`: the source names a site on shared hosting or a public suffix. */
  | { status: 'not_found'; reason: 'no_entry' | 'ambiguous' | 'shared_host' }
  /** The source did not answer. Says nothing about the city: ask again next sweep. */
  | { status: 'retry'; reason: string };

/** The structured source, as a port: Wikidata's name search (action API
 * `wbsearchentities`) and its SPARQL endpoint, each returning the parsed JSON answer.
 * Each throws when the source did not answer. */
export interface OfficialSiteSource {
  search(name: string): Promise<unknown>;
  sparql(query: string): Promise<unknown>;
}

export const WIKIDATA_API_URL = 'https://www.wikidata.org/w/api.php';
export const WIKIDATA_SPARQL_URL = 'https://query.wikidata.org/sparql';
/** An infra bound on one source request; a slow answer is a retry next sweep. */
export const OFFICIAL_SITE_TIMEOUT_MS = 10_000;
/** Search hits read per city: an infra bound, not a rule about cities. */
export const MAX_NAME_HITS = 20;
/** Cache freshness, not a send rule: a municipality's website rarely moves. */
export const RECHECK_FOUND_MS = 30 * 86_400_000;
/** How long "no official site" stands before the source is asked again. */
export const RECHECK_NOT_FOUND_MS = 7 * 86_400_000;
/** How long a host that just changed stands before the source is asked again. */
export const RECHECK_CHANGED_MS = 86_400_000;

/** A name as compared: composed, lower-case, every dash a hyphen, single spaces. */
function foldName(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‐-―−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

const searchSchema = z.object({
  search: z.array(
    z.object({
      id: z.string(),
      label: z.string().optional(),
      match: z.object({ type: z.string(), text: z.string() }).optional(),
    }),
  ),
});

const sparqlSchema = z.object({
  results: z.object({
    bindings: z.array(
      z.object({
        item: z.object({ value: z.string() }),
        site: z.object({ value: z.string() }),
        referenced: z.object({ value: z.string() }).optional(),
      }),
    ),
  }),
});

/** A SPARQL string literal: backslashes, quotes and line breaks escaped. */
function literal(text: string): string {
  const escaped = text
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r');
  return `"${escaped}"@en`;
}

/**
 * The query that keeps, of the named entities, those with an official website, in the
 * country and under the province or state. Entity ids come from the search and are
 * checked to be ids; the place names are quoted literals.
 */
export function placeCheckQuery(
  qids: readonly string[],
  place: Pick<OwnCity, 'provinceOrState' | 'country'>,
): string {
  const items = qids.filter((qid) => /^Q\d+$/.test(qid)).map((qid) => `wd:${qid}`);
  const region =
    place.provinceOrState === null
      ? ''
      : `?item wdt:P131+ ?region . ?region rdfs:label ${literal(place.provinceOrState)} .`;
  return [
    'SELECT DISTINCT ?item ?site ?referenced WHERE {',
    `  VALUES ?item { ${items.join(' ')} }`,
    `  ?item wdt:P856 ?site ; wdt:P17 ?country . ?country rdfs:label ${literal(place.country)} .`,
    `  ${region}`,
    '  BIND(EXISTS { ?item p:P856 ?st . ?st ps:P856 ?site ; prov:wasDerivedFrom ?ref . } AS ?referenced)',
    '}',
  ].join('\n');
}

/** One place the source holds under this name, with how the name matched it. */
export interface NamedPlace {
  qid: string;
  website: string;
  how: 'label' | 'alias';
  referenced: boolean;
}

/** A website's host as compared: lower-case, no trailing dot, no leading `www.`. */
function siteHost(url: URL): string {
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  return host.startsWith('www.') ? host.slice('www.'.length) : host;
}

function httpUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

/**
 * The official site the places under this name establish. A place whose own name is the
 * city wins over one that only carries it as an alias (Brooklyn the borough over
 * Brooklyn College), and where that still leaves more than one host, nothing is
 * established (Hamilton the city and Hamilton the township).
 */
export function officialSiteOf(places: readonly NamedPlace[]): OfficialSite {
  const rows = places.flatMap((place) => {
    const url = httpUrl(place.website);
    return url === null ? [] : [{ ...place, url }];
  });
  const named = rows.filter((row) => row.how === 'label');
  const chosen = named.length > 0 ? named : rows;
  if (chosen.length === 0) return { status: 'not_found', reason: 'no_entry' };
  const hosts = new Set(chosen.map((row) => siteHost(row.url)));
  if (hosts.size > 1) return { status: 'not_found', reason: 'ambiguous' };
  const best = [...chosen].sort(
    (a, b) =>
      Number(b.url.protocol === 'https:') - Number(a.url.protocol === 'https:') ||
      a.qid.localeCompare(b.qid),
  )[0];
  if (best === undefined) return { status: 'not_found', reason: 'no_entry' };
  const host = siteHost(best.url);
  if (ownRegistrableDomain(host) === null) return { status: 'not_found', reason: 'shared_host' };
  return {
    status: 'found',
    host,
    website: best.url.href,
    source: `wikidata:${best.qid}`,
    referenced: chosen.some((row) => row.referenced),
  };
}

/**
 * Whether a page is on the city's official site: https, and its host is the site's host
 * or under it. A site that lives under a path (a town page on a shared host) holds pages
 * to that exact host and path.
 */
export function onOfficialSite(
  pageUrl: string,
  site: Extract<OfficialSite, { status: 'found' }>,
): boolean {
  let page: URL;
  try {
    page = new URL(pageUrl);
  } catch {
    return false;
  }
  if (page.protocol !== 'https:') return false;
  const host = siteHost(page);
  const website = new URL(site.website);
  const sitePath = website.pathname.replace(/\/+$/, '');
  if (sitePath !== '') {
    return host === site.host && `${page.pathname}/`.startsWith(`${sitePath}/`);
  }
  return host === site.host || host.endsWith(`.${site.host}`);
}

/**
 * The places the source holds under the city's name, in the family's country and under
 * its province or state, each with its official website. Read by code, no model.
 */
async function namedPlaces(
  source: OfficialSiteSource,
  place: Pick<OwnCity, 'city' | 'provinceOrState' | 'country'>,
): Promise<NamedPlace[]> {
  const hits = searchSchema.parse(await source.search(place.city)).search;
  const city = foldName(place.city);
  const matched = new Map<string, NamedPlace['how']>();
  for (const hit of hits) {
    if (hit.label !== undefined && foldName(hit.label) === city) matched.set(hit.id, 'label');
    else if (hit.match?.type === 'alias' && foldName(hit.match.text) === city) {
      if (!matched.has(hit.id)) matched.set(hit.id, 'alias');
    }
  }
  if (matched.size === 0) return [];
  const checked = sparqlSchema.parse(
    await source.sparql(placeCheckQuery([...matched.keys()], place)),
  );
  return checked.results.bindings.flatMap((row) => {
    const qid = row.item.value.split('/').pop() ?? '';
    const how = matched.get(qid);
    if (how === undefined) return [];
    return [{ qid, website: row.site.value, how, referenced: row.referenced?.value === 'true' }];
  });
}

function failureName(err: unknown): string {
  return err instanceof Error ? err.constructor.name : 'unknown';
}

export async function lookupOfficialSite(
  source: OfficialSiteSource,
  place: Pick<OwnCity, 'city' | 'provinceOrState' | 'country'>,
): Promise<OfficialSite> {
  let places: NamedPlace[];
  try {
    places = await namedPlaces(source, place);
  } catch (err) {
    if (err instanceof z.ZodError) return { status: 'retry', reason: 'source_unparsed' };
    return { status: 'retry', reason: `source_failed:${failureName(err)}` };
  }
  return officialSiteOf(places);
}

/** The gap the production source keeps between its requests: Wikimedia rate-limits a
 * burst from a client that names itself generically (HTTP 429). An infra bound. */
export const MIN_REQUEST_GAP_MS = 1_000;

/** The production source: Wikidata's public name search and SPARQL endpoint, paced and
 * bounded in time. The client names itself generically; nothing about Hale's families
 * goes with it. A 429 or any other refusal throws, and the lookup is a retry next sweep. */
export function wikidataSource(fetchImpl: typeof fetch = fetch): OfficialSiteSource {
  let last = 0;
  const get = async (url: string, accept: string): Promise<unknown> => {
    const wait = last + MIN_REQUEST_GAP_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    last = Date.now();
    const res = await fetchImpl(url, {
      headers: { Accept: accept, 'User-Agent': 'municipal-registration-lookup/1.0' },
      signal: AbortSignal.timeout(OFFICIAL_SITE_TIMEOUT_MS),
    });
    if (!res.ok) throw new OfficialSiteHttpError(res.status);
    return res.json();
  };
  return {
    search: (name) =>
      get(
        `${WIKIDATA_API_URL}?${new URLSearchParams({
          action: 'wbsearchentities',
          search: name,
          language: 'en',
          uselang: 'en',
          type: 'item',
          limit: String(MAX_NAME_HITS),
          format: 'json',
        })}`,
        'application/json',
      ),
    sparql: (query) =>
      get(
        `${WIKIDATA_SPARQL_URL}?${new URLSearchParams({ query })}`,
        'application/sparql-results+json',
      ),
  };
}

export class OfficialSiteHttpError extends Error {
  constructor(readonly status: number) {
    super(`official site source answered HTTP ${status}`);
    this.name = 'OfficialSiteHttpError';
  }
}

/** The municipality's key: the city key with no district, one site per municipality. */
export function municipalityKey(place: Pick<OwnCity, 'city' | 'provinceOrState' | 'country'>) {
  return cityKey({ ...place, district: null });
}

function storedSite(row: typeof schema.cityOfficialSites.$inferSelect): OfficialSite {
  if (row.status === 'found') {
    if (row.host === null || row.website === null || row.source === null) {
      throw new Error('city official site: a found row has no host, website or source');
    }
    return {
      status: 'found',
      host: row.host,
      website: row.website,
      source: row.source,
      referenced: row.referenced === true,
    };
  }
  const reason =
    row.reason === 'ambiguous' || row.reason === 'shared_host' ? row.reason : 'no_entry';
  return { status: 'not_found', reason };
}

/**
 * The city's official site, from the cache while it is fresh, else asked of the source
 * and appended. A source that does not answer leaves the last answer standing (a site
 * does not stop being official because the source was slow); with no last answer it is
 * a retry. A host other than the last one found is logged, and asked about again after
 * RECHECK_CHANGED_MS rather than the usual month.
 */
export async function cachedOfficialSite(
  database: Database,
  source: OfficialSiteSource,
  place: Pick<OwnCity, 'city' | 'provinceOrState' | 'country'>,
  now: Date,
): Promise<OfficialSite> {
  const t = schema.cityOfficialSites;
  const key = municipalityKey(place);
  const [row] = await database
    .select()
    .from(t)
    .where(eq(t.municipalityKey, key))
    .orderBy(desc(t.checkedAt))
    .limit(1);
  if (row && row.recheckAt.getTime() > now.getTime()) return storedSite(row);
  const found = await lookupOfficialSite(source, place);
  if (found.status === 'retry') {
    console.info({ reason: found.reason }, 'own-city registration: official site not answered');
    return row ? storedSite(row) : found;
  }
  const changed = found.status === 'found' && row?.status === 'found' && row.host !== found.host;
  if (changed) {
    console.warn(
      { municipality: key, from: row.host, to: found.host },
      'own-city registration: official host changed',
    );
  }
  await database.insert(t).values({
    municipalityKey: key,
    city: place.city,
    provinceOrState: place.provinceOrState,
    country: place.country,
    status: found.status,
    reason: found.status === 'not_found' ? found.reason : null,
    host: found.status === 'found' ? found.host : null,
    website: found.status === 'found' ? found.website : null,
    source: found.status === 'found' ? found.source : null,
    referenced: found.status === 'found' ? found.referenced : null,
    checkedAt: now,
    recheckAt: new Date(
      now.getTime() +
        (changed
          ? RECHECK_CHANGED_MS
          : found.status === 'found'
            ? RECHECK_FOUND_MS
            : RECHECK_NOT_FOUND_MS),
    ),
  });
  return found;
}
