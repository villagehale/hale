import type Anthropic from '@anthropic-ai/sdk';
import { type AgentClient, cachedSystem, pickModel } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import type { CityPlace } from './place';

/**
 * VIL-684 · find the official page a city publishes its registration dates on, by live
 * search. The model only FINDS pages; the date is read off each page afterwards by the
 * VIL-423 reader, quote by quote, so nothing the search turn writes is ever a date.
 *
 * What crosses the border to the US search (rule #1) is a public place name, the
 * season and today's date. Nothing about a family: the lookup is about a city, and one
 * reading serves every family in it.
 *
 * A page counts only when the search returned it: a URL the model wrote that no result
 * carried is dropped by name, never fetched.
 */

export const PAGE_SEARCH_SKILL = 'registration-page-search';
/** An infra bound on one search turn's searches, not a send rule. */
export const MAX_PAGE_SEARCHES = 3;
/** The pages one lookup may read: what the skill may name. */
export const MAX_CANDIDATE_PAGES = 3;
export const PAGE_SEARCH_MAX_TOKENS = 2048;

export type PageSearch =
  | { outcome: 'pages'; municipality: string; urls: string[] }
  /** The search ran and named no official page for this place. */
  | { outcome: 'none'; reason: 'no_results' | 'no_official_page' | 'unparsed' | 'not_this_place' }
  /** The search did not finish: try again later. Says nothing about the city. */
  | { outcome: 'failed'; reason: string };

/** The user message, built field by field: a place and a season, nothing else. */
export function pageSearchUserMessage(place: CityPlace, cycleLabel: string, today: string): string {
  return JSON.stringify({
    city: place.city,
    province_or_state: place.provinceOrState,
    country: place.country,
    season: cycleLabel,
    today,
  });
}

const answerSchema = z.object({
  municipality: z.string().min(1).nullable(),
  pages: z.array(z.string()).max(10),
  note: z.string().nullable().optional(),
});

export type PageSearchAnswer = z.infer<typeof answerSchema>;

/** Every result URL the turn's searches returned. An errored search block holds no list. */
export function searchResultUrls(content: readonly Anthropic.ContentBlock[]): string[] {
  const urls: string[] = [];
  for (const block of content) {
    if (block.type !== 'web_search_tool_result' || !Array.isArray(block.content)) continue;
    for (const result of block.content) urls.push(result.url);
  }
  return urls;
}

/** The JSON object the turn ended on, or null. Only text written after the last search
 * result counts: notes written mid-search are not the answer. */
export function readPageSearchAnswer(
  content: readonly Anthropic.ContentBlock[],
): PageSearchAnswer | null {
  const lastResult = content.findLastIndex((block) => block.type === 'web_search_tool_result');
  const text = content
    .slice(lastResult + 1)
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end < start) return null;
  let value: unknown;
  try {
    value = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const parsed = answerSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function normalizedUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function folded(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** The municipality the search named is the family's own city: its name holds the
 * table's city name as whole words ("City of Greater Sudbury" holds "Greater Sudbury").
 * Anything else is a neighbouring town's page, which is worse than no page. */
export function namesThisPlace(municipality: string, city: string): boolean {
  const words = ` ${folded(municipality).replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
  const name = folded(city)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  return name !== '' && words.includes(` ${name} `);
}

/** The pages to read: https, returned by a search this turn, distinct, best first. */
export function pagesToRead(answer: PageSearchAnswer, resultUrls: readonly string[]): string[] {
  const returned = new Set(resultUrls.map(normalizedUrl).filter((url) => url !== null));
  const pages: string[] = [];
  for (const raw of answer.pages) {
    const url = normalizedUrl(raw);
    if (url === null || !returned.has(url) || pages.includes(url)) continue;
    pages.push(url);
    if (pages.length === MAX_CANDIDATE_PAGES) break;
  }
  return pages;
}

function failureName(err: unknown): string {
  return err instanceof Error ? err.constructor.name : 'unknown';
}

/**
 * One search turn, streamed: a turn of several searches can outlast a non-streamed
 * request's wall (server-tool-turns-need-streaming). The skill is loaded outside the
 * catch, so a missing skill is a deploy bug and not "this city has no page".
 */
export async function searchRegistrationPages(
  client: AgentClient,
  place: CityPlace,
  cycleLabel: string,
  today: string,
): Promise<PageSearch> {
  const skill = await loadCronSkill(PAGE_SEARCH_SKILL);
  let research: Anthropic.Message;
  try {
    research = await client.messages
      .stream({
        model: pickModel(skill.meta.task),
        max_tokens: PAGE_SEARCH_MAX_TOKENS,
        system: cachedSystem(skill.instructions),
        tools: [{ name: 'web_search', type: 'web_search_20250305', max_uses: MAX_PAGE_SEARCHES }],
        messages: [{ role: 'user', content: pageSearchUserMessage(place, cycleLabel, today) }],
      })
      .finalMessage();
  } catch (err) {
    return { outcome: 'failed', reason: `search_failed:${failureName(err)}` };
  }
  if (research.stop_reason !== 'end_turn') {
    return { outcome: 'failed', reason: `stopped:${research.stop_reason}` };
  }
  return pageSearchOutcome(research.content, place);
}

/** What a finished search turn found, read with no model involved. */
export function pageSearchOutcome(
  content: readonly Anthropic.ContentBlock[],
  place: CityPlace,
): PageSearch {
  const resultUrls = searchResultUrls(content);
  if (resultUrls.length === 0) return { outcome: 'none', reason: 'no_results' };
  const answer = readPageSearchAnswer(content);
  if (answer === null) return { outcome: 'none', reason: 'unparsed' };
  if (answer.municipality === null) return { outcome: 'none', reason: 'no_official_page' };
  if (!namesThisPlace(answer.municipality, place.city)) {
    return { outcome: 'none', reason: 'not_this_place' };
  }
  const urls = pagesToRead(answer, resultUrls);
  if (urls.length === 0) return { outcome: 'none', reason: 'no_official_page' };
  return { outcome: 'pages', municipality: answer.municipality, urls };
}
