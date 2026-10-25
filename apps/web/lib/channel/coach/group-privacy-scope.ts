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
 * Applied only when `GROUP_PRIVACY_SCOPE_ENABLED` is exactly `true` (default off),
 * because dropping these fields changes the group turn's prompt bytes and needs a
 * priced eval re-record before it goes live. 1:1 turns are never touched.
 */
export function groupPrivacyScopeEnabled(): boolean {
  return process.env.GROUP_PRIVACY_SCOPE_ENABLED?.trim() === 'true';
}

/** The field names withheld from a group turn, for the audit line and tests. */
export const GROUP_WITHHELD = [
  'memoryFacts',
  'recentEpisodes',
  'memoryBrief',
  'sourceNote',
  'providerWatch',
] as const;

export function groupScopedContext<T extends AgentContext>(context: T): T {
  const scoped: T = {
    ...context,
    memoryFacts: [],
    recentEpisodes: [],
    memoryBrief: unavailableMemoryBrief(),
    sourceNote: null,
  };
  delete (scoped as { providerWatch?: unknown }).providerWatch;
  return scoped;
}
