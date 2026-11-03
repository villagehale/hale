import { z } from 'zod';
import { type FetchPage, stripHtml } from '~/lib/registration/fetch';
import {
  RegistrationPageRedirect,
  createRegistrationPageFetch,
  registrationPageUrl,
} from '~/lib/registration/page';
import type { ActivityOccurrence } from './facts';
import { activityLocationMatches } from './location';

export const MAX_ACTIVITY_SOURCE_PAGES = 3;

function structuredEvents(html: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') {
      const node = value as Record<string, unknown>;
      if (node['@type'] === 'Event') events.push(node);
      if (Array.isArray(node['@graph'])) node['@graph'].forEach(visit);
    }
  };
  for (const script of html.matchAll(
    /<script\b[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      visit(JSON.parse(script[1] ?? ''));
    } catch {
      // Malformed metadata cannot establish an event.
    }
  }
  return events;
}

function occurrenceSource(html: string, url: string) {
  // shortcut: explicit JSON-LD Event URLs; add other markup with source-backed fixtures.
  const primary = structuredEvents(html).filter((event) => {
    try {
      return typeof event.url === 'string' && new URL(event.url, url).href === url;
    } catch {
      return false;
    }
  });
  if (!primary.length) return {};
  const schema = z.object({
    name: z.string().min(1),
    startDate: z.string().min(1),
    endDate: z.string().nullish(),
  });
  const occurrences = primary.map((event) => schema.safeParse(event));
  if (occurrences.some((result) => !result.success)) return { occurrence: null };
  const unique = new Map(
    occurrences.flatMap((result) =>
      result.success ? [[JSON.stringify(result.data), result.data] as const] : [],
    ),
  );
  const occurrence = unique.size === 1 ? [...unique.values()][0]! : null;
  if (!occurrence || !stripHtml(html).includes(occurrence.name)) return { occurrence: null };
  const relatedUrls = new Set<string>();
  for (const anchor of html.matchAll(
    /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
  )) {
    if (stripHtml(anchor[2] ?? '').toLowerCase() !== occurrence.name.toLowerCase()) continue;
    try {
      const target = registrationPageUrl(new URL(anchor[1]!, url).href);
      if (target !== url) relatedUrls.add(target);
    } catch {
      // Discovery links pass the same URL checks as initial search results.
    }
    if (relatedUrls.size === MAX_ACTIVITY_SOURCE_PAGES) break;
  }
  return { occurrence, relatedUrls: [...relatedUrls] };
}

const eventVenueSchema = z.object({
  '@type': z.literal('Event'),
  name: z.string().min(1),
  location: z.object({ name: z.string().min(1), url: z.string().min(1) }),
});

function linkedEventVenue(html: string) {
  const venues = new Map<string, string>();
  const text = stripHtml(html);
  for (const node of structuredEvents(html)) {
    const event = eventVenueSchema.safeParse(node);
    if (
      event.success &&
      text.startsWith(event.data.name) &&
      text.includes(event.data.location.name)
    ) {
      venues.set(event.data.location.url, event.data.location.name);
    }
  }
  // shortcut: ambiguous or non-Event metadata stays unverified; extend with source evidence.
  return venues.size === 1 ? [...venues][0] : undefined;
}

function isChallenge(html: string): boolean {
  const title = stripHtml(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '');
  if (
    /^(?:just a moment|human verification|verify (?:that )?you are (?:a )?human|security (?:check|verification)|vérification de sécurité|access denied|robot check|bot verification|pardon our interruption|(?:[\p{L}\d]+\s+)?bot manager captcha|captcha)[.!…]*(?:\s*[|–—:-]\s*.*)?$/iu.test(
      title,
    )
  )
    return true;
  const text = stripHtml(html);
  // A CAPTCHA mentioned in ordinary registration instructions is not an interstitial.
  return (
    /^(?:verify (?:that )?you are (?:a )?human|checking your browser|vérifiez que vous êtes humain)\b/iu.test(
      text,
    ) && /javascript|cookies|captcha|security check|vérification de sécurité/iu.test(text)
  );
}

/** Every redirect uses the same URL validation and DNS-pinned, credential-free fetch. */
export function createActivityPageFetch(fetchPage: FetchPage = createRegistrationPageFetch()) {
  const read = async (raw: string): Promise<{ url: string; text: string }> => {
    let url = registrationPageUrl(raw);
    for (let hop = 0; ; hop++) {
      try {
        const text = await fetchPage(url);
        if (isChallenge(text)) throw new Error('activity page: challenge');
        return { url, text };
      } catch (error) {
        if (!(error instanceof RegistrationPageRedirect) || hop === 3) throw error;
        url = registrationPageUrl(error.location);
      }
    }
  };
  return async (
    raw: string,
    town?: string | null,
  ): Promise<{
    url: string;
    text: string;
    locationVerified?: boolean;
    locationSource?: string;
    occurrence?: ActivityOccurrence | null;
    relatedUrls?: string[];
  }> => {
    const readPage = await read(raw);
    const page = { ...readPage, ...occurrenceSource(readPage.text, readPage.url) };
    if (town === undefined) return page;
    if (activityLocationMatches(town, stripHtml(page.text)))
      return { ...page, locationVerified: true };
    const venue = linkedEventVenue(page.text);
    if (town && venue) {
      try {
        const location = await read(new URL(venue[0], page.url).toString());
        const text = stripHtml(location.text);
        if (text.includes(venue[1]) && activityLocationMatches(town, text))
          return { ...page, locationVerified: true, locationSource: location.url };
      } catch {
        // A failed venue read leaves the event's location unverified.
      }
    }
    return { ...page, locationVerified: false };
  };
}

/** Read discovered occurrence links only in unused slots of the existing page budget. */
export async function readActivityPages(
  urls: readonly string[],
  fetchPage: ReturnType<typeof createActivityPageFetch>,
  town?: string | null,
) {
  const attempted = new Set<string>();
  const read = async (raw: string) => {
    attempted.add(raw);
    try {
      const page = await fetchPage(raw, town);
      const text = stripHtml(page.text).slice(0, 20_000);
      return text.trim() ? { ...page, text } : null;
    } catch {
      return null;
    }
  };
  const pages = (
    await Promise.all([...new Set(urls)].slice(0, MAX_ACTIVITY_SOURCE_PAGES).map(read))
  ).filter((page) => page !== null);
  const seen = new Set([...attempted, ...pages.map((page) => page.url)]);
  for (const page of pages) {
    for (const url of page.relatedUrls ?? []) {
      if (attempted.size >= MAX_ACTIVITY_SOURCE_PAGES) break;
      if (seen.has(url)) continue;
      seen.add(url);
      const related = await read(url);
      if (related) {
        pages.push(related);
        seen.add(related.url);
      }
    }
  }
  return { pages, pagesRefused: attempted.size - pages.length };
}
