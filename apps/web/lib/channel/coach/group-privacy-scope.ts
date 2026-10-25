import type { AgentContext } from '~/lib/coach/context';
import { unavailableMemoryBrief } from '~/lib/memory/brief';

/**
 * VIL-439 (T18) — the group privacy rule, enforced in code before the model runs.
 *
 * Everyone in a group reads every group line. So a group turn may use only what was
 * said in this chat plus what the household already shares there (kids' names and
 * ages, public registration dates). Nothing private reaches the prompt: memory facts
 * and episodes (built from 1:1 texts and inboxes), the memory brief, the note a 1:1
 * reply grounds on, and the family's provider watch. A thing that is not in the
 * prompt cannot be quoted; the skill's rule is the second line, not the only one.
 *
 * Applied to every group turn, with no flag: the router marks a turn `group` whenever
 * the door saw the message in a group chat (`job.in_group`). 1:1 turns are never touched.
 */
/** The field names withheld from a group turn, for the audit line and tests. */
export const GROUP_WITHHELD = [
  'memoryFacts',
  'recentEpisodes',
  'memoryBrief',
  'sourceNote',
  'providerWatch',
] as const;

export function groupScopedContext<T extends AgentContext>(context: T): T {
  const { providerWatch: _withheld, ...rest } = context as T & { providerWatch?: unknown };
  return {
    ...(rest as T),
    memoryFacts: [],
    recentEpisodes: [],
    memoryBrief: unavailableMemoryBrief(),
    sourceNote: null,
  };
}

/**
 * VIL-439 (T18) 2/2 — what `lookup_week` may show a group.
 *
 * A family event Hale holds (it has an `eventId`) is the household's own plan and stays.
 * Anything read from a connected calendar becomes a busy block: no title, even a
 * kid-related one, because the block came from one parent's private calendar. Mail is
 * never quoted in a group, so mail items are dropped; the sync status stays so the model
 * doesn't claim it has no access.
 */
type WeekEntry = { kind: string; [key: string]: unknown };
type WeekResult = {
  events: WeekEntry[];
  mail: { items: unknown[]; [key: string]: unknown };
  [key: string]: unknown;
};

export function groupSafeWeek<T extends WeekResult>(week: T): T {
  return {
    ...week,
    events: week.events.map((entry) =>
      entry.kind === 'calendar'
        ? { kind: 'busy', when: entry.when, until: entry.until, allDay: entry.allDay }
        : entry,
    ),
    mail: { ...week.mail, items: [], processedCount: null, since: null },
  };
}

type HandlerTool = { name: string; handler: (...args: never[]) => unknown };

/**
 * Tools a group turn never gets: they read or act on one parent's private inbox,
 * memory, 1:1 history, or provider watch list.
 */
export const GROUP_WITHHELD_TOOLS: ReadonlySet<string> = new Set([
  'prepare_gmail_draft',
  'read_recent_memory',
  'read_recent_conversations',
  'list_watch_targets',
  'add_watch_target',
  'remove_watch_target',
]);

/** The group tool set: private tools dropped, `lookup_week` wrapped in {@link groupSafeWeek}. */
export function groupScopedTools<T extends HandlerTool>(tools: T[]): T[] {
  return tools
    .filter((tool) => !GROUP_WITHHELD_TOOLS.has(tool.name))
    .map((tool) => {
      if (tool.name !== 'lookup_week') return tool;
      const inner = tool.handler as (...args: unknown[]) => Promise<WeekResult>;
      return {
        ...tool,
        handler: async (...args: unknown[]) => groupSafeWeek(await inner(...args)),
      } as T;
    });
}
