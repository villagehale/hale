import type Anthropic from '@anthropic-ai/sdk';
import { type AgentClient, cachedSystem, pickModel } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { onOfficialHost } from './host';

/**
 * VIL-685 · find the calendar page a board publishes its school year on, by live search
 * restricted to the board's own host.
 *
 * The search is told one host — the domain the family's school mail comes from — and the
 * web search tool is limited to it (`allowed_domains`), so nothing off that host can be
 * returned. The model only FINDS pages; the break is read off each page afterwards and
 * checked by code (read.ts). A URL the model wrote that no result carried is dropped.
 *
 * What crosses the border to the US search (rule #1) is a public host and a school year.
 * Nothing about a family, and no place: the host already names the board.
 */

export const SCHOOL_CALENDAR_SEARCH_SKILL = 'school-calendar-search';
/** An infra bound on one search turn's searches, not a send rule. */
export const MAX_CALENDAR_SEARCHES = 3;
/** The pages one lookup may read. */
export const MAX_CALENDAR_PAGES = 3;
export const CALENDAR_SEARCH_MAX_TOKENS = 1536;

export type CalendarSearch =
  | { outcome: 'pages'; boardName: string; urls: string[] }
  /** The search ran and found no calendar page on this host. */
  | { outcome: 'none'; reason: 'no_results' | 'no_calendar_page' | 'unparsed' }
  /** The search did not finish: try again later. Says nothing about the board. */
  | { outcome: 'failed'; reason: string };

export function calendarSearchUserMessage(officialHost: string, schoolYear: string): string {
  return JSON.stringify({ host: officialHost, school_year: schoolYear });
}

const answerSchema = z.object({
  board: z.string().min(1).nullable(),
  pages: z.array(z.string()).max(10),
});

type CalendarSearchAnswer = z.infer<typeof answerSchema>;

export function searchResultUrls(content: readonly Anthropic.ContentBlock[]): string[] {
  const urls: string[] = [];
  for (const block of content) {
    if (block.type !== 'web_search_tool_result' || !Array.isArray(block.content)) continue;
    for (const result of block.content) urls.push(result.url);
  }
  return urls;
}

/** The JSON object the turn ended on, written after the last search result, or null. */
export function readCalendarSearchAnswer(
  content: readonly Anthropic.ContentBlock[],
): CalendarSearchAnswer | null {
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

/** What a finished search turn found, read with no model involved. */
export function calendarSearchOutcome(
  content: readonly Anthropic.ContentBlock[],
  officialHost: string,
): CalendarSearch {
  const returned = new Set(
    searchResultUrls(content)
      .map(normalizedUrl)
      .filter((url): url is string => url !== null),
  );
  if (returned.size === 0) return { outcome: 'none', reason: 'no_results' };
  const answer = readCalendarSearchAnswer(content);
  if (answer === null) return { outcome: 'none', reason: 'unparsed' };
  if (answer.board === null) return { outcome: 'none', reason: 'no_calendar_page' };
  const urls: string[] = [];
  for (const raw of answer.pages) {
    const url = normalizedUrl(raw);
    if (url === null || !returned.has(url) || urls.includes(url)) continue;
    if (!onOfficialHost(url, officialHost)) continue;
    urls.push(url);
    if (urls.length === MAX_CALENDAR_PAGES) break;
  }
  if (urls.length === 0) return { outcome: 'none', reason: 'no_calendar_page' };
  return { outcome: 'pages', boardName: answer.board.slice(0, 120), urls };
}

function failureName(err: unknown): string {
  return err instanceof Error ? err.constructor.name : 'unknown';
}

/** One search turn, streamed (a turn of several searches can outlast a non-streamed
 * request's wall). */
export async function searchSchoolCalendar(
  client: AgentClient,
  officialHost: string,
  schoolYear: string,
): Promise<CalendarSearch> {
  const skill = await loadCronSkill(SCHOOL_CALENDAR_SEARCH_SKILL);
  let research: Anthropic.Message;
  try {
    research = await client.messages
      .stream({
        model: pickModel(skill.meta.task),
        max_tokens: CALENDAR_SEARCH_MAX_TOKENS,
        system: cachedSystem(skill.instructions),
        tools: [
          {
            name: 'web_search',
            type: 'web_search_20250305',
            max_uses: MAX_CALENDAR_SEARCHES,
            allowed_domains: [officialHost],
          },
        ],
        messages: [{ role: 'user', content: calendarSearchUserMessage(officialHost, schoolYear) }],
      })
      .finalMessage();
  } catch (err) {
    return { outcome: 'failed', reason: `search_failed:${failureName(err)}` };
  }
  if (research.stop_reason !== 'end_turn') {
    return { outcome: 'failed', reason: `stopped:${research.stop_reason}` };
  }
  return calendarSearchOutcome(research.content, officialHost);
}
